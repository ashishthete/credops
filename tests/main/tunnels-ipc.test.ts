import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createInventoryHandlers } from '../../src/main/ipc/handlers/inventory'
import { createTunnelHandlers, type TunnelApi } from '../../src/main/ipc/handlers/tunnels'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { TunnelManager } from '../../src/main/tunnels/manager'
import { TunnelStore } from '../../src/main/tunnels/tunnel-store'
import type { Handlers } from '../../src/shared/ipc'
import type { TunnelRuntime } from '../../src/shared/tunnels'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { makeInventory } from './inventory-helpers'
import { stubHandlers } from './ipc-helpers'

type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

const runtime = { id: 'r', state: 'connecting' } as TunnelRuntime

function fakeManager(): { [K in keyof TunnelApi]: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(() => runtime),
    stop: vi.fn(),
    status: vi.fn(() => [runtime]),
  }
}

function register(handlers: Partial<Handlers>) {
  const registered = new Map<string, Fn>()
  registerHandlers(
    { handle: (c: string, fn: Fn) => void registered.set(c, fn) },
    stubHandlers(handlers),
    (u) => u === 'file:///ok',
    { validators: VALIDATORS },
  )
  const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
  return (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
}

async function setup() {
  const f = await makeInventory()
  const store = new TunnelStore({ db: f.db, audit: f.audit, vault: f.vault })
  const manager = fakeManager()
  const call = register(createTunnelHandlers({ store, manager: manager as unknown as TunnelApi }))
  return { ...f, store, manager, call }
}

describe('tunnel IPC', () => {
  it('delegates start, stop and status to the manager', async () => {
    const { manager, call } = await setup()
    const id = randomUUID()
    await expect(call('tunnel:start', id)).resolves.toBe(runtime)
    expect(manager.start).toHaveBeenCalledExactlyOnceWith(id)
    await call('tunnel:stop', id)
    expect(manager.stop).toHaveBeenCalledExactlyOnceWith(id)
    await expect(call('tunnel:status')).resolves.toEqual([runtime])
  })

  it('validators reject a non-uuid id without echoing it', async () => {
    const { manager, call } = await setup()
    const err = await call('tunnel:start', 'secret-hunter2').catch((e: Error) => e)
    expect((err as Error).message).toBe('invalid arguments: [0] must be a uuid')
    await expect(call('tunnel:stop', 42)).rejects.toThrow('invalid arguments: [0] must be a uuid')
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled()
  })

  it('tunnel:start while locked rejects with VAULT_LOCKED', async () => {
    const f = await makeInventory()
    const store = new TunnelStore({ db: f.db, audit: f.audit, vault: f.vault })
    const hostId = f.hosts.create({ label: 'h', address: '127.0.0.1', port: 22 }).id
    const tun = store.create({ label: 'db', hostId, type: 'L', bindPort: 0, targetHost: '127.0.0.1', targetPort: 1 })
    const emit = vi.fn()
    const manager = new TunnelManager({
      store,
      resolve: () => {
        throw new Error('never dialled')
      },
      hostInfo: () => ({ label: 'h', keepaliveSec: null }),
      connect: () => new Promise(() => {}),
      plan: async () => {
        throw new Error('never dialled')
      },
      knownHosts: { check: vi.fn(), trust: vi.fn(), recordMismatch: vi.fn() } as never,
      prompts: { ask: vi.fn(), cancel: vi.fn() } as never,
      isLocked: () => !f.vault.isUnlocked(),
      listen: () => Promise.reject(new Error('never bound')),
      audit: f.audit,
      emit,
    })
    const call = register(createTunnelHandlers({ store, manager }))
    f.vault.lock('manual')
    await expect(call('tunnel:start', tun.id)).rejects.toThrow(VAULT_LOCKED)
    expect(emit).not.toHaveBeenCalled()
    await expect(call('tunnel:status')).resolves.toMatchObject([{ id: tun.id, state: 'stopped' }])
  })

  it('host:delete stops that host’s tunnels first', async () => {
    const f = await makeInventory()
    const hostId = f.hosts.create({ label: 'h', address: '127.0.0.1', port: 22 }).id
    const order: string[] = []
    const tunnels = {
      stopForHost: vi.fn((id: string, reason: string) => {
        order.push(`stop ${id === hostId ? 'host' : id} ${reason}`)
      }),
    }
    const deleteHost = f.hosts.delete.bind(f.hosts)
    vi.spyOn(f.hosts, 'delete').mockImplementation((id) => {
      order.push('delete')
      return deleteHost(id)
    })
    const call = register(
      createInventoryHandlers({ hosts: f.hosts, environments: f.envs, products: f.products, resolve: vi.fn(), tunnels }),
    )
    await call('host:delete', hostId)
    expect(order).toEqual(['stop host deleted', 'delete'])
  })

  it('a refused host:delete stops no tunnels', async () => {
    const f = await makeInventory()
    const jump = f.hosts.create({ label: 'jump', address: '127.0.0.1', port: 22 }).id
    f.hosts.create({ label: 'behind', address: '10.0.0.9', port: 22, jumpHostId: jump })
    const tunnels = { stopForHost: vi.fn() }
    const call = register(
      createInventoryHandlers({ hosts: f.hosts, environments: f.envs, products: f.products, resolve: vi.fn(), tunnels }),
    )
    await expect(call('host:delete', jump)).rejects.toThrow('host is the jump host for behind')
    f.vault.lock('manual')
    await expect(call('host:delete', jump)).rejects.toThrow(VAULT_LOCKED)
    expect(tunnels.stopForHost).not.toHaveBeenCalled()
  })
})
