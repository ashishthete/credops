import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { BREAK_LOCK_CONFIRM_MESSAGE, type ReleaseStatus, type StepKind } from '../../../../../shared/deploy'
import { playbookSteps, type PlaybookPlay } from '../../../../../shared/playbook-steps'
import { etaMs, type ChipState, type PipelineState } from '../../../deploy/pipeline'
import { loadHistory, markCancelling, releaseStore, retainRelease, startReleaseSync, useCancelling, usePipeline } from '../../../deploy/releases'
import { allRows, taskProgress, taskRows, type HostRows, type TaskRow } from '../../../deploy/task-rows'
import { api } from '../../../lib/api'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { attempt, ConfirmDialog, type ConfirmRequest } from '../../../ui/common'
import { RegionChip } from '../../../ui/RegionChip'
import { AnsibleSteps } from './AnsibleSteps'
import { Celebrate } from './Celebrate'
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

/**
 * The stored playbook's tasks, for the step list: the ones the release was opened with, else read once the status
 * moves on here (a release opened while ready has no playbook until it starts).
 */
function usePlays(releaseId: string, status: ReleaseStatus | undefined, opened: PlaybookPlay[] | undefined): PlaybookPlay[] {
  const [read, setRead] = useState<PlaybookPlay[]>([])
  const first = useRef<ReleaseStatus | undefined>(undefined)
  const have = !!opened?.length || read.length > 0
  useEffect(() => {
    if (!status) return
    first.current ??= status
    if (have || status === first.current) return
    let live = true
    void (async () => {
      const detail = await api.invoke('release:get', releaseId).catch(() => null)
      if (live && detail?.playbook) setRead(playbookSteps(detail.playbook))
    })()
    return () => {
      live = false
    }
  }, [releaseId, status, have])
  return opened?.length ? opened : read
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

/** Where a row runs, as the step list names it: "Health 2 on app2". */
function rowWhere(row: TaskRow, hosts: HostRows[]): string {
  const host = hosts.find((h) => h.before.includes(row) || h.after.includes(row) || h.runs.some((g) => g.rows.includes(row)))
  return `${row.label}${host ? ` on ${host.hostLabel}` : ''}`
}

/** Tasks finished out of all of them, and the ones running now (none named while a cancel is under way). */
function Progress({ rows, hosts, cancelling }: { rows: TaskRow[]; hosts: HostRows[]; cancelling: boolean }) {
  const { done, total, current } = taskProgress(rows)
  if (!total) return null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-3 text-[12px]">
        <span className="text-fg/90 tabular-nums">{`${done} of ${total} tasks done`}</span>
        {cancelling ? (
          <span className="text-warn">Cancelling</span>
        ) : (
          current.length > 0 && <span className="truncate text-accent">{`Now: ${current.map((r) => rowWhere(r, hosts)).join(', ')}`}</span>
        )}
      </div>
      <div role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    </div>
  )
}

/**
 * A release as it runs or ran: the header, overall progress, the pipeline and its Ansible steps (a failed one
 * opens with its output and the AI help). The playbook and the full log are on its Playbook & logs page.
 */
export function ReleaseView({ releaseId }: { releaseId: string }) {
  const summary = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().byId[releaseId])
  const history = useSyncExternalStore(releaseStore.subscribe, () => (summary ? releaseStore.get().history[summary.environmentId] : undefined))
  const state = usePipeline(releaseId)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const cancelling = useCancelling(releaseId)
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

  const now = useNow(running)
  const steps = useStepHistory(envId, releaseId, running)
  const message = useAnnouncer(state)
  const plays = usePlays(releaseId, status, state?.plays)
  const navigate = useNavigate()
  const logsPath = `/deployments/release/${releaseId}/logs`
  const showLog = useCallback((stepId: string) => navigate(`${logsPath}?step=${encodeURIComponent(stepId)}`), [navigate, logsPath])
  const rows = useMemo(() => (state ? taskRows(state, plays) : null), [state, plays])

  if (!summary || !state) return <p className="text-[12.5px] text-muted">Loading the release</p>

  const elapsed = duration(summary, now)
  const eta = running ? etaMs(state, steps, now) : null
  const chips = allChips(state)
  const failed = chips.filter(({ chip }) => chip.state === 'failed')
  const versionOnly = state.result?.status === 'failed' && failed.length > 0 && failed.every(({ chip }) => chip.stepId === 'release:version')
  const hostLabel = (id: string) => state.lanes.find((l) => l.hostId === id)?.hostLabel ?? id
  const deployments = [...new Set(state.lanes.flatMap((l) => l.runs.map((r) => r.name)))].join(', ')
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
        if (ok) markCancelling(releaseId, true)
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

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <header aria-label="Release summary" className="relative flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg">{summary.environmentName}</span>
        {deployments && <span className="text-[12.5px] text-fg/85">{deployments}</span>}
        {state.regions.map((r) => (
          <RegionChip key={r.id} region={r} emphasis={state.regions.length > 1} />
        ))}
        {version && <span className="font-mono text-[12.5px] text-fg/85 tabular-nums">{version}</span>}
        <Badge tone={STATUS_TONE[state.status]} dot>
          {cancelling && running ? 'cancelling' : STATUS_WORD[state.status]}
        </Badge>
        {elapsed && <span className="font-mono text-[12px] text-muted tabular-nums">{elapsed}</span>}
        {eta !== null && <span className="text-[12px] text-muted">{`about ${clock(eta)} left`}</span>}
        {summary.triggeredBy && <span className="text-[12px] text-muted">{`Started by ${summary.triggeredBy}`}</span>}
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
          <Button size="sm" variant="ghost" onClick={() => navigate(logsPath)}>
            Playbook & logs
          </Button>
        </span>
      </header>

      {rows && <Progress rows={allRows(rows)} hosts={rows.hosts} cancelling={cancelling && running} />}

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
        selected={selected}
        cancelling={cancelling && running}
        onSelect={setSelected}
      />

      {state.result?.error && !failed.length && (
        <p role="alert" className="text-[12.5px] text-err">
          {state.result.error}
        </p>
      )}

      <AnsibleSteps
        releaseId={releaseId}
        state={state}
        plays={plays}
        selected={selected}
        cancelling={cancelling && running}
        onShowLog={showLog}
      />

      <p aria-live="polite" role="status" className="sr-only">
        {message}
      </p>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ConfirmDialog request={rollback.request} onClose={rollback.close} />
    </div>
  )
}

