import { useEffect, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { rollbackRun, type ReleaseStatus, type ReleaseSummary } from '../../../../../shared/deploy'
import { listNames } from '../../../../../shared/services'
import { loadHistory, releaseStore, startReleaseSync } from '../../../deploy/releases'
import { deployStore } from '../../../deploy/store'
import { useHub } from '../../../hub/store'
import { inventoryStore } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../../ui/common'
import type { Tone } from '../../../ui/tone'
import { clock } from './StepChip'

export const STATUS_WORD: Record<ReleaseStatus, string> = {
  preflight: 'preflight',
  ready: 'ready',
  blocked: 'blocked',
  running: 'running',
  rolling_back: 'rolling back',
  succeeded: 'succeeded',
  failed: 'failed',
  rolled_back: 'rolled back',
  cancelled: 'cancelled',
  discarded: 'discarded',
}

export const STATUS_TONE: Record<ReleaseStatus, Tone> = {
  preflight: 'info',
  ready: 'info',
  blocked: 'warn',
  running: 'info',
  rolling_back: 'warn',
  succeeded: 'success',
  failed: 'error',
  rolled_back: 'warn',
  cancelled: 'warn',
  discarded: 'info',
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'none')

export const kindWord = (r: ReleaseSummary) => (r.kind === 'rollback' ? 'rollback' : r.redeploy ? 'redeploy' : 'release')

/** Start to finish, or start to now while it runs; null before it starts. */
export function duration(r: ReleaseSummary, now = Date.now()): string | null {
  if (!r.startedAt) return null
  return clock((r.finishedAt ? Date.parse(r.finishedAt) : now) - Date.parse(r.startedAt))
}

/**
 * A finished or cancelled release can be rolled back while it is still the newest started release for every one of
 * its services. `history` is newest first. Main checks the same rule again, and refuses a cancelled release none of
 * whose checkouts started.
 */
export function canRollback(r: ReleaseSummary, history: ReleaseSummary[]): boolean {
  if (r.operation || r.kind !== 'release' || (r.status !== 'succeeded' && r.status !== 'failed' && r.status !== 'cancelled') || !r.serviceIds.length) return false
  return r.serviceIds.every((id) => history.find((x) => x.startedAt !== null && x.serviceIds.includes(id))?.id === r.id)
}

/** Builds the rollback confirm from the release's runs, and navigates to the rollback release once started. */
export function useRollback(): { request: ConfirmRequest | null; begin: (r: ReleaseSummary) => Promise<void>; close: () => void } {
  const navigate = useNavigate()
  const { catalog } = useHub()
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const begin = async (r: ReleaseSummary) => {
    const detail = await attempt("Couldn't read the release", () => api.invoke('release:get', r.id))
    if (!detail) return
    // A Hub environment this machine doesn't hold comes from the team catalog, with the same protected rule.
    const env = inventoryStore.get()?.environments.find((e) => e.id === r.environmentId) ?? catalog.find((c) => c.environment.id === r.environmentId)?.environment
    const history = releaseStore.get().history[r.environmentId]?.releases ?? []
    const newer = history.slice(0, Math.max(0, history.findIndex((x) => x.id === r.id))).filter((x) => x.startedAt !== null)
    const tracked = deployStore.get().services
    const mine = new Set(r.serviceIds)
    const lines: string[] = []
    const notes: string[] = []
    for (const run of [...detail.runs].sort((a, b) => a.position - b.position)) {
      // A cancelled release rolls back only the runs whose checkout started.
      if (detail.status === 'cancelled' && !rollbackRun(detail.status, run)) continue
      for (const svc of run.services) {
        if (!mine.has(svc.id)) continue
        lines.push(`${svc.name} on ${run.hostLabel}: ${short(svc.deployedCommit ?? run.deployedCommit)} → ${short(svc.previousCommit ?? run.previousCommit)}`)
      }
      if (!run.deploymentId) continue
      // A sibling: tracked in the same checkout, not in this release, and deployed by a later one.
      const siblings = tracked.filter(
        (s) => s.kind === 'service' && s.deploymentId === run.deploymentId && !mine.has(s.id) && newer.some((x) => x.serviceIds.includes(s.id)),
      )
      if (siblings.length) {
        notes.push(`Code for ${run.deploymentName} moves back to ${short(run.previousCommit)}; ${listNames(siblings.map((s) => s.name))} keep running their current images.`)
      }
    }
    setRequest({
      title: `Roll back ${r.version ?? 'the release'} in ${r.environmentName}?`,
      description: [...lines, ...notes].join('\n'),
      confirmLabel: 'Roll back',
      ...(env?.protected ? { typeToConfirm: env.name } : {}),
      run: async () => {
        const out = await attempt("Couldn't start the rollback", () =>
          api.invoke('release:rollback', r.id, env?.protected ? { typedName: env.name } : {}),
        )
        if (out) navigate(`/deployments/release/${out.releaseId}`)
      },
    })
  }
  return { request, begin, close: () => setRequest(null) }
}

/** Marks a runbook run, which has no version and is never rolled back. */
export function OperationBadge() {
  return <Badge tone="info">Operation</Badge>
}

const EMPTY: ReleaseSummary[] = []

/** The environment's releases, newest first, paged from `release:list`. */
export function ReleaseHistory({ environmentId }: { environmentId: string }) {
  const navigate = useNavigate()
  const page = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().history[environmentId])
  const all = page?.releases ?? EMPTY
  const [operationsOnly, setOperationsOnly] = useState(false)
  const releases = operationsOnly ? all.filter((r) => r.operation) : all
  const rollback = useRollback()

  useEffect(() => startReleaseSync(), [])
  useEffect(() => void loadHistory(environmentId), [environmentId])

  if (page && !page.loading && !all.length) return <p className="text-[12.5px] text-muted">No releases yet</p>

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input type="checkbox" checked={operationsOnly} onChange={(e) => setOperationsOnly(e.target.checked)} className="size-3.5 rounded accent-(--accent)" />
        Operations only
      </label>
      <ul aria-label="Release history" className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {releases.map((r) => {
          const took = duration(r)
          return (
            <li key={r.id} data-release={r.id} className="flex items-center gap-3 px-3 py-2">
              <button
                type="button"
                onClick={() => navigate(`/deployments/release/${r.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="font-mono text-[12.5px] font-medium text-fg tabular-nums">{r.operation ? r.operation.name : (r.version ?? r.id.slice(0, 8))}</span>
                {r.operation ? <OperationBadge /> : <span className="text-[12px] text-muted">{kindWord(r)}</span>}
                <Badge tone={STATUS_TONE[r.status]} dot>
                  {STATUS_WORD[r.status]}
                </Badge>
                <span className="truncate text-[12px] text-muted">{`triggered by ${r.triggeredBy}`}</span>
                {took && <span className="font-mono text-[11.5px] text-muted tabular-nums">{took}</span>}
                <span className="ml-auto text-[12px] text-muted">{plural(r.serviceCount, 'service')}</span>
              </button>
              {canRollback(r, all) && (
                <Button size="sm" variant="ghost" onClick={() => void rollback.begin(r)}>
                  Rollback
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {operationsOnly && !releases.length && <p className="text-[12.5px] text-muted">No operations in the loaded releases</p>}
      {page?.more && (
        <Button size="sm" variant="ghost" loading={page.loading} onClick={() => void loadHistory(environmentId, true)}>
          Load more
        </Button>
      )}
      <ConfirmDialog request={rollback.request} onClose={rollback.close} />
    </div>
  )
}
