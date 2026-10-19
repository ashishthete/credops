import { useSyncExternalStore } from 'react'
import {
  MAX_EVENTS_PAGE,
  type PreflightCheck,
  type PreflightReport,
  type ReleaseSummary,
  type RunEvent as DeployRunEvent,
} from '../../../shared/deploy'
import { api } from '../lib/api'
import { createStore } from '../ui/store'
import { initialPipeline, reducePipeline, type PipelineState } from './pipeline'

export interface PreflightView {
  checks: PreflightCheck[]
  report: PreflightReport | null
}

export interface ReleasesState {
  byId: Record<string, ReleaseSummary>
  /** Running or rolling-back releases, in the order they were first seen. */
  active: string[]
  /** Open releases only: the ones a view called openRelease for. */
  pipelines: Record<string, PipelineState>
  preflight: Record<string, PreflightView>
}

const EMPTY: ReleasesState = { byId: {}, active: [], pipelines: {}, preflight: {} }
const ACTIVE = new Set(['running', 'rolling_back'])

export const releaseStore = createStore<ReleasesState>(EMPTY)

/** Bumped by resetReleases; a read that started before it must not land. */
let generation = 0
/** Per release, bumped by each open and close; a load from an older open is dropped. */
const opens = new Map<string, number>()
/** Live events that arrived while a release was loading, applied once it has. */
const queued = new Map<string, DeployRunEvent[]>()
/** The highest seq seen live per release, so a refetch knows it isn't caught up yet. */
const seen = new Map<string, number>()
const fetching = new Set<string>()
const logListeners = new Map<string, Set<(events: DeployRunEvent[]) => void>>()
let syncUsers = 0
let stopSync: (() => void) | null = null

export function resetReleases(): void {
  generation++
  opens.clear()
  queued.clear()
  seen.clear()
  fetching.clear()
  logListeners.clear()
  releaseStore.set(EMPTY)
}

