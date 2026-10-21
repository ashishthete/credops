import { describe, expect, it } from 'vitest'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import { buildGraph } from '../../src/renderer/src/map/graph'
import { searchGraph } from '../../src/renderer/src/map/search'
import { environment, host, product } from './helpers'

const data: InventoryData = {
  products: [product({ id: 'p1', name: 'Web' })],
  environments: [
    environment({
      id: 'e1',
      name: 'Prod',
      productId: 'p1',
      hosts: [
        { hostId: 'h1', role: 'app' },
        { hostId: 'h2', role: 'db' },
        { hostId: 'h3', role: 'app' },
      ],
    }),
    environment({ id: 'e2', name: 'Stage', productId: 'p1', hosts: [{ hostId: 'h1', role: 'app' }] }),
  ],
  hosts: [
    host({ id: 'h1', label: 'api-gateway', address: '10.0.0.5', tags: ['frontend'] }),
    host({ id: 'h2', label: 'pg', address: 'db.internal', tags: ['postgres'] }),
    host({ id: 'h3', label: 'worker', address: '10.0.9.9', tags: [] }),
  ],
  identities: [],
  vaults: [],
  regions: [],
}
const graph = buildGraph({ data, tunnels: [], scope: { kind: 'all' } })

describe('searchGraph', () => {
  it('matches hosts by label, address and tag', () => {
    expect(searchGraph(graph, 'worker').matches).toEqual(['e:e1/h:h3'])
    expect(searchGraph(graph, '10.0.0.5').matches).toEqual(['e:e1/h:h1', 'e:e2/h:h1'])
    expect(searchGraph(graph, 'postgres').matches).toEqual(['e:e1/h:h2'])
    // Product and environment names are searchable too.
    expect(searchGraph(graph, 'stage').matches).toEqual(['e:e2'])
    expect(searchGraph(graph, 'web').matches).toContain('p:p1')
  })

  it('best prefers the highest score, then node order', () => {
    // `api-gateway` (h1) comes first in node order, but the exact label `pg` scores higher.
    const pg = searchGraph(graph, 'pg')
    expect(pg.matches).toContain('e:e1/h:h1')
    expect(pg.best).toBe('e:e1/h:h2')
    expect(pg.matches[0]).toBe('e:e1/h:h2')
    // The same host in two environments scores the same; the earlier placement wins.
    const gw = searchGraph(graph, 'gateway')
    expect(gw.matches).toEqual(['e:e1/h:h1', 'e:e2/h:h1'])
    expect(gw.best).toBe('e:e1/h:h1')
  })

  it('empty query matches nothing', () => {
    expect(searchGraph(graph, '')).toEqual({ matches: [], best: null })
    expect(searchGraph(graph, '   ')).toEqual({ matches: [], best: null })
    expect(searchGraph(graph, 'zzzz')).toEqual({ matches: [], best: null })
  })
})
