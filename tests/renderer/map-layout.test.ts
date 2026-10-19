import { describe, expect, it } from 'vitest'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import { buildGraph, type MapScope } from '../../src/renderer/src/map/graph'
import {
  COL_GAP, GAP, GROUP_HEADER, GROUP_PAD, HOST_H, HOST_W, MAC_H, PRODUCT_H, PRODUCT_W, ROW_GAP,
  diffLayout, layoutGraph, type MapLayout, type Placed,
} from '../../src/renderer/src/map/layout'
import { environment, host, product, tunnelMeta } from './helpers'

const ALL: MapScope = { kind: 'all' }
const empty: InventoryData = { products: [], environments: [], hosts: [], identities: [], vaults: [] }

function inventory(envs: { id: string; name: string; productIds: string[]; hostIds: string[] }[], products: string[] = []): InventoryData {
  const hostIds = [...new Set(envs.flatMap((e) => e.hostIds))]
  return {
    ...empty,
    products: products.map((id) => product({ id, name: id.toUpperCase() })),
    environments: envs.map((e) => environment({ id: e.id, name: e.name, productIds: e.productIds, hosts: e.hostIds.map((hostId) => ({ hostId, role: 'app' as const })) })),
    hosts: hostIds.map((id) => host({ id, label: id })),
  }
}
const layout = (data: InventoryData, tunnels: ReturnType<typeof tunnelMeta>[] = [], pins = {}) =>
  layoutGraph(buildGraph({ data, tunnels, scope: ALL }), pins)
