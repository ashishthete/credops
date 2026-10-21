import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BREAK_LOCK_CONFIRM_MESSAGE, type StepKind } from '../../../../../shared/deploy'
import { etaMs, type ChipState, type PipelineState } from '../../../deploy/pipeline'
import type { LogFilter } from '../../../deploy/log-buffer'
import { loadHistory, releaseStore, retainRelease, startReleaseSync, usePipeline } from '../../../deploy/releases'
import { api } from '../../../lib/api'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { attempt, ConfirmDialog, type ConfirmRequest } from '../../../ui/common'
import { Dialog } from '../../../ui/Dialog'
import { Celebrate } from './Celebrate'
import { FailurePanel } from './FailurePanel'
import { LiveLog } from './LiveLog'
import { Pipeline } from './Pipeline'
import { canRollback, duration, STATUS_TONE, STATUS_WORD, useRollback } from './ReleaseHistory'
import { clock, useNow } from './StepChip'

const CANCEL_MESSAGE = 'Cancel the release? Running steps are stopped and the lock is released.'
/** Past releases whose step times feed the ETA. */
const ETA_SAMPLES = 3

type StepHistory = Partial<Record<StepKind, number[]>>

/** Step durations of the environment's last few succeeded releases, read once while this one runs. */
function useStepHistory(envId: string | undefined, releaseId: string, on: boolean): StepHistory {
  const [history, setHistory] = useState<StepHistory>({})
  useEffect(() => {
    if (!envId || !on) return
    let live = true
    void (async () => {
      const list = (await api.invoke('release:list', { environmentId: envId, limit: 10 }).catch(() => null)) ?? []
      const past = list.filter((r) => r.id !== releaseId && r.status === 'succeeded').slice(0, ETA_SAMPLES)
      const details = await Promise.all(past.map((r) => api.invoke('release:get', r.id).catch(() => null)))
      const out: StepHistory = {}
      for (const d of details) {
        for (const run of d?.runs ?? []) {
          for (const s of run.steps) {
            if (s.state !== 'ok' || !s.startedAt || !s.finishedAt) continue
            ;(out[s.kind] ??= []).push(Date.parse(s.finishedAt) - Date.parse(s.startedAt))
          }
        }
      }
      if (live) setHistory(out)
    })()
    return () => {
      live = false
    }
  }, [envId, releaseId, on])
  return history
}

/** Every chip with the label of the host it runs on (null for release-wide steps). */
function allChips(state: PipelineState): { chip: ChipState; host: string | null }[] {
  const out: { chip: ChipState; host: string | null }[] = []
  for (const lane of state.lanes) {
    if (lane.lock) out.push({ chip: lane.lock, host: lane.hostLabel })
    for (const run of lane.runs) for (const chip of run.chips) out.push({ chip, host: lane.hostLabel })
    if (lane.unlock) out.push({ chip: lane.unlock, host: lane.hostLabel })
  }
  for (const chip of state.release) out.push({ chip, host: null })
  return out
}

const ANNOUNCE: Partial<Record<ChipState['state'], string>> = { running: 'started', failed: 'failed', warn: 'finished with a warning', rolled_back: 'rolled back' }

/** Words for step changes seen while the release runs, and for its result; a replayed history says nothing. */
function useAnnouncer(state: PipelineState | undefined): string {
  const [message, setMessage] = useState('')
  const prev = useRef<Map<string, ChipState['state']> | null>(null)
  const prevStatus = useRef<string | null>(null)
  useEffect(() => {
    if (!state) return
    const now = new Map(allChips(state).map(({ chip }) => [chip.stepId, chip.state]))
    const watching = prevStatus.current === 'running' || prevStatus.current === 'rolling_back'
    if (prev.current && watching) {
      const said: string[] = []
      for (const { chip, host } of allChips(state)) {
        const word = ANNOUNCE[chip.state]
        if (word && prev.current.get(chip.stepId) !== chip.state) said.push(`${chip.label}${host ? ` on ${host}` : ''} ${word}`)
      }
      if (state.result) said.push(`Release ${STATUS_WORD[state.status]}`)
      if (said.length) setMessage(said.join('. '))
    }
    prev.current = now
    prevStatus.current = state.status
  }, [state])
  return message
}

