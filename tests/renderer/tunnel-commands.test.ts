import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { useTunnelCommands } from '../../src/renderer/src/tunnels/commands'
import { resetTunnels, startTunnelSync } from '../../src/renderer/src/tunnels/store'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { TunnelMeta, TunnelRuntime } from '../../src/shared/tunnels'
import { emitBridgeEvent, host, mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

const db = host({ id: 'h-db', label: 'db' })
const web = host({ id: 'h-web', label: 'web' })

const flush = () => act(async () => {})
const titles = () =>
  commandStore
    .get()
    .filter((c) => c.section === 'Tunnels')
    .map((c) => c.title)
    .sort()
const command = (title: string) => commandStore.get().find((c) => c.title === title)!
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, { initialEntries: ['/products'] }, children)

let stopSync: (() => void) | null = null
async function sync(tunnels: TunnelMeta[], runtime: TunnelRuntime[]) {
  const invoke = mockBridge({ 'tunnel:list': tunnels, 'tunnel:status': runtime, 'host:list': [db, web] })
  stopSync = startTunnelSync()
  await flush()
  return invoke
}

beforeEach(() => {
  vi.useFakeTimers()
  resetTunnels()
  inventoryStore.set({ products: [], environments: [], hosts: [db, web], identities: [], vaults: [] })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  stopSync?.()
  stopSync = null
  resetTunnels()
  inventoryStore.set(null)
  clearToasts()
})

describe('tunnel commands', () => {
  it('registers start for stopped and stop for up tunnels', async () => {
    const invoke = await sync(
      [
        tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', bindPort: 5433 }),
        tunnelMeta({ id: 't2', label: 'proxy', hostId: 'h-web', type: 'D', bindPort: 1080, targetHost: null, targetPort: null }),
        tunnelMeta({ id: 't3', label: 'broken', hostId: 'h-db' }),
        tunnelMeta({ id: 't4', label: 'trying', hostId: 'h-db' }),
      ],
      [
        tunnelRuntime({ id: 't1', state: 'stopped' }),
        tunnelRuntime({ id: 't2', state: 'up' }),
        tunnelRuntime({ id: 't3', state: 'failed', error: { code: 'auth', message: 'Authentication failed' } }),
        tunnelRuntime({ id: 't4', state: 'retrying', failures: 1 }),
      ],
    )
    const { unmount } = renderHook(useTunnelCommands, { wrapper })
    expect(titles()).toEqual(['New tunnel', 'Start tunnel broken', 'Start tunnel pg', 'Stop tunnel proxy', 'Stop tunnel trying'])
    expect(command('Start tunnel pg').keywords).toEqual(expect.arrayContaining(['db', 'Local forward', '5433']))
    expect(command('Stop tunnel proxy').keywords).toEqual(expect.arrayContaining(['web', 'SOCKS proxy', '1080']))
    // AppShell already registers Go to Tunnels; it is not duplicated here.
    expect(commandStore.get().filter((c) => c.title === 'Go to Tunnels')).toHaveLength(0)

    await act(async () => command('Start tunnel pg').run())
    expect(calls(invoke, 'tunnel:start')).toEqual([['tunnel:start', 't1']])
    await act(async () => command('Stop tunnel proxy').run())
    expect(calls(invoke, 'tunnel:stop')).toEqual([['tunnel:stop', 't2']])

    unmount()
    expect(titles()).toEqual([])
  })

  it('re-registers when state changes', async () => {
    await sync([tunnelMeta({ id: 't1', label: 'db', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    renderHook(useTunnelCommands, { wrapper })
    expect(titles()).toContain('Start tunnel db')
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'up' })))
    expect(titles()).toContain('Stop tunnel db')
    expect(titles()).not.toContain('Start tunnel db')
  })

  it('New tunnel opens the dialog', async () => {
    mockBridge({ 'host:list': [db, web] })
    render(createElement(MemoryRouter, { initialEntries: ['/products'] }, createElement(AppShell)))
    await flush()
    // Go to Tunnels stays the shell's single section command.
    expect(commandStore.get().filter((c) => c.title === 'Go to Tunnels')).toHaveLength(1)
    await act(async () => command('New tunnel').run())
    await flush()
    expect(screen.getByRole('heading', { name: 'Tunnels', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New tunnel' })).toBeInTheDocument()
  })
})
