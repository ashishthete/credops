import { describe, expect, it } from 'vitest'
import { addressSourceLabel, identityChoices, jumpHostChoices, sourceLabel } from '../../src/renderer/src/inventory/choices'
import { buildTree, moveFocus, selectionFromKey, type TreeService } from '../../src/renderer/src/inventory/tree'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import type { IdentityMeta } from '../../src/shared/vault'
import { defaultVault, environment, host, product, REGION } from './helpers'

const data = (): InventoryData => ({
  products: [
    product({ id: 'p2', name: 'Essentials', environmentIds: [] }),
    product({ id: 'p1', name: 'Acme', environmentIds: ['shared', 'prod'] }),
  ],
  environments: [
    environment({ id: 'prod', name: 'prod', productId: 'p1', hosts: [{ hostId: 'web', role: 'app' }, { hostId: 'bast', role: 'bastion' }] }),
    environment({ id: 'shared', name: 'analytics-db', productId: 'p1' }),
  ],
  hosts: [
    host({ id: 'web', label: 'web-1', environments: [{ environmentId: 'prod', role: 'app' }] }),
    host({ id: 'bast', label: 'bastion', environments: [{ environmentId: 'prod', role: 'bastion' }] }),
    host({ id: 'orph', label: 'orphan' }),
  ],
  identities: [],
  vaults: [],
  regions: [],
})

const all = new Set(['p:p1', 'p:p2', 'p:p1/e:prod', 'p:p1/e:shared', 'u'])

/** prod runs an app on web-1, a database on web-1 and a bastion on bastion. */
const services: TreeService[] = [
  { id: 'db', environmentId: 'prod', hostId: 'web', name: 'main-db', kind: 'db', position: 0 },
  { id: 'api', environmentId: 'prod', hostId: 'web', name: 'api', kind: 'service', position: 1 },
  { id: 'jump', environmentId: 'prod', hostId: 'bast', name: 'jump', kind: 'bastion', position: 2 },
]

const HINT = 'No services — drag a host here'

describe('inventory tree', () => {
  it('builds the product tree', () => {
    const d = data()
    const rows = buildTree(d, all, services)
    // Services by type: bastions, apps, databases.
    expect(rows.map((r) => r.label)).toEqual([
      'Acme', 'analytics-db', HINT, 'prod', 'jump', 'api', 'main-db', 'Essentials', 'Unassigned hosts', 'orphan',
    ])
    const api = rows.find((r) => r.label === 'api')!
    expect(api).toMatchObject({ kind: 'service', key: 'p:p1/e:prod/s:api', serviceKind: 'service', hostId: 'web', hostLabel: 'web-1', depth: 2 })
    expect(rows.find((r) => r.label === 'prod')!.childCount).toBe(3)
    // Hosts in environments are not rows; only unassigned ones are.
    expect(rows.filter((r) => r.kind === 'host').map((r) => r.key)).toEqual(['u/h:orph'])
  })

  it('collapsed hides children', () => {
    expect(buildTree(data(), new Set()).map((r) => r.label)).toEqual(['Acme', 'Essentials', 'Unassigned hosts'])
  })

  it('keyboard moves', () => {
    const d = data()
    const collapsed = buildTree(d, new Set())
    expect(moveFocus(collapsed, 'p:p1', 'ArrowRight')).toEqual({ focus: 'p:p1', toggle: 'p:p1' })
    const rows = buildTree(d, all, services)
    expect(moveFocus(rows, 'p:p1', 'ArrowRight')).toEqual({ focus: 'p:p1/e:shared' })
    expect(moveFocus(rows, 'p:p1/e:prod/s:api', 'ArrowLeft')).toEqual({ focus: 'p:p1/e:prod' })
    // The hint is skipped.
    expect(moveFocus(rows, 'p:p1/e:shared', 'ArrowDown')).toEqual({ focus: 'p:p1/e:prod' })
    expect(moveFocus(rows, 'p:p1/e:prod', 'Home').focus).toBe('p:p1')
    expect(moveFocus(rows, 'p:p1', 'End').focus).toBe('u/h:orph')
  })

  it("every service row carries its host's region, loose hosts too", () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    const d = data()
    const split = buildTree({ ...d, regions: [REGION, us], hosts: d.hosts.map((h) => (h.id === 'bast' ? { ...h, regionId: us.id } : h)) }, all, services)
    expect(split.filter((r) => r.region).map((r) => [r.label, r.region!.code])).toEqual([
      ['jump', 'us-east-1'],
      ['api', 'test-1'],
      ['main-db', 'test-1'],
      ['orphan', 'test-1'],
    ])
    expect(split.find((r) => r.label === 'prod')!.region).toBeUndefined()
    expect(split.some((r) => r.regionOnParent)).toBe(false)

    // One region for the whole environment: its row carries the chip, its hosts point up to it.
    const one = buildTree({ ...d, regions: [REGION] }, all, services)
    expect(one.find((r) => r.label === 'prod')!.region?.code).toBe('test-1')
    expect(one.filter((r) => r.regionOnParent).map((r) => r.label)).toEqual(['jump', 'api', 'main-db'])
    expect(one.find((r) => r.label === 'orphan')!.regionOnParent).toBeUndefined()
    expect(one.find((r) => r.label === 'analytics-db')!.region).toBeUndefined()
  })

  it('each environment shows once, under its product', () => {
    const d = data()
    const rows = buildTree({ ...d, products: d.products.map((p) => ({ ...p, environmentIds: ['prod'] })) }, all)
    expect(rows.filter((r) => r.label === 'prod')).toHaveLength(1)
  })

  it('maps keys to selections', () => {
    expect(selectionFromKey('p:p1/e:prod/s:api')).toEqual({ productId: 'p1', environmentId: 'prod', serviceId: 'api' })
    expect(selectionFromKey('u/h:orph')).toEqual({ hostId: 'orph' })
    expect(selectionFromKey('u')).toEqual({})
  })
})

