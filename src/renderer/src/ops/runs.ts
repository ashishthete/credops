import { useSyncExternalStore } from 'react'
import { MAX_ERR_RANGES, RUN_OUTPUT_CHARS, type RunEvent, type RunHostMeta, type RunOutput, type RunSummary } from '../../../shared/ops'
import { api } from '../lib/api'
import { fail } from '../ui/common'
import { createStore } from '../ui/store'
import { resetContainers, applyContainerLog } from './containers'
import { resetSnippets } from './snippets'

export interface RunsState {
  runs: RunSummary[]
  selectedId: string | null
}

/** A host's buffered text; `errRanges` are [start, end) offsets into it where stderr wrote. */
export type HostOutput = Omit<RunOutput, 'hostId'>
// `total` is the host's chars ever appended that this text has applied; events at or below it are duplicates.

const EMPTY: RunsState = { runs: [], selectedId: null }

export const runStore = createStore<RunsState>(EMPTY)
/**
 * Separate from `runStore`: output chunks arrive many times a second and must only touch the pane that shows them.
 * Holds output for the selected run and the active ones only; a selected run is reloaded with `runs:get`.
 */
export const runOutputStore = createStore<Record<string, Record<string, HostOutput>>>({})

/** Bumped by resetOps; a load that started before it must not repopulate the stores. */
let generation = 0
/** The latest load per run: a reply from a superseded load is ignored. */
const loads = new Map<string, number>()
let loadSeq = 0
/** Runs that saw a gap while a load was in flight; that load is followed by another. */
const reloadAgain = new Set<string>()
let syncUsers = 0
let stopSync: (() => void) | null = null

/** Empties every Ops store (the shell unmounting, the vault locking, tests). */
export function resetOps(): void {
  generation++
  loads.clear()
  reloadAgain.clear()
  runStore.set(EMPTY)
  runOutputStore.set({})
  resetContainers()
  resetSnippets()
}

/**
 * Appends a chunk to a host's text, trimming from the front past `RUN_OUTPUT_CHARS`. Stderr ranges
 * shift with the trim, are clipped to what is left, and merge (oldest two) past `MAX_ERR_RANGES`.
 */
export function appendOutput(prev: HostOutput | undefined, chunk: string, err: boolean): HostOutput {
  let text = (prev?.text ?? '') + chunk
  let ranges = prev?.errRanges ?? []
  if (err && chunk) {
    const start = text.length - chunk.length
    const last = ranges[ranges.length - 1]
    ranges = last && last[1] === start ? [...ranges.slice(0, -1), [last[0], text.length]] : [...ranges, [start, text.length]]
  }
  const cut = text.length - RUN_OUTPUT_CHARS
  if (cut > 0) {
    text = text.slice(cut)
    ranges = ranges.map((r): [number, number] => [Math.max(0, r[0] - cut), r[1] - cut]).filter((r) => r[1] > r[0])
  }
  while (ranges.length > MAX_ERR_RANGES) ranges = [[ranges[0][0], ranges[1][1]], ...ranges.slice(2)]
  return { text, errRanges: ranges, total: (prev?.total ?? 0) + chunk.length }
}

function dropOutput(runId: string): void {
  const all = runOutputStore.get()
  if (!(runId in all)) return
  const { [runId]: _gone, ...rest } = all
  runOutputStore.set(rest)
}

function upsertRun(run: RunSummary): void {
  const s = runStore.get()
  const known = s.runs.some((r) => r.id === run.id)
  runStore.set({ ...s, runs: known ? s.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...s.runs] })
  if (run.state !== 'running' && s.selectedId !== run.id) dropOutput(run.id)
}

function applyHost(runId: string, host: RunHostMeta): void {
  const s = runStore.get()
  // A host event for a run we haven't seen yet is followed by its run event.
  if (!s.runs.some((r) => r.id === runId)) return
  runStore.set({
    ...s,
    runs: s.runs.map((r) => {
      if (r.id !== runId) return r
      const known = r.hosts.some((h) => h.hostId === host.hostId)
      return { ...r, hosts: known ? r.hosts.map((h) => (h.hostId === host.hostId ? host : h)) : [...r.hosts, host] }
    }),
  })
}

