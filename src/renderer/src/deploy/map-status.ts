import { useMemo, useSyncExternalStore } from 'react'
import type { ReleaseSummary } from '../../../shared/deploy'
import { releaseStore } from './releases'

export interface HostDeployStatus {
  /** Services an active release in the environment is deploying. */
  running: string[]
  /** Services whose newest known release failed. */
  failed: string[]
  /** An open release is waiting on this host's lock. */
  lockBusy: boolean
  /** Per service, the release a click on its chip opens: the active one, else the newest. */
  releaseOf: Record<string, string>
}

const ACTIVE = new Set(['running', 'rolling_back'])
const SHOWN = new Set(['running', 'rolling_back', 'succeeded', 'failed', 'rolled_back', 'cancelled'])

/** What the map shows on a host placement, from the releases known to `releaseStore`. */
export function useHostDeployStatus(hostId: string, envId: string | null): HostDeployStatus {
  const state = useSyncExternalStore(releaseStore.subscribe, releaseStore.get)
  return useMemo(() => {
    const out: HostDeployStatus = { running: [], failed: [], lockBusy: false, releaseOf: {} }
    if (!envId) return out
    const releases = Object.values(state.byId)
      .filter((r) => r.environmentId === envId && SHOWN.has(r.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const newest = new Map<string, ReleaseSummary>()
    for (const r of releases) for (const id of r.serviceIds) if (!newest.has(id)) newest.set(id, r)
    const running = new Set<string>()
    for (const r of releases) {
      if (!ACTIVE.has(r.status)) continue
      for (const id of r.serviceIds) {
        running.add(id)
        out.releaseOf[id] ??= r.id
      }
    }
    for (const [id, r] of newest) {
      out.releaseOf[id] ??= r.id
      if (!running.has(id) && r.status === 'failed') out.failed.push(id)
    }
    out.running = [...running]
    out.lockBusy = state.active.some((id) => state.pipelines[id]?.lockBusy.some((b) => b.hostId === hostId))
    return out
  }, [state, hostId, envId])
}
