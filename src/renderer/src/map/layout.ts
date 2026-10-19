import type { MapGraph, MapNode } from './graph'

export const HOST_W = 208
export const HOST_H = 64
/** Phase 8 makes this non-zero: room under each host for attached apps. */
export const ATTACH_H = 0
export const GAP = 16
export const GROUP_PAD = 16
export const GROUP_HEADER = 40
export const MAX_COLS = 6
export const PRODUCT_W = 200
export const PRODUCT_H = 56
export const MAC_W = 160
export const MAC_H = 72
export const COL_GAP = 160
export const ROW_GAP = 48
/** `onlyRenderVisibleElements` turns on above this many nodes. */
export const VIRTUALIZE_AT = 120

export interface Placed {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface MapLayout {
  /** Child coordinates are relative to their parent, as React Flow expects. */
  positions: Record<string, Placed>
  bounds: { width: number; height: number }
}

/** Dragged positions by node id, in the same coordinates as `positions`. */
export type Pins = Record<string, { x: number; y: number }>

const MOVE_EPSILON = 0.5

function groupSize(hostCount: number): { cols: number; width: number; height: number } {
  const cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(hostCount))))
  const rows = Math.max(1, Math.ceil(hostCount / cols))
  return {
    cols,
    width: 2 * GROUP_PAD + cols * HOST_W + (cols - 1) * GAP,
    height: GROUP_HEADER + GROUP_PAD + rows * (HOST_H + ATTACH_H) + (rows - 1) * GAP,
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** Pure and deterministic: products | environment groups | this Mac, left to right. */
export function layoutGraph(graph: MapGraph, pins: Pins = {}): MapLayout {
  const positions: Record<string, Placed> = {}
  const place = (id: string, x: number, y: number, width: number, height: number): Placed =>
    (positions[id] = { id, x, y, width, height })

  const products: MapNode[] = []
  const groups: MapNode[] = []
  const hostsByGroup = new Map<string, MapNode[]>()
  for (const n of graph.nodes) {
    if (n.data.kind === 'product') products.push(n)
    else if (n.data.kind === 'environment') groups.push(n)
    else if (n.data.kind === 'host' && n.parentId) {
      const list = hostsByGroup.get(n.parentId)
      if (list) list.push(n)
      else hostsByGroup.set(n.parentId, [n])
    }
  }

  const primaryProduct = new Map<string, string>()
  for (const e of graph.edges) if (e.data.kind === 'membership' && e.data.primary) primaryProduct.set(e.target, e.source)

  const groupX = PRODUCT_W + COL_GAP
  const size = new Map(groups.map((g) => [g.id, groupSize(hostsByGroup.get(g.id)?.length ?? 0)]))
  const groupsOf = (productId: string | null) => groups.filter((g) => (primaryProduct.get(g.id) ?? null) === productId)

  // Groups stacked in product order, then those with no product (`u` last, as buildGraph orders them).
  const groupTop = new Map<string, number>()
  const productY = new Map<string, number>()
  let cursor = 0
  const stack = (list: MapNode[]): { top: number; bottom: number } => {
    const top = cursor
    for (const g of list) {
      groupTop.set(g.id, cursor)
      cursor += size.get(g.id)!.height + ROW_GAP
    }
    return { top, bottom: cursor - ROW_GAP }
  }
  for (const p of products) {
    const own = groupsOf(p.id)
    if (own.length) {
      const span = stack(own)
      productY.set(p.id, (span.top + span.bottom) / 2 - PRODUCT_H / 2)
    } else {
      productY.set(p.id, cursor)
      cursor += PRODUCT_H + ROW_GAP
    }
  }
  stack(groupsOf(null))

  const pinned = (id: string, x: number, y: number) => {
    const pin = pins[id]
    return pin ? { x: pin.x, y: pin.y } : { x, y }
  }

  for (const p of products) {
    const at = pinned(p.id, 0, productY.get(p.id)!)
    place(p.id, at.x, at.y, PRODUCT_W, PRODUCT_H)
  }

  for (const g of groups) {
    const { cols, width, height } = size.get(g.id)!
    const at = pinned(g.id, groupX, groupTop.get(g.id)!)
    place(g.id, at.x, at.y, width, height)
    ;(hostsByGroup.get(g.id) ?? []).forEach((h, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = GROUP_PAD + col * (HOST_W + GAP)
      const y = GROUP_HEADER + row * (HOST_H + ATTACH_H + GAP)
      const pin = pins[h.id]
      place(
        h.id,
        pin ? clamp(pin.x, GROUP_PAD, width - GROUP_PAD - HOST_W) : x,
        pin ? clamp(pin.y, GROUP_HEADER, height - GROUP_PAD - HOST_H - ATTACH_H) : y,
        HOST_W,
        HOST_H,
      )
    })
  }

  const mac = graph.nodes.find((n) => n.id === 'mac')
  if (mac) {
    const widest = groups.reduce((m, g) => Math.max(m, size.get(g.id)!.width), 0)
    let top = Infinity
    let bottom = -Infinity
    for (const e of graph.edges) {
      if (e.data.kind !== 'tunnel') continue
      const hostId = e.source === 'mac' ? e.target : e.source
      const h = positions[hostId]
      const parent = positions[hostId.split('/')[0]]
      if (!h || !parent) continue
      top = Math.min(top, parent.y + h.y)
      bottom = Math.max(bottom, parent.y + h.y + h.height)
    }
    const centre = top === Infinity ? 0 : (top + bottom) / 2
    const at = pinned('mac', groupX + widest + COL_GAP, centre - MAC_H / 2)
    place('mac', at.x, at.y, MAC_W, MAC_H)
  }

  // The extent of everything drawn, so negative pins are covered too.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of graph.nodes) {
    if (n.parentId) continue
    const p = positions[n.id]
    if (!p) continue
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.width)
    maxY = Math.max(maxY, p.y + p.height)
  }
  const bounds = minX === Infinity ? { width: 0, height: 0 } : { width: maxX - minX, height: maxY - minY }
  return { positions, bounds }
}

const differs = (p: Placed, n: Placed): boolean =>
  Math.abs(p.x - n.x) > MOVE_EPSILON || Math.abs(p.y - n.y) > MOVE_EPSILON ||
  Math.abs(p.width - n.width) > MOVE_EPSILON || Math.abs(p.height - n.height) > MOVE_EPSILON

/** `moved` means the position or size changed by more than half a pixel. */
export function diffLayout(
  prev: MapLayout | null,
  next: MapLayout,
): { entering: string[]; leaving: string[]; moved: string[] } {
  const before = prev?.positions ?? {}
  const entering: string[] = []
  const moved: string[] = []
  for (const [id, n] of Object.entries(next.positions)) {
    const p = before[id]
    if (!p) entering.push(id)
    else if (differs(p, n)) moved.push(id)
  }
  const leaving = Object.keys(before).filter((id) => !(id in next.positions))
  return { entering, leaving, moved }
}
