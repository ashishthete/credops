import { useSyncExternalStore } from 'react'
import {
  MAX_EVENTS_PAGE,
  type PreflightCheck,
  type PreflightReport,
  type ReleaseSummary,
  type RunEvent as DeployRunEvent,
} from '../../../shared/deploy'
import { api } from '../lib/api'
import { fail } from '../ui/common'
import { createStore } from '../ui/store'
import { LogBuffer } from './log-buffer'
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
  /** Per environment, the releases read so far from `release:list`, newest first. */
  history: Record<string, HistoryPage>
}

export interface HistoryPage {
  releases: ReleaseSummary[]
  /** Another page may follow. */
  more: boolean
  loading: boolean
}

/** Releases per `release:list` page. */
export const HISTORY_PAGE = 20

const EMPTY: ReleasesState = { byId: {}, active: [], pipelines: {}, preflight: {}, history: {} }
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
/** Releases between openRelease and closeRelease. */
const open = new Set<string>()
/** Views holding a release open through retainRelease. */
const holds = new Map<string, number>()
const buffers = new Map<string, LogBuffer>()
/** Per open release, bumped by each batch of log lines, so a view of the buffer re-renders. */
const logVersions = createStore<Record<string, number>>({})
/**
 * Releases this window asked to cancel: both release pages show them as cancelling while they still run. The store
 * clears one when its release finishes (a `run.finished` event, or a state push that is no longer running), so
 * it does not matter which page, if any, is open then.
 */
const cancels = createStore<Record<string, true>>({})
let syncUsers = 0
let stopSync: (() => void) | null = null

export function resetReleases(): void {
  generation++
  opens.clear()
  queued.clear()
  seen.clear()
  fetching.clear()
  logListeners.clear()
  open.clear()
  holds.clear()
  buffers.clear()
  logVersions.set({})
  cancels.set({})
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
  // The events the reducer moved past, each seq once (a batch can repeat one).
  const taken = new Set<number>()
  const applied: DeployRunEvent[] = []
  for (const e of batch) {
    if (e.seq <= prev.lastSeq || e.seq > next.lastSeq || taken.has(e.seq)) continue
    taken.add(e.seq)
    applied.push(e)
  }
  let pre = s.preflight[id]
  for (const e of applied) {
    if (e.type === 'preflight.check') pre = { ...pre, checks: [...pre.checks.filter((c) => !sameCheck(c, e.check)), e.check] }
    else if (e.type === 'preflight.done') pre = { ...pre, report: e.report }
  }
  if (next.result) markCancelling(id, false)
  if (next !== prev || pre !== s.preflight[id]) {
    releaseStore.set({ ...s, pipelines: { ...s.pipelines, [id]: next }, preflight: { ...s.preflight, [id]: pre } })
  }
  const logs = applied.filter((e) => e.type === 'log' || e.type === 'log.truncated')
  if (logs.length) {
    const buffer = buffers.get(id)
    if (buffer) {
      buffer.push(logs)
      const v = logVersions.get()
      logVersions.set({ ...v, [id]: buffer.version })
    }
    logListeners.get(id)?.forEach((fn) => fn(logs))
  }
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
  open.add(id)
  queued.set(id, [])
  // A catch-up from an earlier open stops at its next read; this open may start its own.
  fetching.delete(id)
  // Events replay from seq 1, so the log starts over too.
  buffers.set(id, new LogBuffer())
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
  open.delete(id)
  holds.delete(id)
  buffers.delete(id)
  const { [id]: _v, ...versions } = logVersions.get()
  logVersions.set(versions)
  const s = releaseStore.get()
  const { [id]: _p, ...pipelines } = s.pipelines
  const { [id]: _f, ...preflight } = s.preflight
  releaseStore.set({ ...s, pipelines, preflight })
}

/**
 * Keeps a release open while a view shows it: the first holder opens it unless it is open already (the wizard
 * opens its release at preflight), and the last one to leave closes it.
 */
export function retainRelease(id: string): () => void {
  const n = holds.get(id) ?? 0
  holds.set(id, n + 1)
  if (n === 0 && !open.has(id)) void openRelease(id).catch(() => {})
  let left = false
  return () => {
    if (left) return
    left = true
    const k = (holds.get(id) ?? 1) - 1
    if (k > 0) holds.set(id, k)
    else closeRelease(id)
  }
}