const hosts = (n: number, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

describe('layoutGraph', () => {
  it('packs four hosts in a 2×2 grid inside the group', () => {
    const l = layout(inventory([{ id: 'e1', name: 'Prod', productIds: [], hostIds: ['h1', 'h2', 'h3', 'h4'] }]))
    const at = (id: string) => [l.positions[`e:e1/h:${id}`].x, l.positions[`e:e1/h:${id}`].y]
    expect(at('h1')).toEqual([16, 40])
    expect(at('h2')).toEqual([240, 40])
    expect(at('h3')).toEqual([16, 120])
    expect(at('h4')).toEqual([240, 120])
    expect(l.positions['e:e1']).toMatchObject({ width: 464, height: 200 })
    expect(l.positions['e:e1/h:h1']).toMatchObject({ width: HOST_W, height: HOST_H })
  })

  it('caps columns at six', () => {
    const l = layout(inventory([{ id: 'e1', name: 'Prod', productIds: [], hostIds: hosts(50) }]))
    const g = l.positions['e:e1']
    expect(g.width).toBe(2 * GROUP_PAD + 6 * HOST_W + 5 * GAP)
    expect(g.height).toBe(GROUP_HEADER + GROUP_PAD + 9 * HOST_H + 8 * GAP)
    expect(l.positions['e:e1/h:h006']).toMatchObject({ x: GROUP_PAD, y: GROUP_HEADER + HOST_H + GAP })
  })

  it('sizes an empty group as one host cell', () => {
    const l = layout(inventory([{ id: 'e1', name: 'Prod', productIds: [], hostIds: [] }]))
    expect(l.positions['e:e1'].width).toBe(2 * GROUP_PAD + HOST_W)
  })

  it('stacks groups under their primary product and centres the product', () => {
    const l = layout(
      inventory(
        [
          { id: 'e1', name: 'Prod', productIds: ['a'], hostIds: ['h1'] },
          { id: 'e2', name: 'Stage', productIds: ['a'], hostIds: ['h2'] },
          { id: 'e3', name: 'Prod', productIds: ['b'], hostIds: ['h3'] },
          { id: 'e4', name: 'Loose', productIds: [], hostIds: ['h4'] },
        ],
        ['a', 'b', 'c'],
      ),
    )
    const x = PRODUCT_W + COL_GAP
    expect(l.positions['e:e1']).toMatchObject({ x, y: 0, height: 120 })
    expect(l.positions['e:e2']).toMatchObject({ x, y: 120 + ROW_GAP })
    expect(l.positions['e:e3']).toMatchObject({ x, y: 2 * (120 + ROW_GAP) })
    expect(l.positions['p:a']).toMatchObject({ x: 0, y: (0 + 120 + ROW_GAP + 120) / 2 - PRODUCT_H / 2 })
    expect(l.positions['p:b'].y).toBe(2 * (120 + ROW_GAP) + 60 - PRODUCT_H / 2)
    // Product without groups is stacked after the previous one; product-less groups follow.
    expect(l.positions['p:c'].y).toBe(3 * (120 + ROW_GAP))
    expect(l.positions['e:e4'].y).toBe(3 * (120 + ROW_GAP) + PRODUCT_H + ROW_GAP)
  })

  it('places this Mac right of the widest group, centred on tunnelled hosts', () => {
    const data = inventory([
      { id: 'e1', name: 'Prod', productIds: [], hostIds: ['h1'] },
      { id: 'e2', name: 'Stage', productIds: [], hostIds: ['h2', 'h3', 'h4', 'h5'] },
    ])
    const l = layout(data, [tunnelMeta({ id: 't1', hostId: 'h1' }), tunnelMeta({ id: 't2', hostId: 'h2', type: 'R' })])
    const e2 = l.positions['e:e2']
    const h1 = l.positions['e:e1']
    const top = h1.y + GROUP_HEADER
    const bottom = e2.y + GROUP_HEADER + HOST_H
    expect(l.positions.mac.x).toBe(PRODUCT_W + COL_GAP + e2.width + COL_GAP)
    expect(l.positions.mac.y).toBe((top + bottom) / 2 - MAC_H / 2)
  })

  it('omits the Mac when nothing is tunnelled', () => {
    expect(layout(basic()).positions.mac).toBeUndefined()
  })

  it('is deterministic', () => {
    expect(layout(basic())).toEqual(layout(basic()))
  })

  it('an unrelated host added elsewhere does not move existing groups above it', () => {
    const before = layout(basic())
    const data = basic()
    data.hosts.push(host({ id: 'loose', label: 'loose' }))
    const after = layout(data)
    for (const id of Object.keys(before.positions)) expect(after.positions[id]).toEqual(before.positions[id])
    expect(after.positions['u']).toBeDefined()
  })

  it('pins override computed positions and are clamped inside the group', () => {
    const data = inventory([{ id: 'e1', name: 'Prod', productIds: [], hostIds: ['h1', 'h2'] }])
    const base = layout(data)
    const l = layout(data, [], {
      'e:e1': { x: 500, y: 300 },
      'e:e1/h:h1': { x: 9999, y: -50 },
      'e:e1/h:h2': { x: 40, y: 41 },
    })
    const g = base.positions['e:e1']
    expect(l.positions['e:e1']).toMatchObject({ x: 500, y: 300, width: g.width, height: g.height })
    expect(l.positions['e:e1/h:h1']).toMatchObject({ x: g.width - GROUP_PAD - HOST_W, y: GROUP_HEADER })
    expect(l.positions['e:e1/h:h2']).toMatchObject({ x: 40, y: 40 })
  })
})

function basic(): InventoryData {
  return inventory(
    [
      { id: 'e1', name: 'Prod', productIds: ['a'], hostIds: ['h1', 'h2'] },
      { id: 'e2', name: 'Stage', productIds: ['a'], hostIds: ['h3'] },
    ],
    ['a'],
  )
}

describe('diffLayout', () => {
  const lay = (items: [string, number, number][]): MapLayout => ({
    positions: Object.fromEntries(items.map(([id, x, y]) => [id, { id, x, y, width: 10, height: 10 }])),
    bounds: { width: 0, height: 0 },
  })

  it('reports entering, leaving and moved', () => {
    const prev = lay([['a', 0, 0], ['b', 0, 0], ['c', 0, 0], ['d', 0, 0]])
    const next = lay([['a', 0, 0], ['b', 0.4, 0], ['c', 0, 60], ['e', 0, 0]])
    expect(diffLayout(prev, next)).toEqual({ entering: ['e'], leaving: ['d'], moved: ['c'] })
  })

  it('counts a size change as moved, and treats no previous layout as all entering', () => {
    const prev = lay([['a', 0, 0]])
    const next = lay([['a', 0, 0]])
    next.positions.a = { ...next.positions.a, width: 11 }
    expect(diffLayout(prev, next).moved).toEqual(['a'])
    expect(diffLayout(null, next)).toEqual({ entering: ['a'], leaving: [], moved: [] })
  })

  it('reports exactly the added host, the removed host and the moved group', () => {
    const data = inventory(
      [
        { id: 'e1', name: 'A', productIds: [], hostIds: ['h1', 'h2', 'h3'] },
        { id: 'e2', name: 'B', productIds: [], hostIds: ['h4'] },
      ],
    )
    const prev = layout(data)
    const next = layout(data, [], { 'e:e2': { x: 900, y: 0 } })
    const d = diffLayout(prev, next)
    expect(d).toEqual({ entering: [], leaving: [], moved: ['e:e2'] })
  })
})

describe('performance and overlap', () => {
  function seeded(seed: number) {
    let s = seed
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  }

  function big(): InventoryData {
    const rnd = seeded(7)
    const ids = hosts(200)
    const envs = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, name: `env${i}`, productIds: [`p${i % 3}`], hostIds: [] as string[] }))
    ids.forEach((id) => envs[Math.floor(rnd() * 12)].hostIds.push(id))
    return inventory(envs, ['p0', 'p1', 'p2'])
  }

  const overlap = (a: Placed, b: Placed) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  it('200 hosts in 12 environments lay out without overlap in under 50 ms', () => {
    const data = big()
    let best = Infinity
    let result: MapLayout | undefined
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      result = layoutGraph(buildGraph({ data, tunnels: [], scope: ALL }))
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(50)
    const graph = buildGraph({ data, tunnels: [], scope: ALL })
    const all = Object.values(result!.positions)
    const groups = all.filter((p) => /^e:[^/]+$/.test(p.id))
    expect(groups).toHaveLength(12)
    expect(all.filter((p) => p.id.includes('/h:'))).toHaveLength(200)
    for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) {
      if (!a.id.includes('/') && !b.id.includes('/')) expect(overlap(a, b), `${a.id} x ${b.id}`).toBe(false)
    }
    for (const g of groups) {
      const kids = all.filter((p) => p.id.startsWith(`${g.id}/`))
      for (const [i, a] of kids.entries()) {
        expect(a.x >= 0 && a.y >= 0 && a.x + a.width <= g.width && a.y + a.height <= g.height).toBe(true)
        for (const b of kids.slice(i + 1)) expect(overlap(a, b), `${a.id} x ${b.id}`).toBe(false)
      }
    }
    expect(graph.nodes.every((n) => result!.positions[n.id])).toBe(true)
  })
})
