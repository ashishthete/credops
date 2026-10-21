import { useSyncExternalStore } from 'react'
import type { EnvLastRelease, ReleaseStatus, ReleaseSummary } from '../../../shared/deploy'
import { api } from '../lib/api'
import { createStore } from '../ui/store'

/** Per environment, its newest release that ran (`release:latest`), kept live by `release:state`. */
export const latestStore = createStore<Record<string, EnvLastRelease>>({})

/** A release in one of these never ran, so it is never an environment's last release. */
const NOT_RUN = new Set<ReleaseStatus>(['preflight', 'ready', 'blocked', 'discarded'])
/** A burst of state changes (a release finishing) shares one refetch, which brings its commits. */
const REFETCH_MS = 250

let generation = 0
let syncUsers = 0
let stopSync: (() => void) | null = null

export function resetLatest(): void {
  generation++
  latestStore.set({})
}

async function load(): Promise<void> {
  const started = generation
  try {
    const rows = await api.invoke('release:latest')
    if (started !== generation || !Array.isArray(rows)) return
    // A state that arrived while the read was in flight may be newer than the row read.
    const next: Record<string, EnvLastRelease> = {}
    const now = latestStore.get()
    for (const r of rows) next[r.environmentId] = now[r.environmentId] && now[r.environmentId].id > r.id ? now[r.environmentId] : r
    for (const [env, r] of Object.entries(now)) if (!next[env]) next[env] = r
    latestStore.set(next)
  } catch {
    // The list still renders, with no last release, when this can't be read.
  }
}

function onState(summary: ReleaseSummary): void {
  if (NOT_RUN.has(summary.status)) return
  const s = latestStore.get()
  const was = s[summary.environmentId]
  if (was && was.id > summary.id) return
  const same = was?.id === summary.id
  latestStore.set({
    ...s,
    [summary.environmentId]: { ...summary, previousCommit: same ? was.previousCommit : null, deployedCommit: same ? was.deployedCommit : null },
  })
}

/** Reads every environment's last release and follows `release:state`; ref-counted. Returns the unsubscribe. */
export function startLatestSync(): () => void {
  if (syncUsers++ === 0) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.on('release:state', (summary) => {
      onState(summary)
      timer ??= setTimeout(() => {
        timer = null
        void load()
      }, REFETCH_MS)
    })
    void load()
    stopSync = () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }
  let left = false
  return () => {
    if (left) return
    left = true
    if (--syncUsers === 0) {
      stopSync?.()
      stopSync = null
    }
  }
}

export const useLatestReleases = (): Record<string, EnvLastRelease> => useSyncExternalStore(latestStore.subscribe, latestStore.get)