/** Log lines of an open release, in seq order, including those replayed when it opens. */
export function onLogEvents(releaseId: string, fn: (events: DeployRunEvent[]) => void): () => void {
  let set = logListeners.get(releaseId)
  if (!set) logListeners.set(releaseId, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

/** Applies a batch to an open release; the events the reducer took also feed the checklist and the log. */
function ingest(id: string, batch: DeployRunEvent[]): void {
  const s = releaseStore.get()
  const prev = s.pipelines[id]
  if (!prev || !batch.length) return
  const next = reducePipeline(prev, batch)
  const taken = new Set<number>()
  const applied = batch.filter((e) => e.seq > prev.lastSeq && e.seq <= next.lastSeq && !taken.has(e.seq) && taken.add(e.seq))
  let pre = s.preflight[id]
  for (const e of applied) {
    if (e.type === 'preflight.check') pre = { ...pre, checks: [...pre.checks.filter((c) => !sameCheck(c, e.check)), e.check] }
    else if (e.type === 'preflight.done') pre = { ...pre, report: e.report }
  }
  if (next !== prev || pre !== s.preflight[id]) {
    releaseStore.set({ ...s, pipelines: { ...s.pipelines, [id]: next }, preflight: { ...s.preflight, [id]: pre } })
  }
  const logs = applied.filter((e) => e.type === 'log' || e.type === 'log.truncated')
  if (logs.length) logListeners.get(id)?.forEach((fn) => fn(logs))
  if (next.gap) void catchUp(id)
}

const sameCheck = (a: PreflightCheck, b: PreflightCheck) => a.id === b.id && a.deploymentId === b.deploymentId && a.hostId === b.hostId

/** Pages persisted events from the release's lastSeq until it has every event seen live. */
async function catchUp(id: string): Promise<void> {
  if (fetching.has(id)) return
  fetching.add(id)
  const gen = generation
  const token = opens.get(id)
  const current = () => gen === generation && opens.get(id) === token
  try {
    for (;;) {
      const from = releaseStore.get().pipelines[id]?.lastSeq
      if (from === undefined) return
      const page = await api.invoke('release:events', id, from, MAX_EVENTS_PAGE)
      if (!current()) return
      ingest(id, page)
      const now = releaseStore.get().pipelines[id]
      if (!now) return
      // A short page is the end of what main has, unless a live event past it went missing meanwhile.
      if (page.length < MAX_EVENTS_PAGE && (seen.get(id) ?? 0) <= now.lastSeq) return
      if (!page.length) return
    }
  } catch {
    // The next live event shows the gap again.
  } finally {
    if (current()) fetching.delete(id)
  }
}

/** Loads a release and replays its events from the start, so a reopened release matches a watched one. */
export async function openRelease(id: string): Promise<void> {
  const gen = generation
  const token = (opens.get(id) ?? 0) + 1
  opens.set(id, token)
  queued.set(id, [])
  const current = () => gen === generation && opens.get(id) === token
  try {
    const detail = await api.invoke('release:get', id)
    if (!current()) return
    let s = releaseStore.get()
    releaseStore.set({
      ...s,
      byId: { ...s.byId, [id]: summaryOf(detail) },
      pipelines: { ...s.pipelines, [id]: initialPipeline(detail) },
      preflight: { ...s.preflight, [id]: { checks: [], report: null } },
    })
    for (;;) {
      const after = releaseStore.get().pipelines[id].lastSeq
      const page = await api.invoke('release:events', id, after, MAX_EVENTS_PAGE)
      if (!current()) return
      ingest(id, page)
      if (page.length < MAX_EVENTS_PAGE) break
    }
    const live = queued.get(id) ?? []
    queued.delete(id)
    ingest(id, live)
    s = releaseStore.get()
    const p = s.pipelines[id]
    if (p && (seen.get(id) ?? 0) > p.lastSeq) void catchUp(id)
  } finally {
    if (current()) queued.delete(id)
  }
}

/** Stops tracking a release's pipeline; its summary stays. */
export function closeRelease(id: string): void {
  opens.set(id, (opens.get(id) ?? 0) + 1)
  queued.delete(id)
  seen.delete(id)
  fetching.delete(id)
  logListeners.delete(id)
  const s = releaseStore.get()
  const { [id]: _p, ...pipelines } = s.pipelines
  const { [id]: _f, ...preflight } = s.preflight
  releaseStore.set({ ...s, pipelines, preflight })
}

function summaryOf(d: ReleaseSummary): ReleaseSummary {
  const { options: _o, releaseNotes: _n, playbook: _p, runs: _r, preflight: _f, lastSeq: _l, ...summary } = d as ReleaseSummary & Record<string, unknown>
  return summary as ReleaseSummary
}

function onEvents(batch: DeployRunEvent[]): void {
  const byRun = new Map<string, DeployRunEvent[]>()
  for (const e of batch) {
    const list = byRun.get(e.runId)
    if (list) list.push(e)
    else byRun.set(e.runId, [e])
  }
  for (const [id, events] of byRun) {
    if (!opens.has(id)) continue
    seen.set(id, Math.max(seen.get(id) ?? 0, ...events.map((e) => e.seq)))
    const q = queued.get(id)
    if (q) q.push(...events)
    else ingest(id, events)
  }
}

function onState(summary: ReleaseSummary): void {
  const s = releaseStore.get()
  const on = ACTIVE.has(summary.status)
  const has = s.active.includes(summary.id)
  const active = on && !has ? [...s.active, summary.id] : !on && has ? s.active.filter((x) => x !== summary.id) : s.active
  releaseStore.set({ ...s, byId: { ...s.byId, [summary.id]: summary }, active })
}

/** Follows `deploy:event` and `release:state` while anything needs them; ref-counted. */
export function startReleaseSync(): () => void {
  if (syncUsers++ === 0) {
    const offEvents = api.on('deploy:event', onEvents)
    const offState = api.on('release:state', onState)
    const gen = generation
    void api
      .invoke('release:active')
      .then((list) => {
        if (gen !== generation || !Array.isArray(list)) return
        const s = releaseStore.get()
        const byId = { ...s.byId }
        for (const r of list) byId[r.id] = r
        releaseStore.set({ ...s, byId, active: [...new Set([...list.map((r) => r.id), ...s.active])] })
      })
      .catch(() => {})
    stopSync = () => {
      offEvents()
      offState()
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

export function usePipeline(id: string | null): PipelineState | undefined {
  return useSyncExternalStore(releaseStore.subscribe, () => (id ? releaseStore.get().pipelines[id] : undefined))
}

export function usePreflight(id: string | null): PreflightView | undefined {
  return useSyncExternalStore(releaseStore.subscribe, () => (id ? releaseStore.get().preflight[id] : undefined))
}
