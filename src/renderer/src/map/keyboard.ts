import type { MapGraph } from './graph'

/** How arrow keys walk the map: Product → Environment → Host, with this Mac to the right of its tunnel hosts. */
export interface FocusModel {
  /** Every node in drawing order; the first is where focus starts. */
  order: string[]
  /** Where ArrowLeft goes; null for the top level (products, groups with no product drawn, this Mac). */
  parent: Record<string, string | null>
  /** Where ArrowRight goes, first child first. */
  children: Record<string, string[]>
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

export function focusModel(graph: MapGraph): FocusModel {
  const order = graph.nodes.map((n) => n.id)
  const parent: Record<string, string | null> = {}
  const children: Record<string, string[]> = {}
  for (const id of order) children[id] = []
  // A group belongs to its primary product only, as it is drawn.
  const primary = new Map(graph.edges.flatMap((e) => (e.data.kind === 'membership' && e.data.primary ? [[e.target, e.source] as const] : [])))
  for (const n of graph.nodes) {
    const up = n.parentId ?? primary.get(n.id) ?? null
    parent[n.id] = up
    if (up) children[up].push(n.id)
  }
  // A host a tunnel is drawn from goes right to this Mac; the Mac itself stays top level.
  for (const e of graph.edges) {
    if (e.data.kind !== 'tunnel') continue
    const hostEnd = e.source === 'mac' ? e.target : e.source
    if (children[hostEnd] && !children[hostEnd].includes('mac')) children[hostEnd].push('mac')
  }
  return { order, parent, children }
}

/** The node a key moves focus to; the same id when the key goes nowhere. Pure. */
export function nextFocus(model: FocusModel, id: string | null, key: string): string | null {
  if (!ARROWS.has(key)) return id
  if (id === null || !(id in model.parent)) return model.order[0] ?? null
  if (key === 'ArrowRight') return model.children[id][0] ?? id
  if (key === 'ArrowLeft') return model.parent[id] ?? id
  const up = model.parent[id]
  const siblings = up ? model.children[up] : model.order.filter((x) => model.parent[x] === null)
  const at = siblings.indexOf(id)
  if (key === 'Home') return siblings[0]
  if (key === 'End') return siblings[siblings.length - 1]
  return siblings[Math.min(siblings.length - 1, Math.max(0, at + (key === 'ArrowDown' ? 1 : -1)))]
}
