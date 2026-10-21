import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type NodeChange,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { useMotionSafe } from '../ui/motion'
import { EdgeActionsContext, edgeTypes, type EdgeActions, type MapFlowEdge } from './edges'
import type { MapGraph } from './graph'
import { VIRTUALIZE_AT, type MapLayout } from './layout'
import { MAC_HANDLE, nodeTypes, type MapFlowNode } from './nodes'
import { cancelGlide, useGraphTransition } from './useGraphTransition'
import { MAX_ZOOM, MIN_ZOOM, loadViewport, saveViewport } from './viewport'

/** Imperative moves the page asks of the canvas. */
export interface MapCanvasHandle {
  /** Frames one node closely, gliding unless motion is reduced. */
  zoomTo: (id: string) => void
}

export interface MapCanvasProps {
  graph: MapGraph
  /** Laid out with this scope's pins already applied. */
  layout: MapLayout
  /** Which viewport to restore and save, and which pins a drag writes to. */
  scopeKey: string
  /** The selected node or edge; selection lives in the page, not in React Flow. */
  selectedId: string | null
  /** Nodes drawn faded (a search or filter elsewhere); null fades nothing. */
  dimmed: Set<string> | null
  highlightId: string | null
  /** The keyboard's place on the map, separate from selection: ringed, and panned into view. */
  focusedId: string | null
  /**
   * Keys pressed on the canvas itself, beyond its own zoom keys (`+`, `-`, `0`); returns whether the
   * page handled it.
   */
  onCanvasKey: (e: KeyboardEvent) => boolean
  onSelect: (id: string | null) => void
  onActivate: (id: string) => void
  onEdgeSelect: (id: string) => void
  /** A drag ended: `pos` is the node's new position, relative to its group for a host. */
  onPin: (id: string, pos: { x: number; y: number }) => void
  ref?: Ref<MapCanvasHandle>
}

const ZOOM_MS = 200
const FIT_PADDING = 0.15
const ZOOM_TO_MS = 450
const SAVE_DEBOUNCE_MS = 300
const PAN_MS = 250
// A focused node closer than this to the canvas edge counts as out of view.
const VIEW_MARGIN = 24
const FIT_OPTIONS = { padding: FIT_PADDING }

/** The minimap tints everything by its environment; groups stay faint so their hosts read on top. */
export function minimapColors(graph: MapGraph): Map<string, string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const colors = new Map<string, string>()
  for (const n of graph.nodes) {
    const d = n.data
    if (d.kind === 'product') colors.set(n.id, d.color)
    else if (d.kind === 'environment') colors.set(n.id, `color-mix(in oklab, ${d.color} 22%, transparent)`)
    else if (d.kind === 'host') {
      const group = n.parentId ? byId.get(n.parentId)?.data : undefined
      if (group?.kind === 'environment') colors.set(n.id, group.color)
    }
  }
  return colors
}

/**
 * Flow edges for a graph. Tunnels and jumps draw above the group frames, memberships under them;
 * a membership takes its product's colour. A tunnel from this Mac (L, D) keeps its direction, so it
 * flows the way traffic does, but enters the host on the Mac's side rather than across its row.
 */
export function flowEdges(graph: MapGraph): MapFlowEdge[] {
  const productColor = new Map(graph.nodes.flatMap((n) => (n.data.kind === 'product' ? [[n.id, n.data.color] as const] : [])))
  return graph.edges.map((e): MapFlowEdge => {
    const base = { id: e.id, source: e.source, target: e.target }
    const d = e.data
    if (d.kind === 'membership') return { ...base, type: 'membership', zIndex: 0, data: { ...d, color: productColor.get(e.source) ?? 'var(--muted)' } }
    if (d.kind === 'jump') return { ...base, type: 'jump', zIndex: 1, data: { ...d } }
    return { ...base, ...(e.source === 'mac' && { targetHandle: MAC_HANDLE }), type: 'tunnel', zIndex: 1, data: { ...d } }
  })
}

