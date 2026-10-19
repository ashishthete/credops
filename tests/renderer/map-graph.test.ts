import { describe, expect, it } from 'vitest'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import { buildGraph, parseScope, scopeKey, type HostNodeData, type MapScope } from '../../src/renderer/src/map/graph'
import { environment, host, product, tunnelMeta } from './helpers'

const ALL: MapScope = { kind: 'all' }
const empty: InventoryData = { products: [], environments: [], hosts: [], identities: [], vaults: [] }
const ids = (g: ReturnType<typeof buildGraph>) => g.nodes.map((n) => n.id)
const build = (data: InventoryData, scope: MapScope = ALL, tunnels = [] as ReturnType<typeof tunnelMeta>[]) => buildGraph({ data, tunnels, scope })

function basic(): InventoryData {
  return {
    ...empty,
    products: [product({ id: 'p1', name: 'Web' })],
    environments: [
      environment({ id: 'e1', name: 'Prod', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] }),
      environment({ id: 'e2', name: 'Stage', productIds: ['p1'], hosts: [{ hostId: 'h3', role: 'db' }] }),
    ],
    hosts: [
      host({ id: 'h1', label: 'alpha', environments: [{ environmentId: 'e1', role: 'app' }] }),
      host({ id: 'h2', label: 'beta', environments: [{ environmentId: 'e1', role: 'app' }] }),
      host({ id: 'h3', label: 'gamma', environments: [{ environmentId: 'e2', role: 'db' }] }),
    ],
  }
}

