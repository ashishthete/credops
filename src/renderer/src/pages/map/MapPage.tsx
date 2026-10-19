import { ReactFlowProvider } from '@xyflow/react'
import { FileDown, Network, Plus } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useInventory } from '../../inventory/store'
import { parseScope, type MapGraph } from '../../map/graph'
import { MapCanvas } from '../../map/MapCanvas'
import { useMapGraph } from '../../map/useMapGraph'
import { tunnelStore } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import { plural } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { Skeleton } from '../../ui/Skeleton'

const noop = () => {}

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
  const data = useInventory()
  const [params] = useSearchParams()
  const scope = useMemo(() => (data ? parseScope(params, data) : ({ kind: 'all' } as const)), [params, data])
  const mapped = useMapGraph(scope)
  const summary = useSummary(mapped?.graph)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const empty = data !== null && data.hosts.length === 0 && data.products.length === 0

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
      <div className="relative min-h-0 flex-1 border-t border-line">
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
          <MapCanvas
            graph={mapped.graph}
            layout={mapped.layout}
            selectedId={selectedId}
            dimmed={null}
            highlightId={null}
            onSelect={setSelectedId}
            onActivate={noop}
            onEdgeSelect={noop}
          />
        )}
      </div>
    </div>
  )
}
