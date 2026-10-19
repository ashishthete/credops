import { useRef, useSyncExternalStore } from 'react'
import {
  SPARK_POINTS,
  type TunnelEvent,
  type TunnelInput,
  type TunnelMeta,
  type TunnelPatch,
  type TunnelRuntime,
  type TunnelStats,
} from '../../../shared/tunnels'
import { api } from '../lib/api'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'
import { toast } from '../ui/Toaster'

export interface TunnelsState {
  tunnels: TunnelMeta[]
  runtime: Record<string, TunnelRuntime>
  loaded: boolean
}

export interface StatsEntry {
  last: TunnelStats
  inSamples: number[]
  outSamples: number[]
}

const EMPTY: TunnelsState = { tunnels: [], runtime: {}, loaded: false }

export const tunnelStore = createStore<TunnelsState>(EMPTY)
/** Separate from `tunnelStore`: a stats tick every second must only touch the cards that show it. */
export const statsStore = createStore<Record<string, StatsEntry>>({})

const eventListeners = new Set<(event: TunnelEvent) => void>()
let syncUsers = 0
let stopSync: (() => void) | null = null

/** Empties both stores (the shell unmounting, tests). */
export function resetTunnels(): void {
  tunnelStore.set(EMPTY)
  statsStore.set({})
}

/**
 * The renderer's only subscription to `tunnel:event`; Phases 6 and 9 hang off it.
 * Events flow while `startTunnelSync` is active. Returns the unsubscribe.
 */
export function onTunnelEvent(fn: (event: TunnelEvent) => void): () => void {
  eventListeners.add(fn)
  return () => {
    eventListeners.delete(fn)
  }
}

function setRuntime(rt: TunnelRuntime): void {
  const s = tunnelStore.get()
  tunnelStore.set({ ...s, runtime: { ...s.runtime, [rt.id]: rt } })
  if (rt.state === 'stopped' && statsStore.get()[rt.id]) {
    const { [rt.id]: _gone, ...rest } = statsStore.get()
    statsStore.set(rest)
  }
}

function pushSample(ring: number[], value: number): number[] {
  const next = [...ring, value]
  return next.length > SPARK_POINTS ? next.slice(next.length - SPARK_POINTS) : next
}

function applyStats(batch: TunnelStats[]): void {
  if (!batch?.length) return
  const next = { ...statsStore.get() }
  for (const st of batch) {
    const prev = next[st.id]
    next[st.id] = {
      last: st,
      inSamples: pushSample(prev?.inSamples ?? [], st.rateIn),
      outSamples: pushSample(prev?.outSamples ?? [], st.rateOut),
    }
  }
  statsStore.set(next)
}

function announce(event: TunnelEvent): void {
  if (event.type === 'failed') {
    toast({ title: event.label, description: event.error.message, tone: 'error' })
  } else if (event.type === 'up' && event.recovered) {
    toast({ title: `${event.label} is back up`, tone: 'success' })
  }
  eventListeners.forEach((fn) => fn(event))
}

/** Loads the saved tunnels and their runtime; runtime pushed by events meanwhile is newer and stays. */
export async function loadTunnels(): Promise<void> {
  try {
    const [list, status] = await Promise.all([api.invoke('tunnel:list'), api.invoke('tunnel:status')])
    const s = tunnelStore.get()
    const runtime = { ...s.runtime }
    for (const rt of status ?? []) if (!runtime[rt.id]) runtime[rt.id] = rt
    tunnelStore.set({ tunnels: list ?? s.tunnels, runtime, loaded: true })
  } catch (err) {
    fail("Couldn't load your tunnels", err)
  }
}

function startSync(): () => void {
  const offs = [
    api.on('tunnel:state', setRuntime),
    api.on('tunnel:stats', applyStats),
    api.on('tunnel:event', announce),
  ]
  void loadTunnels()
  return () => offs.forEach((off) => off())
}

/**
 * Subscribes to main's tunnel pushes and loads the list and status; returns the unsubscribe.
 * Idempotent: concurrent callers share one subscription, torn down when the last one leaves.
 */
export function startTunnelSync(): () => void {
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

export async function createTunnel(input: TunnelInput): Promise<TunnelMeta | undefined> {
  const meta = await attempt("Couldn't create the tunnel", () => api.invoke('tunnel:create', input))
  if (meta) {
    const s = tunnelStore.get()
    tunnelStore.set({ ...s, tunnels: [...s.tunnels.filter((t) => t.id !== meta.id), meta] })
  }
  return meta
}

export async function updateTunnel(id: string, patch: TunnelPatch): Promise<TunnelMeta | undefined> {
  const meta = await attempt("Couldn't save the tunnel", () => api.invoke('tunnel:update', id, patch))
  if (meta) {
    const s = tunnelStore.get()
    tunnelStore.set({ ...s, tunnels: s.tunnels.map((t) => (t.id === id ? meta : t)) })
  }
  return meta
}

export async function deleteTunnel(id: string): Promise<boolean> {
  const done = await attempt("Couldn't delete the tunnel", async () => {
    await api.invoke('tunnel:delete', id)
    return true
  })
  if (!done) return false
  const s = tunnelStore.get()
  const { [id]: _rt, ...runtime } = s.runtime
  tunnelStore.set({ ...s, tunnels: s.tunnels.filter((t) => t.id !== id), runtime })
  const { [id]: _st, ...stats } = statsStore.get()
  statsStore.set(stats)
  return true
}

export async function startTunnel(id: string): Promise<void> {
  const rt = await attempt("Couldn't start the tunnel", () => api.invoke('tunnel:start', id))
  // A state event that beat the reply is newer; only fill in or replace a settled entry.
  const known = tunnelStore.get().runtime[id]
  if (rt && (!known || known.state === 'stopped' || known.state === 'failed')) setRuntime(rt)
}

export async function stopTunnel(id: string): Promise<void> {
  await attempt("Couldn't stop the tunnel", () => api.invoke('tunnel:stop', id))
}

/** A tunnel's saved config with its live runtime; the pair keeps its identity until either changes. */
export function useTunnel(id: string): { meta: TunnelMeta | undefined; runtime: TunnelRuntime | undefined } {
  const cache = useRef<{ meta: TunnelMeta | undefined; runtime: TunnelRuntime | undefined }>({ meta: undefined, runtime: undefined })
  return useSyncExternalStore(tunnelStore.subscribe, () => {
    const s = tunnelStore.get()
    const meta = s.tunnels.find((t) => t.id === id)
    const runtime = s.runtime[id]
    if (cache.current.meta !== meta || cache.current.runtime !== runtime) cache.current = { meta, runtime }
    return cache.current
  })
}

export function useTunnelStats(id: string): StatsEntry | undefined {
  return useSyncExternalStore(statsStore.subscribe, () => statsStore.get()[id])
}
