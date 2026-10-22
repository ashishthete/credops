import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { createElement, type ReactNode } from 'react'
import { useInventoryCommands } from '../../src/renderer/src/inventory/commands'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { inv, inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { loadTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import type { EnvironmentMeta, HostMeta } from '../../src/shared/inventory'
import { REGION, environment, host, mockBridge, tunnelMeta, vaultStatus } from './helpers'

beforeEach(() => {
  inventoryStore.set(null)
  vaultStatusStore.set(vaultStatus({ unlocked: true }))
})

describe('inventory store', () => {
  it('shared host updates everywhere', async () => {
    const h = host({ id: 'H', label: 'h', environments: [{ environmentId: 'prod', role: 'app' }, { environmentId: 'staging', role: 'app' }] })
    let envs: EnvironmentMeta[] = [
      environment({ id: 'prod', name: 'prod', hosts: [{ hostId: 'H', role: 'app' }] }),
      environment({ id: 'staging', name: 'staging', hosts: [{ hostId: 'H', role: 'app' }] }),
    ]
    let hosts: HostMeta[] = [h]
    const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true }) })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'env:list') return envs
      if (channel === 'host:list') return hosts
      if (channel === 'env:removeHost') {
        envs = envs.map((e) => (e.id === 'staging' ? { ...e, hosts: [] } : e))
        hosts = hosts.map((x) => ({ ...x, environments: x.environments.filter((m) => m.environmentId !== 'staging') }))
        return envs[1]
      }
      return base(channel, ...(args as []))
    })
    await loadInventory()
    expect(inventoryStore.get()?.hosts).toHaveLength(1)
    await expect(inv.removeHost('staging', 'H')).resolves.toMatchObject({ id: 'staging' })
    const data = inventoryStore.get()!
    expect(data.environments.find((e) => e.id === 'staging')!.hosts).toEqual([])
    expect(data.hosts.find((x) => x.id === 'H')!.environments).toEqual([{ environmentId: 'prod', role: 'app' }])
  })

  it('tunnels reload after an environment delete or a host leaving one, not after a product delete', async () => {
    let tunnels = [tunnelMeta({ id: 't1', hostId: 'H', environmentId: 'staging' })]
    const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true }) })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'tunnel:list') return tunnels
      if (channel === 'env:list') return [environment({ id: 'staging', name: 'staging', hosts: [{ hostId: 'H', role: 'app' }] })]
      if (channel === 'env:removeHost') return environment({ id: 'staging', name: 'staging' })
      if (channel === 'product:delete' || channel === 'env:delete') return null
      return base(channel, ...(args as []))
    })
    await loadInventory()
    await loadTunnels()
    const loads = (): number => invoke.mock.calls.filter(([c]) => c === 'tunnel:list').length
    expect(loads()).toBe(1)

    await expect(inv.deleteProduct('P')).resolves.toBe(true)
    expect(loads()).toBe(1)

    // Main sets the tunnel's environment to null with the delete; the renderer must not keep the dead id.
    tunnels = [{ ...tunnels[0], environmentId: null }]
    await expect(inv.deleteEnvironment('staging')).resolves.toBe(true)
    await waitFor(() => expect(tunnelStore.get().tunnels[0].environmentId).toBeNull())
    expect(loads()).toBe(2)

    await inv.removeHost('staging', 'H')
    await waitFor(() => expect(loads()).toBe(3))
  })

  it('locked mutation unlocks then retries', async () => {
    let creates = 0
    const created = host({ id: 'N', label: 'new' })
    const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true }) })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'host:create') {
        if (creates++ === 0) throw new Error(VAULT_LOCKED)
        return created
      }
      return base(channel, ...(args as []))
    })
    await loadInventory()
    await expect(inv.saveHost({ label: 'new', address: 'new.example.com', regionId: REGION.id })).resolves.toMatchObject({ id: 'N' })
    expect(creates).toBe(2)
    expect(inventoryStore.get()!.hosts.map((x) => x.id)).toEqual(['N'])
  })

  it('edit sends a diff-only patch and routes link changes', async () => {
    const h = host({ id: 'H', label: 'h', port: 22, vaultIds: ['v1'] })
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'host:list') return [h]
      if (channel === 'host:update') return { ...h, port: null }
      if (channel === 'host:setVaults') return { ...h, port: null, vaultIds: args[1] }
      return base(channel, ...(args as []))
    })
    await loadInventory()
    await inv.saveHost({ label: 'h', address: h.address, regionId: REGION.id, port: null, vaultIds: ['v1', 'v2'], environments: [] }, 'H')
    expect(invoke).toHaveBeenCalledWith('host:update', 'H', { port: null })
    expect(invoke).toHaveBeenCalledWith('host:setVaults', 'H', ['v1', 'v2'])
    expect(inventoryStore.get()!.hosts[0].vaultIds).toEqual(['v1', 'v2'])
  })

  it('a failed link change after a saved edit re-reads that list', async () => {
    let hosts: HostMeta[] = [host({ id: 'H', label: 'h', port: 22, vaultIds: ['v1'] })]
    let envs: EnvironmentMeta[] = [environment({ id: 'E', name: 'e', productId: 'p1' })]
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'host:list') return hosts
      if (channel === 'env:list') return envs
      if (channel === 'host:update') return (hosts = [{ ...hosts[0], port: 2222 }])[0]
      if (channel === 'env:update') return (envs = [{ ...envs[0], name: 'e2' }])[0]
      if (channel === 'host:setVaults' || channel === 'env:setProduct') throw new Error('link failed')
      return base(channel, ...(args as []))
    })
    await loadInventory()
    await expect(inv.saveHost({ label: 'h', address: hosts[0].address, regionId: REGION.id, port: 2222, vaultIds: ['v2'] }, 'H')).resolves.toBeUndefined()
    expect(inventoryStore.get()!.hosts[0].port).toBe(2222)
    await expect(inv.saveEnvironment({ name: 'e2', color: envs[0].color, productId: 'p2' }, 'E')).resolves.toBeUndefined()
    expect(inventoryStore.get()!.environments[0].name).toBe('e2')
  })

  it('a new host goes in the region the caller names, never one the store picks', async () => {
    const invoke = mockBridge({ 'host:create': host({ id: 'N', label: 'n', regionId: 'r2' }), 'sshconfig:import': { created: [], skipped: [], tunnelsCreated: 0 } })
    await loadInventory()
    await inv.saveHost({ label: 'n', address: 'n.example.com', regionId: 'r2', vaultIds: [] })
    expect(invoke).toHaveBeenCalledWith('host:create', { label: 'n', address: 'n.example.com', regionId: 'r2', vaultIds: [] })
    await inv.importSshConfig({ regionId: 'r2', vaultId: 'v', aliases: ['a'] })
    expect(invoke).toHaveBeenCalledWith('sshconfig:import', { regionId: 'r2', vaultId: 'v', aliases: ['a'] })
  })

  it("deleting a region a host still uses hands main's refusal to the caller", async () => {
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'region:delete') throw new Error('test-1 still has a host: move it to another region first')
      return base(channel, ...(args as []))
    })
    await loadInventory()
    const refusals: string[] = []
    await expect(inv.deleteRegion(REGION.id, (m) => refusals.push(m))).resolves.toBe(false)
    expect(refusals).toEqual(['test-1 still has a host: move it to another region first'])
    expect(inventoryStore.get()!.regions.map((r) => r.id)).toEqual([REGION.id])
  })

  it('an edit that changes the product moves the environment', async () => {
    let envs: EnvironmentMeta[] = [environment({ id: 'E', name: 'e', productId: 'p1' })]
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'env:list') return envs
      if (channel === 'env:setProduct') return (envs = [{ ...envs[0], productId: args[1] as string }])[0]
      return base(channel, ...(args as []))
    })
    await loadInventory()
    await inv.saveEnvironment({ name: 'e', color: envs[0].color, productId: 'p1' }, 'E')
    expect(invoke).not.toHaveBeenCalledWith('env:setProduct', expect.anything(), expect.anything())
    await inv.saveEnvironment({ name: 'e', color: envs[0].color, productId: 'p2' }, 'E')
    expect(invoke).toHaveBeenCalledWith('env:setProduct', 'E', 'p2')
    expect(inventoryStore.get()!.environments[0].productId).toBe('p2')
  })

  it("a load that started before a write doesn't undo it", async () => {
    const h = host({ id: 'H', label: 'old' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let slow = false
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'host:list') {
        if (slow) await gate
        return [h]
      }
      if (channel === 'host:update') return { ...h, label: 'new' }
      return base(channel, ...(args as []))
    })
    await loadInventory()
    slow = true
    const stale = loadInventory()
    await inv.saveHost({ label: 'new', address: h.address, regionId: REGION.id }, 'H')
    expect(inventoryStore.get()!.hosts[0].label).toBe('new')
    release()
    await stale
    expect(inventoryStore.get()!.hosts[0].label).toBe('new')
  })

  it('registers the Go to commands in one batch', async () => {
    const hosts = Array.from({ length: 40 }, (_, i) => host({ id: `h${i}`, label: `h${i}` }))
    const invoke = mockBridge()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
      channel === 'host:list' ? hosts : base(channel, ...(args as [])),
    )
    await loadInventory()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children)
    const { unmount } = renderHook(() => useInventoryCommands(), { wrapper })
    expect(commandStore.get().filter((c) => c.id.startsWith('hosts.go.'))).toHaveLength(40)
    let sets = 0
    const off = commandStore.subscribe(() => sets++)
    act(() => inventoryStore.set({ ...inventoryStore.get()!, hosts: hosts.slice(1) }))
    off()
    expect(sets).toBeLessThanOrEqual(2)
    expect(commandStore.get().filter((c) => c.id.startsWith('hosts.go.'))).toHaveLength(39)
    unmount()
    expect(commandStore.get().filter((c) => c.id.startsWith('hosts.go.'))).toHaveLength(0)
  })
})
