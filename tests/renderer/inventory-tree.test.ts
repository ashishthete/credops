import { describe, expect, it } from 'vitest'
import { identityChoices, jumpHostChoices, sourceLabel } from '../../src/renderer/src/inventory/choices'
import { buildTree, moveFocus, selectionFromKey } from '../../src/renderer/src/inventory/tree'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import type { IdentityMeta } from '../../src/shared/vault'
import { defaultVault, environment, host, product } from './helpers'

const data = (): InventoryData => ({
  products: [
    product({ id: 'p2', name: 'Essentials', environmentIds: ['shared'] }),
    product({ id: 'p1', name: 'Acme', environmentIds: ['shared', 'prod'] }),
  ],
  environments: [
    environment({ id: 'prod', name: 'prod', productIds: ['p1'], hosts: [{ hostId: 'web', role: 'app' }, { hostId: 'bast', role: 'bastion' }] }),
    environment({ id: 'shared', name: 'analytics-db', productIds: ['p1', 'p2'] }),
  ],
  hosts: [
    host({ id: 'web', label: 'web-1', environments: [{ environmentId: 'prod', role: 'app' }] }),
    host({ id: 'bast', label: 'bastion', environments: [{ environmentId: 'prod', role: 'bastion' }] }),
    host({ id: 'orph', label: 'orphan' }),
  ],
  identities: [],
  vaults: [],
})

const all = new Set(['p:p1', 'p:p2', 'p:p1/e:prod', 'p:p1/e:shared', 'p:p2/e:shared', 'u'])

const HINT = 'No hosts — drag one here'

describe('inventory tree', () => {
  it('builds the product tree', () => {
    const d = data()
    const rows = buildTree(d, all)
    expect(rows.map((r) => r.label)).toEqual([
      'Acme', 'analytics-db', HINT, 'prod', 'bastion', 'web-1', 'Essentials', 'analytics-db', HINT, 'Unassigned', 'orphan',
    ])
    expect(rows.filter((r) => r.label === 'analytics-db').map((r) => r.sharedCount)).toEqual([1, 1])
  })

  it('collapsed hides children', () => {
    expect(buildTree(data(), new Set()).map((r) => r.label)).toEqual(['Acme', 'Essentials', 'Unassigned'])
  })

  it('keyboard moves', () => {
    const d = data()
    const collapsed = buildTree(d, new Set())
    expect(moveFocus(collapsed, 'p:p1', 'ArrowRight')).toEqual({ focus: 'p:p1', toggle: 'p:p1' })
    const rows = buildTree(d, all)
    expect(moveFocus(rows, 'p:p1', 'ArrowRight')).toEqual({ focus: 'p:p1/e:shared' })
    expect(moveFocus(rows, 'p:p1/e:prod/h:web', 'ArrowLeft')).toEqual({ focus: 'p:p1/e:prod' })
    expect(moveFocus(rows, 'p:p1/e:prod', 'Home').focus).toBe('p:p1')
    expect(moveFocus(rows, 'p:p1', 'End').focus).toBe('u/h:orph')
  })

  it('maps keys to selections', () => {
    expect(selectionFromKey('p:p1/e:prod/h:web')).toEqual({ productId: 'p1', environmentId: 'prod', hostId: 'web' })
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
