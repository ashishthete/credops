import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { FileDown, Maximize, Network, Plus, RotateCcw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useInventory, type InventoryData } from '../../inventory/store'
import { byName } from '../../inventory/tree'
import { DetailPanel, selectionSubject, type MapSelection } from '../../map/DetailPanel'
import { parseScope, scopeKey, type MapGraph, type MapScope } from '../../map/graph'
import { MapCanvas, type MapCanvasHandle } from '../../map/MapCanvas'
import { searchGraph } from '../../map/search'
import { fullGraph, useMapGraph, useTunnelMetas } from '../../map/useMapGraph'
import { clearPins, setPin, usePins } from '../../map/viewport'
import { useConnect } from '../../terminal/connect'
import { tunnelStore } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import { plural } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { useMotionSafe } from '../../ui/motion'
import { useShortcut } from '../../ui/shortcuts'
import { Skeleton } from '../../ui/Skeleton'

const FIT_MS = 300
const FIT_PADDING = 0.15
const HIGHLIGHT_MS = 1200
const NO_MATCHES = { matches: [] as string[], best: null }

const FIELD =
  'h-7 rounded-lg border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg transition-colors hover:border-muted/30 focus:border-accent/60 focus:outline-none [color-scheme:dark]'

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
 * The search params for the toolbar's filters. Both live in the URL; an environment outside the chosen
 * product is dropped.
 */
