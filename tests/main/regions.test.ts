import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { REGIONS_REPORT_KEY, type RegionsUpgradeReport } from '../../src/shared/inventory'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { REGION, inventoryHandlers, makeInventory, type InventoryFixture } from './inventory-helpers'

const actions = (f: InventoryFixture, action: string) =>
  f.audit
    .list({ limit: 1000 })
    .reverse()
    .filter((e) => e.action === action)

const REPORT: RegionsUpgradeReport = {
  region: { id: REGION, code: 'test-1', displayName: 'Test', hostCount: 2 },
  productLinks: [{ environmentId: 'e1', environmentName: 'prod', kept: { id: 'p1', name: 'Globe' }, removed: [{ id: 'p2', name: 'Leaf' }] }],
  unassigned: null,
  renamed: [],
}
const putReport = (f: InventoryFixture, r: RegionsUpgradeReport = REPORT): void => {
  f.db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, 'now')").run(REGIONS_REPORT_KEY, JSON.stringify(r))
}

describe('RegionStore', () => {
  it('creates, lists with host counts, updates and audits without values', async () => {
    const f = await makeInventory()
    const r = f.regions.create({ code: '  EU-West-1 ', provider: 'aws', displayName: 'Ireland' })
    expect(r).toMatchObject({ code: 'eu-west-1', provider: 'aws', displayName: 'Ireland', hostCount: 0 })
    f.hosts.create({ regionId: r.id, label: 'web', address: 'web.example.com' })
    expect(f.regions.list().map((x) => [x.code, x.hostCount])).toEqual([
      ['eu-west-1', 1],
      ['test-1', 0],
    ])
    expect(f.regions.update(r.id, { displayName: 'Dublin', provider: '' })).toMatchObject({ displayName: 'Dublin', provider: '' })
    f.regions.update(r.id, { displayName: 'Dublin' })
    expect(actions(f, 'region.create')[0]).toMatchObject({ targetId: r.id, targetLabel: 'eu-west-1' })
    expect(actions(f, 'region.update').map((e) => e.details)).toEqual([{ fields: ['provider', 'displayName'] }])
    expect(JSON.stringify(actions(f, 'region.update'))).not.toContain('Dublin')
  })

  it('checks codes, providers, names and uniqueness', async () => {
    const f = await makeInventory()
    for (const code of ['', '-eu', 'eu_west', 'eu west', 'x'.repeat(64)]) {
      expect(() => f.regions.create({ code, displayName: 'X' })).toThrow(/region code must be/)
    }
    expect(() => f.regions.create({ code: 'TEST-1', displayName: 'X' })).toThrow('a region with that code already exists')
    expect(() => f.regions.create({ code: 'ok', provider: 'p'.repeat(65), displayName: 'X' })).toThrow(/provider/)
    expect(() => f.regions.create({ code: 'ok', displayName: '' })).toThrow(/region name/)
    const other = f.regions.create({ code: 'other', displayName: 'Other' })
    expect(() => f.regions.update(other.id, { code: 'Test-1' })).toThrow('a region with that code already exists')
    expect(() => f.regions.update(randomUUID(), { code: 'x' })).toThrow(/region not found/)
  })

  it('refuses to delete a region that hosts use', async () => {
    const f = await makeInventory()
    const r = f.regions.create({ code: 'us-east-1', displayName: 'Virginia' })
    const h = f.hosts.create({ regionId: r.id, label: 'web', address: 'web.example.com' })
    f.hosts.create({ regionId: r.id, label: 'db', address: 'db.example.com' })
    expect(() => f.regions.delete(r.id)).toThrow('us-east-1 still has 2 hosts: move them to another region first')
    f.hosts.update(h.id, { regionId: REGION })
    expect(() => f.regions.delete(r.id)).toThrow('us-east-1 still has a host: move it to another region first')
    expect(actions(f, 'region.delete')).toHaveLength(0)
    const empty = f.regions.create({ code: 'empty', displayName: 'Empty' })
    f.regions.delete(empty.id)
    expect(f.regions.list().map((x) => x.code)).not.toContain('empty')
    expect(actions(f, 'region.delete')[0]).toMatchObject({ targetId: empty.id, targetLabel: 'empty' })
  })

  it('needs a region for every host, and lets a host move between regions', async () => {
    const f = await makeInventory()
    expect(() => f.hosts.create({ regionId: '', label: 'a', address: 'a.example.com' })).toThrow('a host needs a region')
    expect(() => f.hosts.create({ regionId: randomUUID(), label: 'a', address: 'a.example.com' })).toThrow('region not found')
    const r = f.regions.create({ code: 'ap-south-1', displayName: 'Mumbai' })
    const h = f.hosts.create({ regionId: REGION, label: 'a', address: 'a.example.com' })
    expect(h.regionId).toBe(REGION)
    expect(f.hosts.update(h.id, { regionId: r.id }).regionId).toBe(r.id)
    expect(actions(f, 'host.update').at(-1)!.details).toEqual({ fields: ['regionId'] })
    expect(() => f.hosts.update(h.id, { regionId: randomUUID() })).toThrow('region not found')
  })

  it('refuses writes while locked; list and the upgrade report work locked', async () => {
    const f = await makeInventory()
    putReport(f)
    f.vault.lock('manual')
    expect(() => f.regions.create({ code: 'x', displayName: 'X' })).toThrow(VAULT_LOCKED)
    expect(() => f.regions.update(REGION, { displayName: 'X' })).toThrow(VAULT_LOCKED)
    expect(() => f.regions.delete(REGION)).toThrow(VAULT_LOCKED)
    expect(f.regions.list()).toHaveLength(1)
    expect(f.regions.upgradeReport()).toEqual(REPORT)
    f.regions.dismissUpgradeReport()
    expect(f.regions.upgradeReport()).toBeNull()
  })

  it('has no upgrade report when the upgrade had nothing to say', async () => {
    const f = await makeInventory()
    expect(f.regions.upgradeReport()).toBeNull()
  })
})

describe('region IPC', () => {
  it('validates at the boundary and reaches the store', async () => {
    const f = await makeInventory()
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(inventoryHandlers(f)),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    for (const [c, ...a] of [
      ['region:create', { code: 'eu_west', displayName: 'X' }],
      ['region:create', { code: 'ok', displayName: 'X', extra: 1 }],
      ['region:create', { code: 'ok' }],
      ['region:update', 'nope', { displayName: 'X' }],
      ['region:delete', 'nope'],
      ['host:create', { label: 'a', address: 'a.example.com' }],
    ] as [string, ...unknown[]][]) {
      await expect(call(c, ...a)).rejects.toThrow(/invalid arguments/)
    }
    const r = (await call('region:create', { code: 'EU-1', provider: 'aws', displayName: 'EU' })) as { id: string; code: string }
    expect(r.code).toBe('eu-1')
    await call('region:update', r.id, { displayName: 'Europe' })
    expect(((await call('region:list')) as { code: string }[]).map((x) => x.code)).toEqual(['eu-1', 'test-1'])
    expect(await call('region:upgradeReport')).toBeNull()
    await call('region:dismissUpgradeReport')
    await call('region:delete', r.id)
    await expect(call('region:delete', REGION)).resolves.toBeUndefined()
  })
})
