import { useMemo, useSyncExternalStore } from 'react'
import { useInventory, type InventoryData } from '../inventory/store'
import type { TunnelMeta } from '../../../shared/tunnels'
import { tunnelStore } from '../tunnels/store'
import { buildGraph, scopeKey, type MapGraph, type MapScope } from './graph'
import { layoutGraph, type MapLayout, type Pins } from './layout'

const NO_PINS: Pins = {}

// The metas keep their array identity across runtime and stats updates, so a state change never rebuilds.
const tunnelMetas = () => tunnelStore.get().tunnels

/** The tunnel metas the map draws; the same array until a tunnel is added, edited or removed. */
export const useTunnelMetas = (): TunnelMeta[] => useSyncExternalStore(tunnelStore.subscribe, tunnelMetas)

// The unfiltered graph is built once per inventory and tunnel list, whoever asks first: the canvas
// showing everything, or a search looking past the filter.
const fullGraphs = new WeakMap<InventoryData, WeakMap<TunnelMeta[], MapGraph>>()

/** The graph of everything, shared for the same inventory and tunnels. */
export function fullGraph(data: InventoryData, tunnels: TunnelMeta[]): MapGraph {
  let byTunnels = fullGraphs.get(data)
  if (!byTunnels) fullGraphs.set(data, (byTunnels = new WeakMap()))
  let graph = byTunnels.get(tunnels)
  if (!graph) byTunnels.set(tunnels, (graph = buildGraph({ data, tunnels, scope: { kind: 'all' } })))
  return graph
}

/** The graph and its layout for a scope; null until the inventory has loaded. */
export function useMapGraph(scope: MapScope, pins: Pins = NO_PINS): { graph: MapGraph; layout: MapLayout } | null {
  const data = useInventory()
  const metas = useTunnelMetas()
  const key = scopeKey(scope)
  return useMemo(() => {
    if (!data) return null
    const graph = scope.kind === 'all' ? fullGraph(data, metas) : buildGraph({ data, tunnels: metas, scope })
    return { graph, layout: layoutGraph(graph, pins) }
    // `key` stands for `scope`: a new object for the same scope must not rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metas, key, pins])
}