const identity = (id: string, vaultId: string): IdentityMeta => ({
  id, vaultId, label: id, username: 'root', auth: 'password', sshKeyId: null, hasPassword: true, createdAt: '', updatedAt: '',
})

describe('picker choices', () => {
  const vaults = [
    { ...defaultVault, id: 'v1', name: 'Default' },
    { ...defaultVault, id: 'v2', name: 'Ops', isDefault: false },
    { ...defaultVault, id: 'v3', name: 'Broken', isDefault: false },
  ]
  const ids = [identity('a', 'v1'), identity('b', 'v2'), identity('c', 'v3')]

  it('identity choices', () => {
    const g = identityChoices(ids, vaults, ['v1'], ['v3'])
    expect(g.map((x) => x.group)).toEqual(['Linked vaults', 'Other vaults'])
    expect(g.map((x) => x.vault.name)).toEqual(['Default', 'Ops'])
    expect(new Set(identityChoices(ids, vaults, [], ['v3']).map((x) => x.group))).toEqual(new Set(['Other vaults']))
  })

  it('jump choices', () => {
    const hosts = [host({ id: 'A', label: 'a', jumpHostId: 'B' }), host({ id: 'B', label: 'b' }), host({ id: 'C', label: 'c' })]
    expect(jumpHostChoices(hosts, 'B').map((h) => h.id)).toEqual(['C'])
    expect(jumpHostChoices(hosts, null)).toHaveLength(3)
  })

  it('source labels', () => {
    expect(sourceLabel('host')).toBe('From this host')
    expect(sourceLabel('environment', 'prod')).toBe('Inherited from prod')
    expect(sourceLabel('environment')).toBe('Inherited from environment')
    expect(sourceLabel('global')).toBe('App default')
    expect(sourceLabel(null)).toBe('None')
  })
})

describe('addressSourceLabel', () => {
  it('names where the dialled address came from', () => {
    expect(addressSourceLabel('domain', 'staging')).toBe("From staging's domain")
    expect(addressSourceLabel('domain')).toBe("From environment's domain")
    expect(addressSourceLabel('host')).toBe('From this host')
  })
})
