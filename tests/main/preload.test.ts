import { describe, expect, it, vi } from 'vitest'
import { createBridge, type BridgeIpc } from '../../src/preload/bridge'

function fakeIpc() {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  const ipc = {
    invoke: vi.fn(async () => 'ok'),
    on: vi.fn((channel: string, fn: (...a: unknown[]) => void) => {
      listeners.set(channel, (listeners.get(channel) ?? new Set()).add(fn))
    }),
    removeListener: vi.fn((channel: string, fn: (...a: unknown[]) => void) => {
      listeners.get(channel)?.delete(fn)
    }),
  }
  const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach((fn) => fn(...args))
  return { ipc: ipc as unknown as BridgeIpc & typeof ipc, emit, listeners }
}

describe('preload bridge', () => {
  it('invokes only known channels', async () => {
    const { ipc } = fakeIpc()
    const bridge = createBridge(ipc)
    await expect(bridge.invoke('vault:status')).resolves.toBe('ok')
    await expect(bridge.invoke('nope' as 'vault:status')).rejects.toThrow('unknown channel: nope')
    expect(ipc.invoke).toHaveBeenCalledOnce()
  })

  it('subscribes only to allow-listed events', () => {
    const { ipc } = fakeIpc()
    const bridge = createBridge(ipc)
    expect(() => bridge.on('vault:status' as 'vault:locked', () => {})).toThrow('unknown event')
    expect(() => bridge.on('ssh:data' as 'vault:locked', () => {})).toThrow('unknown event')
    expect(ipc.on).not.toHaveBeenCalled()
  })

  it('allows the session events', () => {
    const { ipc, emit } = fakeIpc()
    const bridge = createBridge(ipc)
    const listener = vi.fn()
    bridge.on('session:data', listener)
    for (const e of ['session:state', 'session:prompt', 'session:promptDone'] as const) bridge.on(e, () => {})
    emit('session:data', {}, { id: 's', data: 'hi', end: 2 })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: 's', data: 'hi', end: 2 })
    expect(ipc.on).toHaveBeenCalledTimes(4)
  })

  it('passes only the payload and unsubscribes', () => {
    const { ipc, emit, listeners } = fakeIpc()
    const bridge = createBridge(ipc)
    const listener = vi.fn()
    const off = bridge.on('vault:locked', listener)
    const sender = { id: 1, send: () => {} }
    emit('vault:locked', { sender }, { reason: 'idle' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ reason: 'idle' })
    off()
    expect(listeners.get('vault:locked')?.size).toBe(0)
    emit('vault:locked', { sender }, { reason: 'screen' })
    expect(listener).toHaveBeenCalledOnce()
  })
})