function filterParams(productId: string, environmentId: string, current: URLSearchParams, data: InventoryData): URLSearchParams {
  const out = new URLSearchParams(current)
  out.delete('product')
  out.delete('env')
  const env = data.environments.find((e) => e.id === environmentId)
  if (productId) out.set('product', productId)
  if (env && (!productId || env.productIds.includes(productId))) out.set('env', env.id)
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
  const key = scopeKey(scope)
  const pins = usePins(key)
  const mapped = useMapGraph(scope, pins)
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
  const onPin = useCallback((id: string, pos: { x: number; y: number }) => setPin(key, id, pos), [key])
  const canvas = useRef<MapCanvasHandle>(null)

  // Filters: the selects show what the URL asks for, when it names something that exists.
  const productId = data?.products.some((p) => p.id === params.get('product')) ? params.get('product')! : ''
  const environmentId = data?.environments.some((e) => e.id === params.get('env')) ? params.get('env')! : ''
  const products = useMemo(() => [...(data?.products ?? [])].sort((a, b) => byName(a.name, b.name)), [data])
  const environments = useMemo(
    () => (data?.environments ?? []).filter((e) => !productId || e.productIds.includes(productId)).sort((a, b) => byName(a.name, b.name)),
    [data, productId],
  )
  const setFilter = useCallback(
    (product: string, env: string) => {
      if (data) setParams((p) => filterParams(product, env, p, data))
    },
    [data, setParams],
  )

  // Search: matches in view, plus the whole inventory's when the filter hides them all.
  const searchBox = useRef<HTMLInputElement>(null)
  useShortcut('mod+f', () => searchBox.current?.focus())
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  const found = useMemo(() => (graph && searching ? searchGraph(graph, query) : NO_MATCHES), [graph, query, searching])
  const metas = useTunnelMetas()
  const filtered = scope.kind !== 'all'
  const foundAnywhere = useMemo(
    () => (data && filtered && searching && found.best === null ? searchGraph(fullGraph(data, metas), query) : NO_MATCHES),
    [data, metas, filtered, searching, found, query],
  )
  // Everything but the matches and the groups they sit in fades.
  const dimmed = useMemo(() => {
    if (!graph || !searching) return null
    const keep = new Set(found.matches)
    const parent = new Map(graph.nodes.map((n) => [n.id, n.parentId]))
    for (const id of found.matches) for (let p = parent.get(id); p; p = parent.get(p)) keep.add(p)
    return new Set(graph.nodes.flatMap((n) => (keep.has(n.id) ? [] : [n.id])))
  }, [graph, searching, found])

  // Zooming to a match selects it and rings it once; typing stays in the search box, so Enter cycles.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const lastFound = useRef<string | null>(null)
  const keepSearchFocus = useRef(false)
  const [pendingZoom, setPendingZoom] = useState<string | null>(null)
  const zoomTo = useCallback((id: string) => {
    lastFound.current = id
    keepSearchFocus.current = true
    setSelection({ kind: 'node', id })
    setHighlightId(id)
    canvas.current?.zoomTo(id)
  }, [])
  useEffect(() => {
    if (!highlightId) return
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlightId])
  // The panel takes focus when it opens (its effect runs first); hand it back to the search box. This
  // runs after every commit, so the request never outlives the zoom that made it.
  useEffect(() => {
    if (!keepSearchFocus.current) return
    keepSearchFocus.current = false
    searchBox.current?.focus()
  })
  // A match outside the filter: the filter is cleared first, and the zoom waits for the wider graph.
  useEffect(() => {
    if (pendingZoom && graph?.nodes.some((n) => n.id === pendingZoom)) {
      setPendingZoom(null)
      zoomTo(pendingZoom)
    }
  }, [graph, pendingZoom, zoomTo])

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (!query) return
      e.preventDefault()
      setQuery('')
      lastFound.current = null
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const { matches, best } = found
      if (best) {
        const at = lastFound.current ? matches.indexOf(lastFound.current) : -1
        zoomTo(at < 0 ? best : matches[(at + 1) % matches.length])
      } else if (foundAnywhere.best) {
        setPendingZoom(foundAnywhere.best)
        setFilter('', '')
      }
    }
  }

  const fitAll = () => void flow.fitView({ padding: FIT_PADDING, duration: motionSafe ? FIT_MS : 0 })
  const count = !searching
    ? null
    : found.matches.length > 0 || foundAnywhere.matches.length === 0
      ? plural(found.matches.length, 'match', 'matches')
      : `${plural(foundAnywhere.matches.length, 'match', 'matches')} outside filter`

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
        {data && !empty && (
          <div role="toolbar" aria-label="Map tools" className="flex min-w-0 items-center gap-2">
            <select aria-label="Product" value={productId} onChange={(e) => setFilter(e.target.value, environmentId)} className={FIELD}>
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label="Environment" value={environmentId} onChange={(e) => setFilter(productId, e.target.value)} className={FIELD}>
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            {(productId || environmentId) && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setFilter('', '')}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface-2/60 pr-2 pl-1.5 text-[12px] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X aria-hidden className="size-3" />
                Clear
              </button>
            )}
            <label className="relative block">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
              <input
                ref={searchBox}
                type="search"
                aria-label="Find on map"
                placeholder="Find host, environment…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  lastFound.current = null
                }}
                onKeyDown={onSearchKey}
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-52 rounded-lg border border-line bg-canvas/60 pr-2.5 pl-8 text-[12.5px] text-fg placeholder:text-muted/60 transition-[border-color,box-shadow] focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none"
              />
            </label>
            {count && (
              <span aria-live="polite" className="text-[12px] whitespace-nowrap text-muted tabular-nums">
                {count}
              </span>
            )}
            {Object.keys(pins).length > 0 && (
              <Button variant="ghost" size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={() => clearPins(key)}>
                Reset layout
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<Maximize aria-hidden className="size-3.5" />} onClick={fitAll}>
              Fit view
            </Button>
          </div>
        )}
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
              scopeKey={key}
              selectedId={live?.id ?? null}
              dimmed={dimmed}
              highlightId={highlightId}
              onSelect={onSelect}
              onActivate={onActivate}
              onEdgeSelect={onEdgeSelect}
              onPin={onPin}
              ref={canvas}
            />
            <DetailPanel selection={live} graph={mapped.graph} onClose={onClose} onFilter={onFilter} />
          </>
        )}
      </div>
    </div>
  )
}