// Marks the two ends of a hovered edge, and nodes a search fades; shared objects, so an unchanged node
// keeps its identity.
type DomAttributes = MapFlowNode['domAttributes']
const RELATED = { 'data-related': '' } as DomAttributes
const DIMMED = { 'data-dimmed': 'true' } as DomAttributes
const DIMMED_RELATED = { 'data-dimmed': 'true', 'data-related': '' } as DomAttributes
const FOCUSED = { 'data-focused': 'true' } as DomAttributes
const focusedAttrs = new Map<DomAttributes, DomAttributes>(
  [RELATED, DIMMED, DIMMED_RELATED].map((attrs) => [attrs, { ...attrs, 'data-focused': 'true' } as DomAttributes]),
)

/** A node or edge on its way out, still faded as it was drawn; the transition has already made it inert. */
function fadeLeaving<T extends MapFlowNode | MapFlowEdge>(x: T): T {
  return { ...x, className: `${x.className} od-dimmed`, domAttributes: { ...x.domAttributes, 'data-dimmed': 'true' } }
}

/** Flow nodes for a laid-out graph: position, size and data only; selection and styling come later. */
function flowNodes(graph: MapGraph, layout: MapLayout): MapFlowNode[] {
  return graph.nodes.flatMap((n) => {
    const at = layout.positions[n.id]
    if (!at) return []
    return [
      {
        id: n.id,
        type: n.data.kind,
        position: { x: at.x, y: at.y },
        width: at.width,
        height: at.height,
        ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
        data: { ...n.data },
      } as MapFlowNode,
    ]
  })
}

/** A new frame of nodes, except that a node mid-drag keeps the position the drag gave it. */
function keepDragged(next: MapFlowNode[], current: MapFlowNode[]): MapFlowNode[] {
  const dragged = new Map(current.flatMap((n) => (n.dragging ? [[n.id, n] as const] : [])))
  return dragged.size ? next.map((n) => dragged.get(n.id) ?? n) : next
}

/**
 * The React Flow canvas for a graph and its layout. Needs a `ReactFlowProvider` above it, so the page
 * and its toolbar can reach the viewport through `useReactFlow` too.
 */
