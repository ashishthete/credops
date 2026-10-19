import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { FileDown, Network, Plus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useInventory } from '../../inventory/store'
import { DetailPanel, selectionSubject, type MapSelection } from '../../map/DetailPanel'
import { parseScope, type MapGraph, type MapScope } from '../../map/graph'
import { MapCanvas } from '../../map/MapCanvas'
import { useMapGraph } from '../../map/useMapGraph'
import { useConnect } from '../../terminal/connect'
import { tunnelStore } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import { plural } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'

const FIT_MS = 300
const FIT_PADDING = 0.15

/** The search params for a scope: `?product=` or `?env=`, or neither for everything. */
function scopeParams(scope: MapScope, current: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(current)
  out.delete('product')
  out.delete('env')
  if (scope.kind === 'product') out.set('product', scope.productId)
  else if (scope.kind === 'environment') out.set('env', scope.environmentId)
  return out
}

/**
 * `2 environments · 3 hosts · 1 tunnel up`, counting what the scope shows. The store snapshot is the
 * up-count alone, so runtime churn that leaves it unchanged doesn't re-render the page or the canvas.
 */
function useSummary(graph: MapGraph | undefined): string | null {
  const { environments, hosts } = useMemo(() => {
    let environments = 0
    const hosts = new Set<string>()
    for (const n of graph?.nodes ?? []) {
      if (n.data.kind === 'environment' && n.data.environmentId !== null) environments++
      else if (n.data.kind === 'host') hosts.add(n.data.hostId)
    }
    return { environments, hosts }
  }, [graph])
  const upCount = useCallback(() => {
    const { tunnels, runtime } = tunnelStore.get()
    return tunnels.filter((t) => hosts.has(t.hostId) && runtime[t.id]?.state === 'up').length
  }, [hosts])
  const up = useSyncExternalStore(tunnelStore.subscribe, upCount)
  if (!graph) return null
  return `${plural(environments, 'environment')} · ${plural(hosts.size, 'host')} · ${plural(up, 'tunnel')} up`
}

export function MapPage() {
  return (
    <ReactFlowProvider>
      <MapBody />
    </ReactFlowProvider>
  )
}

function MapBody() {
  const navigate = useNavigate()
  const motionSafe = useMotionSafe()
  const flow = useReactFlow()
  const { connect } = useConnect()
  const data = useInventory()
  const [params, setParams] = useSearchParams()
  const scope = useMemo(() => (data ? parseScope(params, data) : ({ kind: 'all' } as const)), [params, data])
  const mapped = useMapGraph(scope)
  const graph = mapped?.graph
  const summary = useSummary(graph)
  const [selection, setSelection] = useState<MapSelection | null>(null)
  // Where keyboard focus belongs after the selected host vanishes: its group, if that's still drawn (Task 8 reads it).
  const focusAfterRemoval = useRef<string | null>(null)
  const empty = data !== null && data.hosts.length === 0 && data.products.length === 0

  // A selection whose node or edge has left the graph (deleted, or filtered out) closes the panel.
  const live = graph && selectionSubject(selection, graph) ? selection : null
  useEffect(() => {
    if (!graph || !selection || live) return
    const group = selection.kind === 'node' && selection.id.includes('/h:') ? selection.id.slice(0, selection.id.indexOf('/h:')) : null
    focusAfterRemoval.current = group && graph.nodes.some((n) => n.id === group) ? group : null
    setSelection(null)
  }, [graph, selection, live])

  const onSelect = useCallback((id: string | null) => setSelection(id ? { kind: 'node', id } : null), [])
  // Only tunnels have a panel; a jump edge click does nothing.
  const onEdgeSelect = useCallback((id: string) => {
    if (id.startsWith('t:')) setSelection({ kind: 'edge', id })
  }, [])
  const onClose = useCallback(() => setSelection(null), [])
  const onFilter = useCallback((next: MapScope) => setParams((p) => scopeParams(next, p)), [setParams])

  // Double-click: a host connects from that placement; a group or product frames itself. It reads the
  // latest values through a ref, so the handler (and with it the canvas) stays put when the viewport
  // helpers or the graph change.
  const activateWith = useRef({ graph, connect, flow, motionSafe })
  useLayoutEffect(() => {
    activateWith.current = { graph, connect, flow, motionSafe }
  })
  const onActivate = useCallback((id: string) => {
    const latest = activateWith.current
    const d = latest.graph?.nodes.find((n) => n.id === id)?.data
    if (d?.kind === 'host') void latest.connect(d.hostId, d.environmentId ?? undefined)
    else if (d) void latest.flow.fitView({ nodes: [{ id }], duration: latest.motionSafe ? FIT_MS : 0, padding: FIT_PADDING })
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-fg">Map</h1>
          {summary && !empty && <p className="truncate text-[12.5px] text-muted tabular-nums">{summary}</p>}
        </div>
        {/* The toolbar: scope and search (Task 6), layout and export (Task 8). */}
        <div className="flex items-center gap-2" />
      </header>
      {/* data-panel: the minimap steps aside while the detail panel is open (tokens.css). */}
      <div className="relative min-h-0 flex-1 overflow-hidden border-t border-line" data-panel={live ? 'open' : undefined}>
        {!data || !mapped ? (
          <div aria-label="Loading map" aria-busy className="h-full p-8">
            <Skeleton className="h-full w-full rounded-xl" />
          </div>
        ) : empty ? (
          <EmptyState
            icon={Network}
            title="Nothing to map yet"
            text="Add hosts and they appear here, grouped by environment."
            actions={
              <>
                <Button variant="ghost" icon={<FileDown aria-hidden className="size-3.5" />} onClick={() => navigate('/hosts?action=import')}>
                  Import from ssh config
                </Button>
                <Button icon={<Plus aria-hidden className="size-3.5" />} onClick={() => navigate('/hosts?action=new')}>
                  Add host
                </Button>
              </>
            }
          />
        ) : (
          <>
            <MapCanvas
              graph={mapped.graph}
              layout={mapped.layout}
              selectedId={live?.id ?? null}
              dimmed={null}
              highlightId={null}
              onSelect={onSelect}
              onActivate={onActivate}
              onEdgeSelect={onEdgeSelect}
            />
            <DetailPanel selection={live} graph={mapped.graph} onClose={onClose} onFilter={onFilter} />
          </>
        )}
      </div>
    </div>
  )
}
