import { describe, expect, it } from 'vitest'
import { buildGraph } from '../../src/renderer/src/map/graph'
import { flowEdges } from '../../src/renderer/src/map/MapCanvas'
import { environment, host, product, tunnelMeta } from './helpers'

describe('tunnel edge handles', () => {
  it('L and D tunnels enter the host from the Mac side; R leaves it as before', () => {
    const graph = buildGraph({
      data: {
        products: [product({ id: 'p1', name: 'Web' })],
        environments: [environment({ id: 'e1', name: 'Prod', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })],
        hosts: [host({ id: 'h1', label: 'web' })],
        identities: [],
        vaults: [],
      },
      tunnels: [
        tunnelMeta({ id: 'tl', hostId: 'h1', environmentId: 'e1', type: 'L' }),
        tunnelMeta({ id: 'td', hostId: 'h1', environmentId: 'e1', type: 'D', targetHost: null, targetPort: null }),
        tunnelMeta({ id: 'tr', hostId: 'h1', environmentId: 'e1', type: 'R' }),
      ],
      scope: { kind: 'all' },
    })
    const edge = (tunnelId: string) => flowEdges(graph).find((e) => e.data?.kind === 'tunnel' && e.data.tunnelId === tunnelId)!
    for (const id of ['tl', 'td']) {
      // Still drawn from the Mac, so the flow runs the way the traffic does.
      expect(edge(id)).toMatchObject({ source: 'mac', target: 'e:e1/h:h1', targetHandle: 'mac' })
      expect(edge(id).sourceHandle).toBeUndefined()
    }
    expect(edge('tr')).toMatchObject({ source: 'e:e1/h:h1', target: 'mac' })
    expect(edge('tr').targetHandle).toBeUndefined()
    expect(edge('tr').sourceHandle).toBeUndefined()
  })
})