describe('buildGraph', () => {
  it('builds products, environment groups and host placements', () => {
    const g = build(basic())
    expect(ids(g)).toEqual(['p:p1', 'e:e1', 'e:e1/h:h1', 'e:e1/h:h2', 'e:e2', 'e:e2/h:h3'])
    for (const n of g.nodes.filter((n) => n.data.kind === 'host')) expect(n.parentId).toBe(n.id.split('/')[0])
  })

  it('orders hosts by role, then label', () => {
    const d = basic()
    d.environments = [
      environment({
        id: 'e1', name: 'Prod', productIds: ['p1'],
        hosts: [{ hostId: 'h1', role: 'other' }, { hostId: 'h2', role: 'db' }, { hostId: 'h3', role: 'app' }, { hostId: 'h4', role: 'bastion' }],
      }),
    ]
    d.hosts = ['h1', 'h2', 'h3', 'h4'].map((id) => host({ id, label: `z${id}` }))
    expect(ids(build(d)).filter((i) => i.includes('/h:'))).toEqual(['e:e1/h:h4', 'e:e1/h:h3', 'e:e1/h:h2', 'e:e1/h:h1'])
  })

  it('a shared host gets one placement per environment', () => {
    const d = basic()
    d.environments[1].hosts.push({ hostId: 'h1', role: 'app' })
    d.hosts[0].environments.push({ environmentId: 'e2', role: 'app' })
    const hosts = build(d).nodes.filter((n) => n.data.kind === 'host' && n.data.hostId === 'h1')
    expect(hosts.map((n) => n.id)).toEqual(['e:e1/h:h1', 'e:e2/h:h1'])
    expect(hosts.map((n) => (n.data as HostNodeData).sharedCount)).toEqual([2, 2])
  })

  it('an environment in two products sits under its primary product only', () => {
    const d = basic()
    d.products.push(product({ id: 'pB', name: 'Api' }))
    d.products[0] = product({ id: 'pA', name: 'Web' })
    d.environments[0].productIds = ['pB', 'pA']
    d.environments = [d.environments[0]]
    const g = build(d)
    expect(g.nodes.filter((n) => n.id === 'e:e1')).toHaveLength(1)
    const m = Object.fromEntries(g.edges.filter((e) => e.data.kind === 'membership').map((e) => [e.id, e.data]))
    expect(m['m:pA>e:e1']).toEqual({ kind: 'membership', primary: true })
    expect(m['m:pB>e:e1']).toEqual({ kind: 'membership', primary: false })
  })

  it('hosts in no environment land in the unassigned group', () => {
    const d = basic()
    expect(ids(build(d))).not.toContain('u')
    d.hosts.push(host({ id: 'h9', label: 'loose' }))
    const g = build(d)
    expect(ids(g)).toContain('u')
    expect(ids(g)).toContain('u/h:h9')
    expect(g.nodes.find((n) => n.id === 'u/h:h9')?.parentId).toBe('u')
    expect((g.nodes.find((n) => n.id === 'u/h:h9')!.data as HostNodeData).role).toBeNull()
    expect(ids(build(d, { kind: 'product', productId: 'p1' }))).not.toContain('u')
  })

  it('an environment with no product is its own group with no edge', () => {
    const d = basic()
    d.environments[1].productIds = []
    const g = build(d)
    expect(ids(g)).toContain('e:e2')
    expect(g.edges.some((e) => e.target === 'e:e2')).toBe(false)
  })

  it('jump resolves host first, then environment default', () => {
    const d = basic()
    d.environments[0].hosts = [{ hostId: 'h1', role: 'bastion' }, { hostId: 'h2', role: 'app' }]
    d.hosts[1].jumpHostId = 'h1'
    let e = build(d).edges.filter((x) => x.data.kind === 'jump')
    expect(e.map((x) => x.id)).toEqual(['j:e:e1/h:h1>e:e1/h:h2'])
    expect(e[0].data).toEqual({ kind: 'jump', viaEnvDefault: false })
    d.hosts[1].jumpHostId = null
    d.environments[0].defaultJumpHostId = 'h1'
    e = build(d).edges.filter((x) => x.data.kind === 'jump')
    expect(e.map((x) => x.id)).toEqual(['j:e:e1/h:h1>e:e1/h:h2'])
    expect(e[0].data).toEqual({ kind: 'jump', viaEnvDefault: true })
  })

  it('a jump host outside the scope becomes a chip, not an edge', () => {
    const d = basic()
    d.hosts.push(host({ id: 'hb', label: 'bastion', environments: [{ environmentId: 'e2', role: 'bastion' }] }))
    d.environments[1].hosts.push({ hostId: 'hb', role: 'bastion' })
    d.hosts[0].jumpHostId = 'hb'
    const g = build(d, { kind: 'environment', environmentId: 'e1' })
    expect(g.edges.some((x) => x.id.startsWith('j:'))).toBe(false)
    expect((g.nodes.find((n) => n.id === 'e:e1/h:h1')!.data as HostNodeData).jumpLabel).toBe('bastion')
    expect(build(d).edges.some((x) => x.id.startsWith('j:'))).toBe(true)
  })

  it('tunnel direction follows traffic', () => {
    const d = basic()
    const edge = (type: 'L' | 'R' | 'D') => build(d, ALL, [tunnelMeta({ id: 't1', hostId: 'h1', type })]).edges.find((e) => e.id === 't:t1')!
    expect(edge('L')).toMatchObject({ source: 'mac', target: 'e:e1/h:h1' })
    expect(edge('R')).toMatchObject({ source: 'e:e1/h:h1', target: 'mac' })
    expect(edge('D')).toMatchObject({ source: 'mac', target: 'e:e1/h:h1' })
    expect(build(d, ALL, [tunnelMeta({ id: 't1', hostId: 'h1' })]).nodes.at(-1)!.data).toEqual({ kind: 'mac', tunnelCount: 1 })
  })

  it("a tunnel attaches to its environment's placement", () => {
    const d = basic()
    d.environments[1].hosts.push({ hostId: 'h1', role: 'app' })
    d.hosts[0].environments.push({ environmentId: 'e2', role: 'app' })
    const t = (environmentId: string | null) => build(d, ALL, [tunnelMeta({ id: 't1', hostId: 'h1', environmentId })]).edges.find((e) => e.id === 't:t1')!
    expect(t('e2').target).toBe('e:e2/h:h1')
    expect(t(null).target).toBe('e:e1/h:h1')
  })

  it('a tunnel whose host is out of scope is omitted', () => {
    const g = build(basic(), { kind: 'environment', environmentId: 'e2' }, [tunnelMeta({ id: 't1', hostId: 'h1' })])
    expect(g.edges.some((e) => e.id === 't:t1')).toBe(false)
    expect(ids(g)).not.toContain('mac')
  })

  it("product scope keeps only that product's environments", () => {
    const d = basic()
    d.products.push(product({ id: 'p2', name: 'Api' }))
    d.environments.push(environment({ id: 'e3', name: 'Other', productIds: ['p2'] }))
    const g = build(d, { kind: 'product', productId: 'p1' })
    expect(ids(g)).toEqual(['p:p1', 'e:e1', 'e:e1/h:h1', 'e:e1/h:h2', 'e:e2', 'e:e2/h:h3'])
  })

  it('environment scope shows the environment and all its products', () => {
    const d = basic()
    d.products.push(product({ id: 'p2', name: 'Api' }), product({ id: 'p3', name: 'Zed' }))
    d.environments[0].productIds = ['p1', 'p2']
    const g = build(d, { kind: 'environment', environmentId: 'e1' })
    expect(ids(g)).toEqual(['p:p2', 'p:p1', 'e:e1', 'e:e1/h:h1', 'e:e1/h:h2'])
  })

  it('resolves vault names and skips unknown ids', () => {
    const d = basic()
    d.vaults = [{ id: 'v1', name: 'Team' } as never]
    d.hosts[0].vaultIds = ['v1', 'gone']
    expect((build(d).nodes.find((n) => n.id === 'e:e1/h:h1')!.data as HostNodeData).vaultNames).toEqual(['Team'])
  })

  it('never emits an edge to a missing node', () => {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed % n
    }
    const pick = <T,>(xs: T[]): T | null => (xs.length ? xs[rnd(xs.length)] : null)
    for (let i = 0; i < 50; i++) {
      const products = Array.from({ length: rnd(4) }, (_, k) => product({ id: `p${k}`, name: `P${rnd(9)}` }))
      const hostIds = Array.from({ length: rnd(8) }, (_, k) => `h${k}`)
      const environments = Array.from({ length: rnd(5) }, (_, k) =>
        environment({
          id: `e${k}`, name: `E${rnd(9)}`,
          productIds: products.filter(() => rnd(2) === 0).map((p) => p.id).concat(rnd(5) === 0 ? ['ghost'] : []),
          defaultJumpHostId: rnd(2) ? pick(hostIds) : null,
          hosts: hostIds.filter(() => rnd(2) === 0).map((hostId) => ({ hostId, role: 'app' as const })),
        }),
      )
      const hosts = hostIds.map((id) =>
        host({
          id, label: `H${rnd(9)}`, jumpHostId: rnd(3) === 0 ? pick(hostIds) : null,
          environments: environments.filter((e) => e.hosts.some((m) => m.hostId === id)).map((e) => ({ environmentId: e.id, role: 'app' as const })),
        }),
      )
      const tunnels = Array.from({ length: rnd(4) }, (_, k) =>
        tunnelMeta({ id: `t${k}`, hostId: pick(hostIds) ?? 'nope', environmentId: rnd(2) ? pick(environments.map((e) => e.id)) : null, type: (['L', 'R', 'D'] as const)[rnd(3)] }),
      )
      const scopes: MapScope[] = [ALL]
      const p = pick(products)
      const e = pick(environments)
      if (p) scopes.push({ kind: 'product', productId: p.id })
      if (e) scopes.push({ kind: 'environment', environmentId: e.id })
      const g = buildGraph({ data: { ...empty, products, environments, hosts }, tunnels, scope: scopes[rnd(scopes.length)] })
      const known = new Set(g.nodes.map((n) => n.id))
      expect(known.size).toBe(g.nodes.length)
      expect(new Set(g.edges.map((x) => x.id)).size).toBe(g.edges.length)
      for (const x of g.edges) {
        expect(known.has(x.source)).toBe(true)
        expect(known.has(x.target)).toBe(true)
      }
      for (const n of g.nodes) if (n.parentId) expect(known.has(n.parentId)).toBe(true)
    }
  })

  it('node data carries no private fields', () => {
    const d = basic()
    d.hosts[0].notes = 'SENTINEL-NOTES'
    d.hosts[0].envVars = { TOKEN: 'SENTINEL-ENV' }
    d.hosts[0].identityId = 'i1'
    d.identities = [{ id: 'i1', label: 'deploy', username: 'SENTINEL-USER', fingerprint: 'SENTINEL-FP' } as never]
    const json = JSON.stringify(build(d, ALL, [tunnelMeta({ id: 't1', hostId: 'h1' })]))
    for (const s of ['SENTINEL-NOTES', 'SENTINEL-ENV', 'SENTINEL-USER', 'SENTINEL-FP']) expect(json).not.toContain(s)
  })
})

describe('parseScope', () => {
  it('prefers env and falls back to all on unknown ids', () => {
    const d = basic()
    const q = (s: string) => parseScope(new URLSearchParams(s), d)
    expect(q('product=p1&env=e2')).toEqual({ kind: 'environment', environmentId: 'e2' })
    expect(q('product=p1')).toEqual({ kind: 'product', productId: 'p1' })
    expect(q('env=nope')).toEqual(ALL)
    expect(q('product=nope')).toEqual(ALL)
    expect(q('')).toEqual(ALL)
  })

  it('scopeKey', () => {
    expect([ALL, { kind: 'product', productId: 'p1' }, { kind: 'environment', environmentId: 'e1' }].map((s) => scopeKey(s as MapScope))).toEqual(['all', 'p:p1', 'e:e1'])
  })
})
