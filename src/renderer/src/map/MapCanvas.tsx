import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo, useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useMotionSafe } from '../ui/motion'
import { EdgeActionsContext, edgeTypes, type EdgeActions, type MapFlowEdge } from './edges'
import type { MapGraph } from './graph'
import { VIRTUALIZE_AT, type MapLayout } from './layout'
import { nodeTypes, type MapFlowNode } from './nodes'

export interface MapCanvasProps {
  graph: MapGraph
  layout: MapLayout
  selectedId: string | null
  /** Nodes drawn faded (a search or filter elsewhere); null fades nothing. */
  dimmed: Set<string> | null
  highlightId: string | null
  onSelect: (id: string | null) => void
  onActivate: (id: string) => void
  onEdgeSelect: (id: string) => void
}

const ZOOM_MS = 200
const FIT_PADDING = 0.15

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

/** Product names an environment shares, beside the one it sits under. */
function alsoIn(graph: MapGraph): Map<string, string[]> {
  const nameOf = new Map(graph.nodes.flatMap((n) => (n.data.kind === 'product' ? [[n.id, n.data.name] as const] : [])))
  const primary = new Map(graph.edges.flatMap((e) => (e.data.kind === 'membership' && e.data.primary ? [[e.target, nameOf.get(e.source)] as const] : [])))
  const out = new Map<string, string[]>()
  for (const n of graph.nodes) {
    if (n.data.kind !== 'environment' || n.data.productNames.length < 2) continue
    const home = primary.get(n.id)
    out.set(n.id, home ? n.data.productNames.filter((name) => name !== home) : n.data.productNames)
  }
  return out
}

/**
 * Flow edges for a graph. Tunnels and jumps draw above the group frames, memberships under them;
 * a membership takes its product's colour.
 */
function flowEdges(graph: MapGraph): MapFlowEdge[] {
  const productColor = new Map(graph.nodes.flatMap((n) => (n.data.kind === 'product' ? [[n.id, n.data.color] as const] : [])))
  return graph.edges.map((e): MapFlowEdge => {
    const base = { id: e.id, source: e.source, target: e.target }
    const d = e.data
    if (d.kind === 'membership') return { ...base, type: 'membership', zIndex: 0, data: { ...d, color: productColor.get(e.source) ?? 'var(--muted)' } }
    return d.kind === 'jump' ? { ...base, type: 'jump', zIndex: 1, data: { ...d } } : { ...base, type: 'tunnel', zIndex: 1, data: { ...d } }
  })
}

/** Marks the two ends of a hovered edge; one shared object, so an unchanged node keeps its identity. */
const RELATED = { 'data-related': '' } as MapFlowNode['domAttributes']

/** Flow nodes for a laid-out graph: position, size and data only; selection and styling come later. */
function flowNodes(graph: MapGraph, layout: MapLayout): MapFlowNode[] {
  const shared = alsoIn(graph)
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
        data: n.data.kind === 'environment' ? { ...n.data, alsoIn: shared.get(n.id) ?? [] } : { ...n.data },
      } as MapFlowNode,
    ]
  })
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
  onSelect,
  onActivate,
  onEdgeSelect,
}: MapCanvasProps) {
  const motionSafe = useMotionSafe()
  const flow = useReactFlow()

  const base = useMemo(() => flowNodes(graph, layout), [graph, layout])

  // Drags and measurements apply to a local copy, which only a new graph or layout resets.
  const [local, setLocal] = useState({ from: base, nodes: base })
  if (local.from !== base) setLocal({ from: base, nodes: base })
  // Selection belongs to the page, so React Flow's own select changes are dropped.
  const onNodesChange = useCallback((changes: NodeChange<MapFlowNode>[]) => {
    const kept = changes.filter((c) => c.type !== 'select')
    if (kept.length) setLocal((s) => ({ ...s, nodes: applyNodeChanges(kept, s.nodes) }))
  }, [])

  const edges = useMemo(() => flowEdges(graph), [graph])

  // Hovering an edge rings its two end nodes.
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const related = useMemo(() => {
    const e = hoveredEdge ? graph.edges.find((x) => x.id === hoveredEdge) : undefined
    return e ? new Set([e.source, e.target]) : null
  }, [graph, hoveredEdge])
  const onEdgeMouseEnter = useCallback((_: MouseEvent, e: MapFlowEdge) => setHoveredEdge(e.id), [])
  const onEdgeMouseLeave = useCallback(() => setHoveredEdge(null), [])
  const edgeActions = useMemo((): EdgeActions => ({ select: onEdgeSelect, hover: setHoveredEdge }), [onEdgeSelect])

  // Selection and styling go on at render time, so changing them never moves a dragged node back.
  const nodes = useMemo(
    () =>
      local.nodes.map((n) => {
        const selected = n.id === selectedId
        const className = [dimmed?.has(n.id) && 'od-dimmed', highlightId === n.id && 'od-highlight'].filter(Boolean).join(' ') || undefined
        const domAttributes = related?.has(n.id) ? RELATED : undefined
        return !!n.selected === selected && n.className === className && n.domAttributes === domAttributes
          ? n
          : { ...n, selected, className, domAttributes }
      }),
    [local.nodes, selectedId, dimmed, highlightId, related],
  )

  const colors = useMemo(() => minimapColors(graph), [graph])
  const nodeColor = useCallback((n: MapFlowNode) => colors.get(n.id) ?? 'var(--muted)', [colors])

  const onNodeClick = useCallback((_: unknown, n: MapFlowNode) => onSelect(n.id), [onSelect])
  const onNodeDoubleClick = useCallback((_: unknown, n: MapFlowNode) => onActivate(n.id), [onActivate])
  const onEdgeClick = useCallback((_: unknown, e: MapFlowEdge) => onEdgeSelect(e.id), [onEdgeSelect])
  const onPaneClick = useCallback(() => onSelect(null), [onSelect])

  // Canvas keys live here, not in global shortcuts, so typing in a search box never zooms.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
      const duration = motionSafe ? ZOOM_MS : 0
      if (e.key === '+' || e.key === '=') void flow.zoomIn({ duration })
      else if (e.key === '-') void flow.zoomOut({ duration })
      else if (e.key === '0') void flow.fitView({ duration, padding: FIT_PADDING })
      else return
      e.preventDefault()
    },
    [flow, motionSafe],
  )

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
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: FIT_PADDING }}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={nodes.length > VIRTUALIZE_AT}
        colorMode="dark"
        // These land on React Flow's own role="application" root, the canvas's one tab stop.
        tabIndex={0}
        aria-roledescription="map"
        aria-label="Topology map"
        onKeyDown={onKeyDown}
      >
        <Background variant={BackgroundVariant.Dots} />
        <MiniMap<MapFlowNode> pannable zoomable nodeColor={nodeColor} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </EdgeActionsContext.Provider>
  )
})
