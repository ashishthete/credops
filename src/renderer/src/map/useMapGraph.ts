import { useMemo, useSyncExternalStore } from 'react'
import { useInventory } from '../inventory/store'
import { tunnelStore } from '../tunnels/store'
import { buildGraph, scopeKey, type MapGraph, type MapScope } from './graph'
import { layoutGraph, type MapLayout, type Pins } from './layout'

const NO_PINS: Pins = {}

// The metas keep their array identity across runtime and stats updates, so a state change never rebuilds.
const tunnelMetas = () => tunnelStore.get().tunnels

/** The graph and its layout for a scope; null until the inventory has loaded. */
export function useMapGraph(scope: MapScope, pins: Pins = NO_PINS): { graph: MapGraph; layout: MapLayout } | null {
  const data = useInventory()
  const metas = useSyncExternalStore(tunnelStore.subscribe, tunnelMetas)
  const key = scopeKey(scope)
  return useMemo(() => {
    if (!data) return null
    const graph = buildGraph({ data, tunnels: metas, scope })
    return { graph, layout: layoutGraph(graph, pins) }
    // `key` stands for `scope`: a new object for the same scope must not rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metas, key, pins])
}
