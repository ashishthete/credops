import { useRef, useSyncExternalStore } from 'react'
import type { SessionMeta } from '../../../shared/ssh'
import type { TunnelMeta, TunnelRuntime } from '../../../shared/tunnels'
import { sessionStore } from '../terminal/sessions'
import { tunnelStore } from '../tunnels/store'

export type Reach = 'ok' | 'busy' | 'bad' | 'unknown'

export const REACH_TEXT: Record<Reach, string> = {
  ok: 'Reachable',
  busy: 'Connecting',
  bad: 'Last connection failed',
  unknown: 'Not checked',
}

export interface HostPresence {
  /** Sessions connecting or ready. */
  sessions: number
  reach: Reach
}

/**
 * Evidence only: green needs a ready session or an up tunnel; there is no probe.
 * The first rule that matches wins: ok, then busy, then bad, else unknown.
 */
export function hostPresence(
  hostId: string,
  sessions: SessionMeta[],
  tunnels: TunnelMeta[],
  runtime: Record<string, TunnelRuntime>,
): HostPresence {
  const sessionStates = new Set<string>()
  let live = 0
  for (const s of sessions) {
    if (s.hostId !== hostId) continue
    sessionStates.add(s.state)
    if (s.state === 'connecting' || s.state === 'ready') live++
  }
  const tunnelStates = new Set<string>()
  for (const t of tunnels) {
    const state = t.hostId === hostId ? runtime[t.id]?.state : undefined
    if (state) tunnelStates.add(state)
  }
  const reach: Reach =
    sessionStates.has('ready') || tunnelStates.has('up') ? 'ok'
    : sessionStates.has('connecting') || tunnelStates.has('connecting') || tunnelStates.has('retrying') ? 'busy'
    : sessionStates.has('failed') || tunnelStates.has('failed') ? 'bad'
    : 'unknown'
  return { sessions: live, reach }
}

const subscribe = (listener: () => void) => {
  const offSessions = sessionStore.subscribe(listener)
  const offTunnels = tunnelStore.subscribe(listener)
  return () => {
    offSessions()
    offTunnels()
  }
}

/** A host's live presence; the snapshot keeps its identity until its count or reach changes. */
export function useHostPresence(hostId: string): HostPresence {
  const cache = useRef<HostPresence>({ sessions: 0, reach: 'unknown' })
  return useSyncExternalStore(subscribe, () => {
    const { tunnels, runtime } = tunnelStore.get()
    const next = hostPresence(hostId, sessionStore.get().sessions, tunnels, runtime)
    if (next.sessions !== cache.current.sessions || next.reach !== cache.current.reach) cache.current = next
    return cache.current
  })
}
