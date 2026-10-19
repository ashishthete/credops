import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { FileDown, Maximize, Network, Plus, RotateCcw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useInventory, type InventoryData } from '../../inventory/store'
import { byName } from '../../inventory/tree'
import { FIND_PARAM, FOCUS_PARAM } from '../../map/commands'
import { DetailPanel, selectionSubject, type MapSelection } from '../../map/DetailPanel'
import { parseScope, scopeKey, type MapGraph, type MapNode, type MapScope } from '../../map/graph'
import { focusModel, nextFocus } from '../../map/keyboard'
import { MapCanvas, type MapCanvasHandle } from '../../map/MapCanvas'
import { MapList } from '../../map/MapList'
import { REACH_TEXT, useHostPresence } from '../../map/presence'
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
import { ROLE_LABEL } from '../products/ProductView'

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

type View = 'map' | 'list'

/** Keys that move the keyboard's focus around the map. */
const FOCUS_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** How long a host's reach must hold before the change is announced, so a flap doesn't chatter. */
const REACH_SETTLE_MS = 1000

/**
 * The map's one live region. It says what the keyboard just focused, from the same data the node
 * draws (`web, Bastion in Prod, Reachable, 1 session, 2 tunnels`, `Prod environment, 5 hosts`), and
 * how many matches a search found; whichever changed last. While focus stays on a host, a settled
 * change of reach is said on its own (`web: Reachable`).
 */
