import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { hostPresence, useHostPresence, type Reach } from '../../src/renderer/src/map/presence'
import { resetSessions, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import type { SessionState } from '../../src/shared/ssh'
import type { TunnelRuntime, TunnelState } from '../../src/shared/tunnels'
import { session, tunnelMeta, tunnelRuntime } from './helpers'

const SESSION_STATES: (SessionState | null)[] = [null, 'connecting', 'ready', 'closed', 'failed']
const TUNNEL_STATES: (TunnelState | null)[] = [null, 'stopped', 'connecting', 'up', 'retrying', 'failed']

function presenceOf(sessionState: SessionState | null, tunnelState: TunnelState | null) {
  const sessions = sessionState ? [session({ id: 's1', hostId: 'h1', state: sessionState })] : []
  const tunnels = tunnelState ? [tunnelMeta({ id: 't1', hostId: 'h1' })] : []
  const runtime: Record<string, TunnelRuntime> = tunnelState ? { t1: tunnelRuntime({ id: 't1', state: tunnelState }) } : {}
  return hostPresence('h1', sessions, tunnels, runtime)
}

afterEach(() => {
  resetSessions()
  resetTunnels()
})

describe('host presence', () => {
  it('presence is green only on a ready session or an up tunnel', () => {
    for (const s of SESSION_STATES) {
      for (const t of TUNNEL_STATES) {
        const expected: Reach =
          s === 'ready' || t === 'up' ? 'ok'
          : s === 'connecting' || t === 'connecting' || t === 'retrying' ? 'busy'
          : s === 'failed' || t === 'failed' ? 'bad'
          : 'unknown'
        expect(presenceOf(s, t).reach, `session ${s}, tunnel ${t}`).toBe(expected)
      }
    }
    expect(presenceOf('connecting', null).reach).toBe('busy')
    expect(presenceOf('failed', null).reach).toBe('bad')
    expect(presenceOf(null, 'failed').reach).toBe('bad')
    expect(presenceOf('closed', null).reach).toBe('unknown')
    expect(presenceOf(null, 'stopped').reach).toBe('unknown')
    expect(presenceOf('closed', 'stopped').reach).toBe('unknown')
  })

  it('a dropped tunnel turns its host amber', () => {
    const tunnels = [tunnelMeta({ id: 't1', hostId: 'h1' })]
    expect(hostPresence('h1', [], tunnels, { t1: tunnelRuntime({ id: 't1', state: 'up' }) }).reach).toBe('ok')
    expect(hostPresence('h1', [], tunnels, { t1: tunnelRuntime({ id: 't1', state: 'retrying', failures: 1 }) }).reach).toBe('busy')
  })

  it('counts only live sessions', () => {
    const sessions = [
      session({ id: 'a', hostId: 'h1', state: 'ready' }),
      session({ id: 'b', hostId: 'h1', state: 'connecting' }),
      session({ id: 'c', hostId: 'h1', state: 'closed' }),
      session({ id: 'd', hostId: 'h1', state: 'failed' }),
      session({ id: 'e', hostId: 'h2', state: 'ready' }),
    ]
    expect(hostPresence('h1', sessions, [], {})).toEqual({ sessions: 2, reach: 'ok' })
  })

  it('ignores other hosts and tunnels without runtime', () => {
    const tunnels = [tunnelMeta({ id: 't1', hostId: 'h2' }), tunnelMeta({ id: 't2', hostId: 'h1' })]
    expect(hostPresence('h1', [], tunnels, { t1: tunnelRuntime({ id: 't1', state: 'up' }) }).reach).toBe('unknown')
  })

  it('useHostPresence ignores other hosts', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useHostPresence('h1')
    })
    expect(result.current).toEqual({ sessions: 0, reach: 'unknown' })
    const before = renders

    act(() => sessionStore.set({ ...sessionStore.get(), sessions: [session({ id: 's2', hostId: 'h2', state: 'ready' })] }))
    act(() => tunnelStore.set({ ...tunnelStore.get(), tunnels: [tunnelMeta({ id: 't9', hostId: 'h2' })] }))
    expect(renders).toBe(before)

    act(() =>
      sessionStore.set({
        ...sessionStore.get(),
        sessions: [...sessionStore.get().sessions, session({ id: 's1', hostId: 'h1', state: 'ready' })],
      }),
    )
    expect(result.current).toEqual({ sessions: 1, reach: 'ok' })
    expect(renders).toBe(before + 1)
  })
})