/** A release as it runs or ran: the header, the pipeline, any failure and the log. */
export function ReleaseView({ releaseId }: { releaseId: string }) {
  const summary = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().byId[releaseId])
  const history = useSyncExternalStore(releaseStore.subscribe, () => (summary ? releaseStore.get().history[summary.environmentId] : undefined))
  const state = usePipeline(releaseId)
  const [filter, setFilter] = useState<LogFilter>({})
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [playbook, setPlaybook] = useState<string | null>(null)
  const rollback = useRollback()
  const sawRunning = useRef(false)

  useEffect(() => startReleaseSync(), [])
  useEffect(() => retainRelease(releaseId), [releaseId])

  const status = state?.status ?? summary?.status
  const running = status === 'running' || status === 'rolling_back'
  // Only a pipeline seen running here celebrates; one that opens already finished does not.
  if (state?.status === 'running') sawRunning.current = true
  const finished = !!state?.result || (!!status && !running && status !== 'preflight' && status !== 'ready' && status !== 'blocked')
  const envId = summary?.environmentId
  useEffect(() => {
    if (envId && finished && !releaseStore.get().history[envId]) void loadHistory(envId)
  }, [envId, finished])
  useEffect(() => {
    if (state?.result) setCancelling(false)
  }, [state?.result])

  const now = useNow(running)
  const steps = useStepHistory(envId, releaseId, running)
  const message = useAnnouncer(state)

  if (!summary || !state) return <p className="text-[12.5px] text-muted">Loading the release</p>

  const elapsed = duration(summary, now)
  const eta = running ? etaMs(state, steps, now) : null
  const chips = allChips(state)
  const failed = chips.filter(({ chip }) => chip.state === 'failed')
  const versionOnly = state.result?.status === 'failed' && failed.length > 0 && failed.every(({ chip }) => chip.stepId === 'release:version')
  const hostLabel = (id: string) => state.lanes.find((l) => l.hostId === id)?.hostLabel ?? id
  const version = state.version.to ? (state.version.from ? `${state.version.from} → ${state.version.to}` : state.version.to) : null

  const cancel = () =>
    setConfirm({
      title: 'Cancel the release?',
      description: CANCEL_MESSAGE,
      confirmLabel: 'Cancel release',
      gentle: { cancelLabel: 'Keep running' },
      run: async () => {
        const ok = await attempt("Couldn't cancel the release", async () => {
          await api.invoke('release:cancel', releaseId)
          return true
        })
        if (ok) setCancelling(true)
      },
    })

  const breakLock = (hostId: string) => {
    const label = hostLabel(hostId)
    setConfirm({
      title: `Break the lock on ${label}?`,
      description: `${BREAK_LOCK_CONFIRM_MESSAGE}. Another release may still be running there.`,
      confirmLabel: 'Break lock',
      typeToConfirm: label,
      run: () => attempt("Couldn't break the lock", () => api.invoke('release:break-lock', releaseId, hostId, { typedLabel: label })),
    })
  }

  const retryTagging = () => void attempt("Couldn't retry tagging", () => api.invoke('release:retry-version', releaseId))
  const viewPlaybook = async () => {
    const detail = await attempt("Couldn't read the release", () => api.invoke('release:get', releaseId))
    if (detail) setPlaybook(detail.playbook ?? 'No playbook was stored for this release')
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <header className="relative flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg">{summary.environmentName}</span>
        {version && <span className="font-mono text-[12.5px] text-fg/85 tabular-nums">{version}</span>}
        <Badge tone={STATUS_TONE[state.status]} dot>
          {cancelling && running ? 'cancelling' : STATUS_WORD[state.status]}
        </Badge>
        {elapsed && <span className="font-mono text-[12px] text-muted tabular-nums">{elapsed}</span>}
        {eta !== null && <span className="text-[12px] text-muted">{`about ${clock(eta)} left`}</span>}
        {state.status === 'succeeded' && sawRunning.current && <Celebrate key="done" />}
        <span className="ml-auto flex items-center gap-1.5">
          {/* Main lets a rollback finish once it has begun, so a cancel then would do nothing. */}
          {state.status === 'running' && (
            <Button size="sm" variant="ghost" disabled={cancelling} onClick={cancel}>
              Cancel
            </Button>
          )}
          {versionOnly && (
            <Button size="sm" variant="ghost" onClick={retryTagging}>
              Retry tagging
            </Button>
          )}
          {history && canRollback(summary, history.releases) && (
            <Button size="sm" variant="ghost" onClick={() => void rollback.begin(summary)}>
              Rollback
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void viewPlaybook()}>
            View playbook
          </Button>
        </span>
      </header>

      {state.lockBusy.map((b) => (
        <div key={b.hostId} role="status" className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/8 px-3 py-2">
          <span className="flex-1 text-[12.5px] text-fg/90">{b.text}</span>
          {b.stale && (
            <Button size="sm" variant="ghost" onClick={() => breakLock(b.hostId)}>
              Break lock
            </Button>
          )}
        </div>
      ))}

      <Pipeline
        state={state}
        selected={filter.stepId ?? null}
        cancelling={cancelling && running}
        onSelect={(stepId) => setFilter((f) => ({ ...f, stepId }))}
      />

      {failed.map(({ chip, host }) => (
        <FailurePanel key={chip.stepId} releaseId={releaseId} chip={chip} host={host} />
      ))}
      {state.result?.error && !failed.length && (
        <p role="alert" className="text-[12.5px] text-err">
          {state.result.error}
        </p>
      )}

      <LiveLog releaseId={releaseId} filter={filter} onFilterChange={setFilter} />

      <p aria-live="polite" role="status" className="sr-only">
        {message}
      </p>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ConfirmDialog request={rollback.request} onClose={rollback.close} />
      <Dialog open={playbook !== null} onClose={() => setPlaybook(null)} title="Release playbook" width={680}>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-canvas/70 p-3 font-mono text-[11.5px] whitespace-pre text-fg/90">{playbook}</pre>
      </Dialog>
    </div>
  )
}