function MapAnnouncer({ node, graph, count }: { node: MapNode | null; graph: MapGraph | undefined; count: string | null }) {
  const d = node?.data
  const hostId = d?.kind === 'host' ? d.hostId : ''
  const { sessions, reach } = useHostPresence(hostId)
  let text = ''
  if (d?.kind === 'product') text = `${d.name} product, ${plural(d.environmentCount, 'environment')}`
  else if (d?.kind === 'environment') text = `${d.environmentId === null ? d.name : `${d.name} environment`}, ${plural(d.hostCount, 'host')}`
  else if (d?.kind === 'mac') text = `This Mac, ${plural(d.tunnelCount, 'tunnel')}`
  else if (d?.kind === 'host') {
    const group = graph?.nodes.find((n) => n.id === node?.parentId)?.data
    const where = group?.kind === 'environment' ? group.name : 'Unassigned'
    // Counted as drawn: a host placed twice has its tunnels on one placement only.
    const tunnels = graph?.edges.filter((e) => e.data.kind === 'tunnel' && (e.source === node?.id || e.target === node?.id)).length ?? 0
    text = `${d.label}, ${d.role ? ROLE_LABEL[d.role] : 'No role'} in ${where}, ${REACH_TEXT[reach]}, ${plural(sessions, 'session')}, ${plural(tunnels, 'tunnel')}`
  }
  const [said, setSaid] = useState('')
  const id = node?.id ?? ''
  const latest = useRef({ text, label: '', reach })
  // The reach last spoken for the focused node; a change from it is said on its own, once it settles.
  const heard = useRef(reach)
  useEffect(() => {
    latest.current = { text, label: d?.kind === 'host' ? d.label : '', reach }
  })
  // The whole description when focus moves; while it stays, only what changed is said.
  useEffect(() => {
    setSaid(latest.current.text)
    heard.current = latest.current.reach
  }, [id])
  useEffect(() => {
    if (!hostId || reach === heard.current) return
    const t = setTimeout(() => {
      heard.current = reach
      setSaid(`${latest.current.label}: ${REACH_TEXT[reach]}`)
    }, REACH_SETTLE_MS)
    return () => clearTimeout(t)
  }, [id, hostId, reach])
  useEffect(() => {
    if (count) setSaid(count)
  }, [count])
  return (
    <div aria-live="polite" aria-atomic className="sr-only" data-testid="map-announce">
      {said}
    </div>
  )
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
  const empty = data !== null && data.hosts.length === 0 && data.products.length === 0
  const view: View = params.get('view') === 'list' ? 'list' : 'map'

  // A selection whose node or edge has left the graph (deleted, or filtered out) closes the panel.
  const live = graph && selectionSubject(selection, graph) ? selection : null
  useEffect(() => {
    if (graph && selection && !live) setSelection(null)
  }, [graph, selection, live])

  // Keyboard focus: separate from selection, and tied to the scope it was set in, so another scope
  // starts with none. It is checked against the target graph, never against what is still leaving.
  const model = useMemo(() => (graph ? focusModel(graph) : null), [graph])
  const [focus, setFocusState] = useState<{ scope: string; id: string | null }>({ scope: key, id: null })
  const focusedId = focus.scope === key ? focus.id : null
  const setFocus = useCallback((id: string | null) => setFocusState({ scope: key, id }), [key])
  const focusedNode = useMemo(() => (focusedId && graph?.nodes.find((n) => n.id === focusedId)) || null, [graph, focusedId])
  // A focused node that leaves hands focus to its parent, if that is still drawn, else to the first node.
  const lastModel = useRef(model)
  useEffect(() => {
    const before = lastModel.current
    lastModel.current = model
    if (!model || !focusedId || focusedId in model.parent) return
    const up = before?.parent[focusedId]
    setFocus(up && up in model.parent ? up : (model.order[0] ?? null))
  }, [model, focusedId, setFocus])

  const onSelect = useCallback((id: string | null) => setSelection(id ? { kind: 'node', id } : null), [])
  // Only tunnels have a panel; a jump edge click does nothing.
  const onEdgeSelect = useCallback((id: string) => {
    if (id.startsWith('t:')) setSelection({ kind: 'edge', id })
  }, [])
  const onClose = useCallback(() => setSelection(null), [])
  const onFilter = useCallback((next: MapScope) => setParams((p) => scopeParams(next, p)), [setParams])
  const onPin = useCallback((id: string, pos: { x: number; y: number }) => setPin(key, id, pos), [key])
  const canvas = useRef<MapCanvasHandle>(null)
  const stage = useRef<HTMLDivElement>(null)

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
  const keepCanvasFocus = useRef(false)
  const [pendingZoom, setPendingZoom] = useState<string | null>(null)
  const zoomTo = useCallback((id: string) => {
    lastFound.current = id
    keepSearchFocus.current = true
    setSelection({ kind: 'node', id })
    setHighlightId(id)
    canvas.current?.zoomTo(id)
  }, [])
  // Show on map (the list, a host's page, the palette): zoom to the node, select it and put the
  // keyboard's focus there. It waits for the canvas, which the list view doesn't draw.
  const [pendingReveal, setPendingReveal] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingReveal || view !== 'map' || !canvas.current || !graph?.nodes.some((n) => n.id === pendingReveal)) return
    const id = pendingReveal
    setPendingReveal(null)
    setFocus(id)
    setSelection({ kind: 'node', id })
    setHighlightId(id)
    canvas.current.zoomTo(id)
  }, [pendingReveal, view, graph, setFocus])
  useEffect(() => {
    if (!highlightId) return
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlightId])
  // The panel takes focus when it opens (its effect runs first); hand it back to the search box. This
  // runs after every commit, so the request never outlives the zoom that made it.
  useEffect(() => {
    if (keepSearchFocus.current) {
      keepSearchFocus.current = false
      searchBox.current?.focus()
    } else if (keepCanvasFocus.current) {
      // A panel opened from the keyboard leaves focus on the canvas, so Enter again connects.
      keepCanvasFocus.current = false
      stage.current?.querySelector<HTMLElement>('.react-flow')?.focus()
    }
  })

  const setView = useCallback(
    (next: View) =>
      setParams((p) => {
        const out = new URLSearchParams(p)
        if (next === 'list') out.set('view', 'list')
        else out.delete('view')
        return out
      }),
    [setParams],
  )
  const showOnMap = useCallback(
    (id: string) => {
      setView('map')
      setPendingReveal(id)
    },
    [setView],
  )

  // Entry points from elsewhere, read once and then dropped from the URL: `focus` shows a host's first
  // placement; `find` puts the caret in the search box.
  useEffect(() => {
    const hostId = params.get(FOCUS_PARAM)
    if (hostId === null || !graph) return
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete(FOCUS_PARAM)
        out.delete('view')
        return out
      },
      { replace: true },
    )
    const id = graph.placementsByHost[hostId]?.[0]
    if (id) setPendingReveal(id)
  }, [params, graph, setParams])
  const toolbarShown = !!data && !empty
  useEffect(() => {
    if (!params.has(FIND_PARAM) || !toolbarShown) return
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete(FIND_PARAM)
        return out
      },
      { replace: true },
    )
    searchBox.current?.focus()
  }, [params, toolbarShown, setParams])
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

  // Keys on the canvas: arrows walk the hierarchy, Enter or Space opens the panel (Enter again on a
  // host connects), Escape closes the panel and then lets go of focus, `/` jumps to search. Read through
  // a ref, so the canvas keeps one handler.
  const keysWith = useRef({ model, focusedId, focusedNode, live, connect, setFocus })
  useLayoutEffect(() => {
    keysWith.current = { model, focusedId, focusedNode, live, connect, setFocus }
  })
  const onCanvasKey = useCallback((e: KeyboardEvent) => {
    const { model, focusedId, focusedNode, live, connect, setFocus } = keysWith.current
    if (e.key === '/') {
      searchBox.current?.focus()
      return true
    }
    if (FOCUS_KEYS.has(e.key)) {
      if (model) setFocus(nextFocus(model, focusedId, e.key))
      return true
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (!focusedNode) return false
      const d = focusedNode.data
      if (e.key === 'Enter' && d.kind === 'host' && live?.kind === 'node' && live.id === focusedNode.id) {
        void connect(d.hostId, d.environmentId ?? undefined)
      } else {
        keepCanvasFocus.current = true
        setSelection({ kind: 'node', id: focusedNode.id })
      }
      return true
    }
    if (e.key === 'Escape') {
      // An open panel closes on its own Escape handler; with none open, Escape lets go of focus.
      if (live || !focusedId) return false
      setFocus(null)
      return true
    }
    return false
  }, [])

  // The list hides what the search doesn't find, rather than fading it: a host stays when it, its
  // environment or its product matches.
  const listGraph = useMemo(() => {
    if (!graph || !model || !searching) return graph
    const keep = new Set(found.matches)
    const kept = (id: string): boolean => {
      for (let at: string | null = id; at; at = model.parent[at] ?? null) if (keep.has(at)) return true
      return false
    }
    return { ...graph, nodes: graph.nodes.filter((n) => n.data.kind !== 'host' || kept(n.id)) }
  }, [graph, model, searching, found])
  const onListConnect = useCallback((hostId: string, environmentId: string | null) => void connect(hostId, environmentId ?? undefined), [connect])

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
            <div role="group" aria-label="View" className="flex h-7 shrink-0 items-center rounded-lg border border-line bg-surface-2/60 p-0.5">
              {(['map', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={`h-full rounded-md px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                    view === v ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
                  }`}
                >
                  {v === 'map' ? 'Map' : 'List'}
                </button>
              ))}
            </div>
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
              <span className="text-[12px] whitespace-nowrap text-muted tabular-nums">
                {count}
              </span>
            )}
            {view === 'map' && Object.keys(pins).length > 0 && (
              <Button variant="ghost" size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={() => clearPins(key)}>
                Reset layout
              </Button>
            )}
            {view === 'map' && (
              <Button variant="ghost" size="sm" icon={<Maximize aria-hidden className="size-3.5" />} onClick={fitAll}>
                Fit view
              </Button>
            )}
          </div>
        )}
      </header>
      {/* data-panel: the minimap steps aside while the detail panel is open (tokens.css). */}
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden border-t border-line" data-panel={live && view === 'map' ? 'open' : undefined}>
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
        ) : view === 'list' ? (
          <MapList graph={listGraph ?? mapped.graph} onConnect={onListConnect} onSelect={showOnMap} />
        ) : (
          <>
            <MapCanvas
              graph={mapped.graph}
              layout={mapped.layout}
              scopeKey={key}
              selectedId={live?.id ?? null}
              dimmed={dimmed}
              highlightId={highlightId}
              focusedId={focusedId}
              onCanvasKey={onCanvasKey}
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
      {toolbarShown && <MapAnnouncer node={view === 'map' ? focusedNode : null} graph={mapped?.graph} count={count} />}
    </div>
  )
}