export const MapCanvas = memo(function MapCanvas({
  graph,
  layout,
  selectedId,
  dimmed,
  highlightId,
  focusedId,
  onCanvasKey,
  onSelect,
  onActivate,
  onEdgeSelect,
  scopeKey,
  onPin,
  ref,
}: MapCanvasProps) {
  const motionSafe = useMotionSafe()
  const flow = useReactFlow()
  // Effects and the handle read the latest viewport helpers here, so they don't re-run on every render.
  const latest = useRef({ flow, motionSafe })
  useLayoutEffect(() => {
    latest.current = { flow, motionSafe }
  })

  const base = useMemo(() => flowNodes(graph, layout), [graph, layout])
  const baseEdges = useMemo(() => flowEdges(graph), [graph])
  const target = useMemo(() => ({ nodes: base, edges: baseEdges }), [base, baseEdges])
  // Inventory changes glide; a new scope is a different map, so it is drawn at once (its viewport is
  // restored or fitted around what it shows, not around nodes still leaving).
  const [drawnScope, setDrawnScope] = useState(scopeKey)
  if (drawnScope !== scopeKey) setDrawnScope(scopeKey)
  const shown = useGraphTransition(target, { motionSafe: motionSafe && drawnScope === scopeKey })
  // What the last commit drew faded. A node or edge that leaves is no longer in the graph a search dims,
  // so it keeps the fade it was drawn with and fades out from there rather than flashing back.
  const drawnFaded = useRef({ nodes: new Set<string>(), edges: new Set<string>() })

  // Drags and measurements apply to a local copy, which each new frame of the transition resets; a node
  // being dragged keeps its dragged position through those frames.
  const [local, setLocal] = useState({ from: shown.nodes, nodes: shown.nodes })
  if (local.from !== shown.nodes) setLocal({ from: shown.nodes, nodes: keepDragged(shown.nodes, local.nodes) })
  // Selection belongs to the page, so React Flow's own select changes are dropped.
  const onNodesChange = useCallback((changes: NodeChange<MapFlowNode>[]) => {
    const kept = changes.filter((c) => c.type !== 'select')
    if (kept.length) setLocal((s) => ({ ...s, nodes: applyNodeChanges(kept, s.nodes) }))
  }, [])

  // The selected tunnel glows (tokens.css) and an edge to a faded node fades too; every other edge keeps
  // its identity. A leaving edge is left as the transition drew it.
  const edges = useMemo(
    () =>
      shown.edges.map((e) => {
        if (e.data?.leaving) return drawnFaded.current.edges.has(e.id) ? fadeLeaving(e) : e
        const selected = e.id === selectedId
        const faded = !!dimmed && (dimmed.has(e.source) || dimmed.has(e.target))
        return selected || faded ? { ...e, selected, className: [e.className, faded && 'od-dimmed'].filter(Boolean).join(' ') || undefined } : e
      }),
    [shown.edges, selectedId, dimmed],
  )

  // Hovering an edge rings its two end nodes.
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const related = useMemo(() => {
    const e = hoveredEdge ? graph.edges.find((x) => x.id === hoveredEdge) : undefined
    return e ? new Set([e.source, e.target]) : null
  }, [graph, hoveredEdge])
  const onEdgeMouseEnter = useCallback((_: MouseEvent, e: MapFlowEdge) => setHoveredEdge(e.id), [])
  const onEdgeMouseLeave = useCallback(() => setHoveredEdge(null), [])
  const edgeActions = useMemo((): EdgeActions => ({ select: onEdgeSelect, hover: setHoveredEdge }), [onEdgeSelect])

  // Selection and styling go on at render time, so changing them never moves a dragged node back. The
  // last styled copy of each node is kept, so a node whose styling didn't change keeps its identity.
  const styled = useRef(new Map<string, { from: MapFlowNode; out: MapFlowNode }>())
  const nodes = useMemo(() => {
    const next = new Map<string, { from: MapFlowNode; out: MapFlowNode }>()
    const out = local.nodes.map((n) => {
      if (n.data.leaving) return drawnFaded.current.nodes.has(n.id) ? fadeLeaving(n) : n
      const selected = n.id === selectedId
      const faded = !!dimmed?.has(n.id)
      const lit = highlightId === n.id
      // A leaving copy is handled above, so the keyboard's ring only ever lands on a node that stays.
      const focused = focusedId === n.id
      // The ring plays once with motion, and simply shows under reduced motion.
      const className =
        [n.className, faded && 'od-dimmed', lit && 'od-highlight', lit && motionSafe && 'od-ring', focused && 'od-focused'].filter(Boolean).join(' ') ||
        undefined
      const near = !!related?.has(n.id)
      const plain = faded ? (near ? DIMMED_RELATED : DIMMED) : near ? RELATED : undefined
      const domAttributes = focused ? (plain ? focusedAttrs.get(plain) : FOCUSED) : plain
      const last = styled.current.get(n.id)
      const same = (x: MapFlowNode) => !!x.selected === selected && x.className === className && x.domAttributes === domAttributes
      const result = last && last.from === n && same(last.out) ? last.out : same(n) ? n : { ...n, selected, className, domAttributes }
      next.set(n.id, { from: n, out: result })
      return result
    })
    styled.current = next
    return out
  }, [local.nodes, selectedId, dimmed, highlightId, focusedId, related, motionSafe])

  useEffect(() => {
    const faded = (x: { id: string; className?: string }) => (x.className?.split(' ').includes('od-dimmed') ? [x.id] : [])
    drawnFaded.current = { nodes: new Set(nodes.flatMap(faded)), edges: new Set(edges.flatMap(faded)) }
  }, [nodes, edges])

  const colors = useMemo(() => minimapColors(graph), [graph])
  const nodeColor = useCallback((n: MapFlowNode) => colors.get(n.id) ?? 'var(--muted)', [colors])

  const onNodeClick = useCallback((_: unknown, n: MapFlowNode) => onSelect(n.id), [onSelect])
  const onNodeDoubleClick = useCallback((_: unknown, n: MapFlowNode) => onActivate(n.id), [onActivate])
  const onEdgeClick = useCallback((_: unknown, e: MapFlowEdge) => onEdgeSelect(e.id), [onEdgeSelect])
  const onPaneClick = useCallback(() => onSelect(null), [onSelect])
  // Only the grabbed node is pinned: a group carries its hosts along, and with selectNodesOnDrag off
  // React Flow unselects the page's selection inside the drag rather than dragging it too.
  const onNodeDragStop = useCallback((_: unknown, n: MapFlowNode) => onPin(n.id, n.position), [onPin])
  // Input wins: a node taken hold of mid-glide stops gliding, and its drop lands where it was let go.
  const onNodeDragStart = useCallback((_: unknown, n: MapFlowNode) => cancelGlide(n.id), [])

  // The node a zoom-to is framing; keeping focus in view leaves that one to the zoom.
  const framing = useRef<string | null>(null)
  useImperativeHandle(
    ref,
    () => ({
      zoomTo(id) {
        framing.current = id
        const { flow, motionSafe } = latest.current
        void flow.fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1.25, duration: motionSafe ? ZOOM_TO_MS : 0 })
      },
    }),
    [],
  )

  // A move is saved for the scope it happened in once it has settled. A newer move in the same scope
  // replaces it; switching scope or leaving the page saves it at once.
  const pendingSave = useRef<{ scope: string; timer: ReturnType<typeof setTimeout>; save: () => void } | null>(null)
  const flushSave = useCallback(() => {
    if (!pendingSave.current) return
    clearTimeout(pendingSave.current.timer)
    pendingSave.current.save()
  }, [])
  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      if (pendingSave.current?.scope === scopeKey) clearTimeout(pendingSave.current.timer)
      else flushSave()
      const save = () => {
        pendingSave.current = null
        saveViewport(scopeKey, vp)
      }
      pendingSave.current = { scope: scopeKey, timer: setTimeout(save, SAVE_DEBOUNCE_MS), save }
    },
    [scopeKey, flushSave],
  )
  useEffect(() => flushSave, [flushSave])

  // The first scope's viewport goes in as React Flow's starting one (or it fits); later scopes restore
  // theirs here, or fit when they have none stored.
  const [initialViewport] = useState(() => loadViewport(scopeKey))
  const shownScope = useRef(scopeKey)
  useEffect(() => {
    if (shownScope.current === scopeKey) return
    shownScope.current = scopeKey
    flushSave()
    const { flow } = latest.current
    const stored = loadViewport(scopeKey)
    if (stored) void flow.setViewport(stored)
    else void flow.fitView({ padding: FIT_PADDING })
  }, [scopeKey, flushSave])

  // Canvas keys live here, not in global shortcuts, so typing in a search box never zooms.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
      const duration = motionSafe ? ZOOM_MS : 0
      if (e.key === '+' || e.key === '=') void flow.zoomIn({ duration })
      else if (e.key === '-') void flow.zoomOut({ duration })
      else if (e.key === '0') void flow.fitView({ duration, padding: FIT_PADDING })
      else if (!onCanvasKey(e)) return
      e.preventDefault()
    },
    [flow, motionSafe, onCanvasKey],
  )

  // The focused node is kept in view. Its place comes from the layout, where it is headed, not from a
  // glide's frame, so a node mid-glide is framed where it lands.
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const placed = useRef({ graph, layout, width, height })
  useLayoutEffect(() => {
    placed.current = { graph, layout, width, height }
  })
  useEffect(() => {
    const framed = framing.current === focusedId
    framing.current = null
    if (!focusedId || framed) return
    const { graph, layout, width, height } = placed.current
    const box = layout.positions[focusedId]
    if (!box || !width || !height) return
    const parentId = graph.nodes.find((n) => n.id === focusedId)?.parentId
    const offset = parentId ? layout.positions[parentId] : undefined
    const x = box.x + (offset?.x ?? 0)
    const y = box.y + (offset?.y ?? 0)
    const { flow, motionSafe } = latest.current
    const { x: vx, y: vy, zoom } = flow.getViewport()
    const left = x * zoom + vx
    const top = y * zoom + vy
    const inView =
      left >= VIEW_MARGIN && top >= VIEW_MARGIN && left + box.width * zoom <= width - VIEW_MARGIN && top + box.height * zoom <= height - VIEW_MARGIN
    if (!inView) void flow.setCenter(x + box.width / 2, y + box.height / 2, { zoom, duration: motionSafe ? PAN_MS : 0 })
  }, [focusedId])
  // A zoom-to only covers the focus change that comes with it, in the next commit; past that, a later
  // focus on the same node is panned to like any other.
  useEffect(() => {
    framing.current = null
  })

  return (
    <EdgeActionsContext.Provider value={edgeActions}>
      <ReactFlow<MapFlowNode, MapFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onPaneClick={onPaneClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        selectNodesOnDrag={false}
        onMoveEnd={onMoveEnd}
        nodesConnectable={false}
        elementsSelectable
        nodesFocusable={false}
        edgesFocusable={false}
        // Keyboard is ours (Task 8): no built-in live region, Backspace deletes nothing, Space is free,
        // and double-click means activate, not zoom.
        disableKeyboardA11y
        deleteKeyCode={null}
        panActivationKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        defaultViewport={initialViewport ?? undefined}
        fitView={!initialViewport}
        fitViewOptions={FIT_OPTIONS}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={nodes.length > VIRTUALIZE_AT}
        colorMode="dark"
        // These land on React Flow's own role="application" root, the canvas's one tab stop.
        tabIndex={0}
        aria-roledescription="topology map"
        aria-label="Topology map, use arrow keys to move between nodes"
        onKeyDown={onKeyDown}
      >
        <Background variant={BackgroundVariant.Dots} />
        <MiniMap<MapFlowNode> pannable zoomable nodeColor={nodeColor} />
        <Controls showZoom={false} showFitView={false} showInteractive={false}>
          <ZoomButtons />
        </Controls>
      </ReactFlow>
    </EdgeActionsContext.Provider>
  )
})

