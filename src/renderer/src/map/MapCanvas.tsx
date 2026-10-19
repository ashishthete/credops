import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { useMotionSafe } from '../ui/motion'
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
function minimapColors(graph: MapGraph): Map<string, string> {
  const colors = new Map<string, string>()
  for (const n of graph.nodes) {
    const d = n.data
    if (d.kind === 'product') colors.set(n.id, d.color)
    else if (d.kind === 'environment') colors.set(n.id, `color-mix(in oklab, ${d.color} 22%, transparent)`)
  }
  for (const n of graph.nodes) {
    if (n.data.kind !== 'host') continue
    const group = graph.nodes.find((g) => g.id === n.parentId)
    if (group?.data.kind === 'environment') colors.set(n.id, group.data.color)
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
 * The React Flow canvas for a graph and its layout. Needs a `ReactFlowProvider` above it, so the page
 * and its toolbar can reach the viewport through `useReactFlow` too.
 */
export function MapCanvas({ graph, layout, selectedId, dimmed, highlightId, onSelect, onActivate, onEdgeSelect }: MapCanvasProps) {
  const motionSafe = useMotionSafe()
  const flow = useReactFlow()

  const nodes = useMemo((): MapFlowNode[] => {
    const shared = alsoIn(graph)
    return graph.nodes.flatMap((n) => {
      const at = layout.positions[n.id]
      if (!at) return []
      const classes = [dimmed?.has(n.id) && 'od-dimmed', highlightId === n.id && 'od-highlight'].filter(Boolean).join(' ')
      return [
        {
          id: n.id,
          type: n.data.kind,
          position: { x: at.x, y: at.y },
          width: at.width,
          height: at.height,
          ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
          data: n.data.kind === 'environment' ? { ...n.data, alsoIn: shared.get(n.id) ?? [] } : { ...n.data },
          selected: n.id === selectedId,
          className: classes || undefined,
        } as MapFlowNode,
      ]
    })
  }, [graph, layout, selectedId, dimmed, highlightId])

  const edges = useMemo(
    (): Edge[] => graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { ...e.data } })),
    [graph],
  )

  // Drags and measurements apply locally; selection belongs to the page. A new graph or layout resets both.
  const [local, setLocal] = useState({ from: nodes, nodes })
  if (local.from !== nodes) setLocal({ from: nodes, nodes })
  const onNodesChange = useCallback((changes: NodeChange<MapFlowNode>[]) => {
    const kept = changes.filter((c) => c.type !== 'select')
    if (kept.length) setLocal((s) => ({ ...s, nodes: applyNodeChanges(kept, s.nodes) }))
  }, [])

  const colors = useMemo(() => minimapColors(graph), [graph])

  // Canvas keys live here, not in global shortcuts, so typing in a search box never zooms.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    const duration = motionSafe ? ZOOM_MS : 0
    if (e.key === '+' || e.key === '=') void flow.zoomIn({ duration })
    else if (e.key === '-') void flow.zoomOut({ duration })
    else if (e.key === '0') void flow.fitView({ duration, padding: FIT_PADDING })
    else return
    e.preventDefault()
  }

  return (
    <ReactFlow<MapFlowNode>
      nodes={local.nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => onSelect(n.id)}
      onNodeDoubleClick={(_, n) => onActivate(n.id)}
      onEdgeClick={(_, e) => onEdgeSelect(e.id)}
      onPaneClick={() => onSelect(null)}
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
      <MiniMap pannable zoomable nodeColor={(n) => colors.get(n.id) ?? 'var(--muted)'} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
