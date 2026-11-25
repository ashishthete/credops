import { describe, expect, it } from 'vitest'
import { ensureHostService } from '../../src/main/deploy/host-service'
import { environmentMeta, hostMeta } from '../../src/main/inventory/rows'
import type { HostRole } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { PRODUCT, REGION, makeInventory } from './inventory-helpers'

const TS = '2026-10-16T09:00:00.000Z'

/** The batched lists must match building each row on its own, ordering included. */
describe('inventory lists', () => {
  it('host:list and env:list match the per-id rows', async () => {
    const f = await makeInventory()
    const other = f.vault.createVault({ name: 'Other', color: '#112233' })
    const run = (sql: string, ...args: (string | number)[]) => f.db.prepare(sql).run(...args)
    // Ids out of name order, so the sort is checked separately from insertion order.
    for (const [id, name] of [['p2', 'Shop'], ['p1', 'Api']])
      run('INSERT INTO products(id, name, color, icon, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, name, '#336699', 'box', TS, TS)
    for (const [id, name, product] of [['e3', 'alpha', 'p1'], ['e1', 'Beta', 'p2'], ['e2', 'gamma', PRODUCT]])
      run('INSERT INTO environments(id, name, color, product_id, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, name, '#336699', product, TS, TS)
    for (const [id, label] of [['h4', 'zeta'], ['h2', 'Alpha'], ['h3', 'beta'], ['h1', 'lonely']])
      run('INSERT INTO hosts(region_id, id, label, address, created_at, updated_at) VALUES (?,?,?,?,?,?)', REGION, id, label, 'a.b', TS, TS)
    for (const [env, host, role] of [
      ['e2', 'h4', 'db'],
      ['e1', 'h4', 'app'],
      ['e3', 'h4', 'bastion'],
      ['e1', 'h2', 'other'],
      ['e1', 'h3', 'db'],
    ])
      ensureHostService(f.db, env, host, role as HostRole)
    for (const [host, vault] of [
      ['h4', other.id],
      ['h4', DEFAULT_VAULT_ID],
      ['h2', other.id],
    ])
      run('INSERT INTO host_vaults(host_id, vault_id) VALUES (?,?)', host, vault)

    const hosts = f.hosts.list()
    expect(hosts.map((h) => h.label)).toEqual(['Alpha', 'beta', 'lonely', 'zeta'])
    expect(hosts).toEqual(['h2', 'h3', 'h1', 'h4'].map((id) => hostMeta(f.db, id)))
    const envs = f.envs.list()
    expect(envs.map((e) => e.name)).toEqual(['alpha', 'Beta', 'gamma'])
    expect(envs).toEqual(['e3', 'e1', 'e2'].map((id) => environmentMeta(f.db, id)))
    // The links are really there, so the comparison above isn't of empty lists.
    expect(hosts[3].environments.map((e) => e.role)).toEqual(['app', 'db', 'bastion'])
    expect(hosts[3].vaultIds).toHaveLength(2)
    expect(envs[1].hosts.map((h) => h.hostId)).toEqual(['h2', 'h3', 'h4'])
    expect(envs.map((e) => e.productId)).toEqual(['p1', 'p2', PRODUCT])
    expect(f.products.list().map((p) => [p.name, p.environmentIds])).toEqual([
      ['Api', ['e3']],
      ['Fixture', ['e2']],
      ['Shop', ['e1']],
    ])
  })
})