const zoomBounds = (s: { transform: [number, number, number]; minZoom: number; maxZoom: number }) =>
  `${s.transform[2] <= s.minZoom}|${s.transform[2] >= s.maxZoom}`

/** React Flow's zoom and fit buttons, with the same labels, moving only as far as reduced motion allows. */
function ZoomButtons() {
  const flow = useReactFlow()
  const motionSafe = useMotionSafe()
  const [atMin, atMax] = useStore(zoomBounds).split('|').map((x) => x === 'true')
  return (
    <>
      <ControlButton className="react-flow__controls-zoomin" title="Zoom In" aria-label="Zoom In" disabled={atMax} onClick={() => void flow.zoomIn({ duration: motionSafe ? ZOOM_MS : 0 })}>
        <Plus aria-hidden />
      </ControlButton>
      <ControlButton className="react-flow__controls-zoomout" title="Zoom Out" aria-label="Zoom Out" disabled={atMin} onClick={() => void flow.zoomOut({ duration: motionSafe ? ZOOM_MS : 0 })}>
        <Minus aria-hidden />
      </ControlButton>
      <ControlButton
        className="react-flow__controls-fitview"
        title="Fit View"
        aria-label="Fit View"
        onClick={() => void flow.fitView({ padding: FIT_PADDING, duration: motionSafe ? ZOOM_MS : 0 })}
      >
        <Maximize aria-hidden />
      </ControlButton>
    </>
  )
}