/** The open release's log and a number that changes with every batch; undefined while it isn't open. */
export function useReleaseLog(id: string | null): { buffer: LogBuffer | undefined; version: number } {
  const version = useSyncExternalStore(logVersions.subscribe, () => (id ? (logVersions.get()[id] ?? 0) : 0))
  return { buffer: id ? buffers.get(id) : undefined, version }
}

/** Reads the first page of an environment's history, or with `more` the page after the last one read. */
export async function loadHistory(envId: string, more = false): Promise<void> {
  const gen = generation
  const had = releaseStore.get().history[envId]
  if (had?.loading || (more && !had?.more)) return
  const before = more ? had?.releases.at(-1)?.id : undefined
  const mark = (page: HistoryPage) => {
    const s = releaseStore.get()
    releaseStore.set({ ...s, history: { ...s.history, [envId]: page } })
  }
  mark({ releases: had?.releases ?? [], more: had?.more ?? false, loading: true })
  try {
    const page = (await api.invoke('release:list', { environmentId: envId, limit: HISTORY_PAGE, ...(before ? { before } : {}) })) ?? []
    if (gen !== generation) return
    const prev = more ? (releaseStore.get().history[envId]?.releases ?? []) : []
    const ids = new Set(page.map((r) => r.id))
    const s = releaseStore.get()
    const byId = { ...s.byId }
    // release:state keeps a summary already held up to date.
    for (const r of page) byId[r.id] ??= r
    releaseStore.set({
      ...s,
      byId,
      history: { ...s.history, [envId]: { releases: [...prev.filter((r) => !ids.has(r.id)), ...page], more: page.length === HISTORY_PAGE, loading: false } },
    })
  } catch (err) {
    if (gen !== generation) return
    mark({ ...(releaseStore.get().history[envId] ?? { releases: [], more: false }), loading: false })
    fail("Couldn't load the release history", err)
  }
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
    if (!open.has(id)) continue
    seen.set(id, Math.max(seen.get(id) ?? 0, ...events.map((e) => e.seq)))
    const q = queued.get(id)
    if (q) q.push(...events)
    else ingest(id, events)
  }
}

function onState(summary: ReleaseSummary): void {
  if (!ACTIVE.has(summary.status)) markCancelling(summary.id, false)
  const s = releaseStore.get()
  const on = ACTIVE.has(summary.status)
  const has = s.active.includes(summary.id)
  const active = on && !has ? [...s.active, summary.id] : !on && has ? s.active.filter((x) => x !== summary.id) : s.active
  const page = s.history[summary.environmentId]
  const history = page
    ? {
        ...s.history,
        [summary.environmentId]: {
          ...page,
          releases: page.releases.some((r) => r.id === summary.id)
            ? page.releases.map((r) => (r.id === summary.id ? summary : r))
            : summary.status === 'preflight' || summary.status === 'ready' || summary.status === 'blocked' || summary.status === 'discarded'
              ? page.releases
              : [summary, ...page.releases],
        },
      }
    : s.history
  releaseStore.set({ ...s, byId: { ...s.byId, [summary.id]: summary }, active, history })
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

/** A cancel of the release was sent from this window (`release:cancel` succeeded); cleared when it finishes. */
export function markCancelling(id: string, on: boolean): void {
  if (isCancelling(id) === on) return
  // The cancel's reply can come after the release already finished: then there is nothing left to cancel.
  const s = releaseStore.get()
  const status = s.byId[id]?.status
  if (on && (s.pipelines[id]?.result || (status !== undefined && !ACTIVE.has(status)))) return
  const { [id]: _was, ...rest } = cancels.get()
  cancels.set(on ? { ...rest, [id]: true } : rest)
}

export function isCancelling(id: string): boolean {
  return cancels.get()[id] === true
}

export function useCancelling(id: string): boolean {
  return useSyncExternalStore(cancels.subscribe, () => cancels.get()[id] === true)
}

export function usePipeline(id: string | null): PipelineState | undefined {
  return useSyncExternalStore(releaseStore.subscribe, () => (id ? releaseStore.get().pipelines[id] : undefined))
}

export function usePreflight(id: string | null): PreflightView | undefined {
  return useSyncExternalStore(releaseStore.subscribe, () => (id ? releaseStore.get().preflight[id] : undefined))
}
