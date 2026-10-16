import { beforeEach, describe, expect, it } from 'vitest'
import { inv, inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import type { EnvironmentMeta, HostMeta } from '../../src/shared/inventory'
import { environment, host, mockBridge, vaultStatus } from './helpers'

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
    await expect(inv.saveHost({ label: 'new', address: 'new.example.com' })).resolves.toMatchObject({ id: 'N' })
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
    await inv.saveHost({ label: 'h', address: h.address, port: null, vaultIds: ['v1', 'v2'], environments: [] }, 'H')
    expect(invoke).toHaveBeenCalledWith('host:update', 'H', { port: null })
    expect(invoke).toHaveBeenCalledWith('host:setVaults', 'H', ['v1', 'v2'])
    expect(inventoryStore.get()!.hosts[0].vaultIds).toEqual(['v1', 'v2'])
  })
})