function applyOutput(runId: string, hostId: string, chunk: string, err: boolean, end: number): void {
  const { runs, selectedId } = runStore.get()
  const run = runs.find((r) => r.id === runId)
  // Output is kept for the selected run and active ones; a run not seen yet is about to be.
  if (run && run.state !== 'running' && selectedId !== runId) return
  const all = runOutputStore.get()
  const hosts = all[runId] ?? {}
  const prev = hosts[hostId]
  const applied = prev?.total ?? 0
  // A snapshot may already hold this chunk, or part of it.
  if (end <= applied) return
  const fresh = end - applied < chunk.length ? chunk.slice(chunk.length - (end - applied)) : chunk
  // Events were missed (this run's output was never loaded, or an event was lost): applying the chunk would
  // leave a hole, so the reload fills it, once more after a load already in flight.
  if (end - chunk.length > applied) {
    if (loads.has(runId)) reloadAgain.add(runId)
    else void loadRun(runId)
    return
  }
  const next = appendOutput(prev, fresh, err)
  runOutputStore.set({ ...all, [runId]: { ...hosts, [hostId]: { ...next, total: end } } })
}

function applyRunEvent(event: RunEvent): void {
  if (event.kind === 'run') upsertRun(event.run)
  else if (event.kind === 'host') applyHost(event.runId, event.host)
  else applyOutput(event.runId, event.hostId, event.chunk, event.stream === 'err', event.end)
}

/** Fills a run from `runs:get`. Output the snapshot already holds is skipped by offset; a failed load loses nothing. */
export async function loadRun(id: string): Promise<void> {
  const started = generation
  const token = ++loadSeq
  loads.set(id, token)
  try {
    const { run, output } = await api.invoke('runs:get', id)
    if (started !== generation || loads.get(id) !== token) return
    loads.delete(id)
    upsertRun(run)
    const { selectedId } = runStore.get()
    if (run.state !== 'running' && selectedId !== id) return
    const all = runOutputStore.get()
    const hosts = { ...all[id] }
    for (const o of output) {
      // Events applied after the snapshot was taken are newer than it.
      if ((hosts[o.hostId]?.total ?? 0) <= o.total) hosts[o.hostId] = { text: o.text, errRanges: o.errRanges, total: o.total }
    }
    runOutputStore.set({ ...all, [id]: hosts })
    if (reloadAgain.delete(id)) void loadRun(id)
  } catch (err) {
    if (loads.get(id) === token) loads.delete(id)
    reloadAgain.delete(id)
    if (started === generation) fail("Couldn't load the run", err)
  }
}

/** Selects a run (or none); the previous selection's output goes unless it is still active. */
export function selectRun(id: string | null): void {
  const s = runStore.get()
  if (s.selectedId === id) return
  runStore.set({ ...s, selectedId: id })
  const prev = s.runs.find((r) => r.id === s.selectedId)
  if (s.selectedId && prev?.state !== 'running') dropOutput(s.selectedId)
  if (id) void loadRun(id)
}

/** Removes a finished run from the list (after `runs:dismiss`). */
export function removeRun(id: string): void {
  const s = runStore.get()
  runStore.set({ runs: s.runs.filter((r) => r.id !== id), selectedId: s.selectedId === id ? null : s.selectedId })
  dropOutput(id)
}

async function loadRuns(): Promise<void> {
  const started = generation
  try {
    const list = await api.invoke('runs:list')
    if (started !== generation || !list) return
    // Events applied since subscribing are newer than the list; a run only the list knows is added.
    const s = runStore.get()
    const mine = new Map(s.runs.map((r) => [r.id, r]))
    const listed = new Set(list.map((r) => r.id))
    runStore.set({ ...s, runs: [...s.runs.filter((r) => !listed.has(r.id)), ...list.map((r) => mine.get(r.id) ?? r)] })
    // A run already going when the shell mounted has output we never saw.
    for (const r of runStore.get().runs) if (r.state === 'running' && !runOutputStore.get()[r.id] && !loads.has(r.id)) void loadRun(r.id)
  } catch (err) {
    fail("Couldn't load your runs", err)
  }
}

function startSync(): () => void {
  const offs = [api.on('run:event', applyRunEvent), api.on('containers:logs', applyContainerLog)]
  void loadRuns()
  return () => offs.forEach((off) => off())
}

/**
 * Subscribes to main's run and container-log pushes and loads the run list; returns the unsubscribe.
 * Idempotent: concurrent callers share one subscription, torn down when the last one leaves.
 */
export function startOpsSync(): () => void {
  if (syncUsers++ === 0) stopSync = startSync()
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

export const runningCount = () => runStore.get().runs.filter((r) => r.state === 'running').length

/** One run, re-rendering only when it changes. */
export function useRun(id: string | null): RunSummary | undefined {
  return useSyncExternalStore(runStore.subscribe, () => (id ? runStore.get().runs.find((r) => r.id === id) : undefined))
}
