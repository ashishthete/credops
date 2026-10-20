import { useMemo, useSyncExternalStore } from 'react'
import { useInventory, type InventoryData } from '../inventory/store'
import type { TunnelMeta } from '../../../shared/tunnels'
import { deployStore } from '../deploy/store'
import { tunnelStore } from '../tunnels/store'
import { buildAttachments, buildGraph, scopeKey, type MapAttachments, type MapGraph, type MapScope } from './graph'
import { layoutGraph, type MapLayout, type Pins } from './layout'

const NO_PINS: Pins = {}
const NO_ATTACHMENTS: MapAttachments = {}

// The metas keep their array identity across runtime and stats updates, so a state change never rebuilds.
const tunnelMetas = () => tunnelStore.get().tunnels

/** The tunnel metas the map draws; the same array until a tunnel is added, edited or removed. */
export const useTunnelMetas = (): TunnelMeta[] => useSyncExternalStore(tunnelStore.subscribe, tunnelMetas)

const services = () => deployStore.get().services
const deployments = () => deployStore.get().deployments

/** The services drawn on each host placement; the same object until the inventory, services or checkouts change. */
export function useMapAttachments(data: InventoryData | null): MapAttachments {
  const svc = useSyncExternalStore(deployStore.subscribe, services)
  const checkouts = useSyncExternalStore(deployStore.subscribe, deployments)
  return useMemo(() => (data && svc.length ? buildAttachments(data, svc, checkouts) : NO_ATTACHMENTS), [data, svc, checkouts])
}

// The unfiltered graph is built once per inventory, tunnel list and attachments, whoever asks first: the
// canvas showing everything, or a search looking past the filter.
const fullGraphs = new WeakMap<InventoryData, WeakMap<TunnelMeta[], WeakMap<MapAttachments, MapGraph>>>()

/** The graph of everything, shared for the same inventory, tunnels and attachments. */
export function fullGraph(data: InventoryData, tunnels: TunnelMeta[], attachments: MapAttachments = NO_ATTACHMENTS): MapGraph {
  let byTunnels = fullGraphs.get(data)
  if (!byTunnels) fullGraphs.set(data, (byTunnels = new WeakMap()))
  let byAttachments = byTunnels.get(tunnels)
  if (!byAttachments) byTunnels.set(tunnels, (byAttachments = new WeakMap()))
  let graph = byAttachments.get(attachments)
  if (!graph) byAttachments.set(attachments, (graph = buildGraph({ data, tunnels, scope: { kind: 'all' }, attachments })))
  return graph
}

/** The graph and its layout for a scope; null until the inventory has loaded. */
export function useMapGraph(scope: MapScope, pins: Pins = NO_PINS): { graph: MapGraph; layout: MapLayout } | null {
  const data = useInventory()
  const metas = useTunnelMetas()
  const attachments = useMapAttachments(data)
  const key = scopeKey(scope)
  return useMemo(() => {
    if (!data) return null
    const graph = scope.kind === 'all' ? fullGraph(data, metas, attachments) : buildGraph({ data, tunnels: metas, scope, attachments })
    return { graph, layout: layoutGraph(graph, pins) }
    // `key` stands for `scope`: a new object for the same scope must not rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metas, attachments, key, pins])
}
