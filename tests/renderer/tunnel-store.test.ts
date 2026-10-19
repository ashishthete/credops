import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  onTunnelEvent,
  resetTunnels,
  startTunnelSync,
  statsStore,
  tunnelStore,
} from '../../src/renderer/src/tunnels/store'
import { toast } from '../../src/renderer/src/ui/Toaster'
import { emitBridgeEvent, mockBridge, tunnelMeta, tunnelRuntime } from './helpers'
import type { TunnelEvent, TunnelStats } from '../../src/shared/tunnels'

vi.mock('../../src/renderer/src/ui/Toaster', () => ({ toast: vi.fn(() => 'toast-1') }))

let stop: (() => void) | null = null

afterEach(() => {
  stop?.()
  stop = null
  resetTunnels()
  vi.mocked(toast).mockClear()
})

const flush = () => act(async () => {})

async function sync(results: Record<string, unknown> = {}) {
  const invoke = mockBridge(results)
  stop = startTunnelSync()
  await flush()
  return invoke
}

const stats = (id: string, rateIn: number): TunnelStats => ({ id, bytesIn: 0, bytesOut: 0, rateIn, rateOut: 0, connections: 0, rejected: 0 })
const failedEvent: TunnelEvent = {
  type: 'failed',
  tunnelId: 't1',
  label: 'db',
  at: 'now',
  error: { code: 'port-in-use', message: 'Port 5433 on 127.0.0.1 is already in use' },
  wasUp: false,
}

describe('tunnel store', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('sync loads list and status', async () => {
    const meta = tunnelMeta({ id: 't1' })
    const rt = tunnelRuntime({ id: 't1' })
    await sync({ 'tunnel:list': [meta], 'tunnel:status': [rt] })
    expect(tunnelStore.get()).toEqual({ tunnels: [meta], runtime: { t1: rt }, loaded: true })
  })

  it('state events update runtime', async () => {
    await sync()
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'retrying', failures: 2 })))
    expect(tunnelStore.get().runtime.t1).toMatchObject({ state: 'retrying', failures: 2, maxFailures: 5 })
  })

  it('stats events append to a ring capped at 60', async () => {
    await sync()
    for (let i = 1; i <= 61; i++) act(() => emitBridgeEvent('tunnel:stats', [stats('t1', i)]))
    const entry = statsStore.get().t1
    expect(entry.inSamples).toHaveLength(60)
    expect(entry.inSamples[0]).toBe(2)
    expect(entry.inSamples.at(-1)).toBe(61)
    expect(entry.last.rateIn).toBe(61)
  })

  it("stats ticks don't notify tunnelStore subscribers", async () => {
    await sync()
    const listener = vi.fn()
    const off = tunnelStore.subscribe(listener)
    act(() => emitBridgeEvent('tunnel:stats', [stats('t1', 5)]))
    off()
    expect(listener).not.toHaveBeenCalled()
  })

  it('onTunnelEvent fans out and unsubscribes', async () => {
    await sync()
    const a = vi.fn()
    const b = vi.fn()
    const offA = onTunnelEvent(a)
    const offB = onTunnelEvent(b)
    act(() => emitBridgeEvent('tunnel:event', failedEvent))
    expect(a).toHaveBeenCalledWith(failedEvent)
    expect(b).toHaveBeenCalledWith(failedEvent)
    offA()
    act(() => emitBridgeEvent('tunnel:event', failedEvent))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
  })

  it('failed event toasts the redacted message once', async () => {
    await sync()
    act(() => emitBridgeEvent('tunnel:event', failedEvent))
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith({ title: 'db', description: 'Port 5433 on 127.0.0.1 is already in use', tone: 'error' })
  })

  it('only a recovered up event toasts', async () => {
    await sync()
    act(() => {
      emitBridgeEvent('tunnel:event', { type: 'up', tunnelId: 't1', label: 'db', at: 'now', recovered: false })
      emitBridgeEvent('tunnel:event', { type: 'retrying', tunnelId: 't1', label: 'db', at: 'now', failures: 1, retryInMs: 1000, error: failedEvent.error })
    })
    expect(toast).not.toHaveBeenCalled()
    act(() => emitBridgeEvent('tunnel:event', { type: 'up', tunnelId: 't1', label: 'db', at: 'now', recovered: true }))
    expect(toast).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith({ title: 'db is back up', tone: 'success' })
  })

  it('startTunnelSync twice subscribes once', async () => {
    const invoke = mockBridge()
    const first = startTunnelSync()
    const second = startTunnelSync()
    await flush()
    expect(invoke.mock.calls.filter(([c]) => c === 'tunnel:list')).toHaveLength(1)
    const fn = vi.fn()
    const off = onTunnelEvent(fn)
    act(() => emitBridgeEvent('tunnel:event', failedEvent))
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    first()
    // One caller still holds the subscription.
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't9' })))
    expect(tunnelStore.get().runtime.t9).toBeDefined()
    second()
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't8' })))
    expect(tunnelStore.get().runtime.t8).toBeUndefined()
  })
})
