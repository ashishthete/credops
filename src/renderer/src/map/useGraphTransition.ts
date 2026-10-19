import type { Edge, Node } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { diffLayout, type MapLayout, type Placed } from './layout'

/** A glide's length, and how long an entering node keeps its fade-in class. */
export const GLIDE_MS = 300
/** How long a removed node and its edges stay, fading, before they are dropped. */
export const LEAVE_MS = 180
// A timer that fires a hair early still settles what is due.
const DUE_SLACK_MS = 1

export const ENTER_CLASS = 'od-node-enter'
export const EDGE_ENTER_CLASS = 'od-edge-enter'
export const LEAVING_CLASS = 'od-leaving'
const LEAVING_ATTRS = { 'data-leaving': 'true' }

export interface FlowGraph<N extends Node = Node, E extends Edge = Edge> {
  nodes: N[]
  edges: E[]
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

interface Glide {
  from: Placed
  to: Placed
  start: number
  end: number
}

interface Shown<N extends Node, E extends Edge> {
  target: FlowGraph<N, E>
  /** What is drawn now: the target, part-way along its glides, plus whatever is still leaving. */
  nodes: N[]
  edges: E[]
  glides: Map<string, Glide>
  /** Nodes a drag took out of their glide: they stay where they were let go until the next target. */
  held: Map<string, Placed>
  /** Nodes a drag cancelled: their next move lands at once, because the drop already put them there. */
  snap: Set<string>
  entering: Map<string, { until: number; node: N }>
  enteringEdges: Map<string, { until: number; edge: E }>
  leaving: Map<string, { until: number; node: N }>
  leavingEdges: Map<string, { until: number; edge: E }>
}

const boxOf = (n: Node): Placed => ({ id: n.id, x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 })

const layoutOf = (nodes: Node[]): MapLayout => ({
  positions: Object.fromEntries(nodes.map((n) => [n.id, boxOf(n)])),
  bounds: { width: 0, height: 0 },
})

const sameBox = (a: Placed, b: Placed): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const withClass = (current: string | undefined, add: string): string => (current ? `${current} ${add}` : add)

function at(g: Glide, now: number): Placed {
  const k = easeOutCubic(Math.min(1, Math.max(0, (now - g.start) / (g.end - g.start))))
  const mix = (a: number, b: number) => a + (b - a) * k
  return { id: g.to.id, x: mix(g.from.x, g.to.x), y: mix(g.from.y, g.to.y), width: mix(g.from.width, g.to.width), height: mix(g.from.height, g.to.height) }
}

function initial<N extends Node, E extends Edge>(target: FlowGraph<N, E>): Shown<N, E> {
  return {
    target,
    nodes: target.nodes,
    edges: target.edges,
    glides: new Map(),
    held: new Map(),
    snap: new Set(),
    entering: new Map(),
    enteringEdges: new Map(),
    leaving: new Map(),
    leavingEdges: new Map(),
  }
}

/** Draws the state at `now`. A node that is neither gliding nor entering is the target's own object. */
function compose<N extends Node, E extends Edge>(s: Shown<N, E>, now: number): Shown<N, E> {
  if (!s.glides.size && !s.held.size && !s.entering.size && !s.enteringEdges.size && !s.leaving.size && !s.leavingEdges.size) {
    return { ...s, nodes: s.target.nodes, edges: s.target.edges }
  }
  const nodes = s.target.nodes.map((n) => {
    const out = s.entering.get(n.id)?.node ?? n
    const g = s.glides.get(n.id)
    const box = g ? at(g, now) : s.held.get(n.id)
    return box ? ({ ...out, position: { x: box.x, y: box.y }, width: box.width, height: box.height } as N) : out
  })
  const edges = s.target.edges.map((e) => s.enteringEdges.get(e.id)?.edge ?? e)
  for (const { node } of s.leaving.values()) nodes.push(node)
  for (const { edge } of s.leavingEdges.values()) edges.push(edge)
  return { ...s, nodes, edges }
}

/** A new target: what moved glides from where it is drawn, what is new fades in, what went lingers. */
function retarget<N extends Node, E extends Edge>(s: Shown<N, E>, target: FlowGraph<N, E>, now: number, durationMs: number): Shown<N, E> {
  const before = layoutOf(s.nodes)
  const after = layoutOf(target.nodes)
  const drawn = before.positions
  const next = after.positions
  const diff = diffLayout(before, after)
  const snap = new Set(s.snap)

  const glides = new Map<string, Glide>()
  for (const id of diff.moved) {
    if (snap.delete(id)) continue
    const old = s.glides.get(id)
    glides.set(id, old && sameBox(old.to, next[id]) ? old : { from: drawn[id], to: next[id], start: now, end: now + durationMs })
  }

  const entering = new Map<string, { until: number; node: N }>()
  for (const n of target.nodes) {
    const until = s.entering.get(n.id)?.until ?? (diff.entering.includes(n.id) ? now + durationMs : null)
    if (until !== null) entering.set(n.id, { until, node: { ...n, className: withClass(n.className, ENTER_CLASS) } })
  }

  const drawnById = new Map(s.nodes.map((n) => [n.id, n]))
  const leaving = new Map<string, { until: number; node: N }>()
  for (const id of diff.leaving) {
    const was = s.leaving.get(id)
    if (was) {
      leaving.set(id, was)
      continue
    }
    const n = drawnById.get(id)!
    const base = s.target.nodes.find((t) => t.id === id) ?? n
    leaving.set(id, {
      until: now + LEAVE_MS,
      node: {
        ...n,
        className: withClass(base.className, LEAVING_CLASS),
        data: { ...n.data, leaving: true },
        style: { ...n.style, pointerEvents: 'none' },
        domAttributes: { ...n.domAttributes, ...LEAVING_ATTRS },
        extent: undefined,
        selectable: false,
        draggable: false,
        focusable: false,
      } as N,
    })
  }

  const drawnEdges = new Set(s.edges.map((e) => e.id))
  const enteringEdges = new Map<string, { until: number; edge: E }>()
  for (const e of target.edges) {
    const until = s.enteringEdges.get(e.id)?.until ?? (drawnEdges.has(e.id) ? null : now + durationMs)
    if (until !== null) enteringEdges.set(e.id, { until, edge: { ...e, className: withClass(e.className, EDGE_ENTER_CLASS) } })
  }

  // An edge that went lingers with its nodes, as long as both its ends are still drawn.
  const kept = new Set([...target.nodes.map((n) => n.id), ...leaving.keys()])
  const targetEdges = new Set(target.edges.map((e) => e.id))
  const leavingEdges = new Map<string, { until: number; edge: E }>()
  for (const e of s.edges) {
    if (targetEdges.has(e.id) || !kept.has(e.source) || !kept.has(e.target)) continue
    const was = s.leavingEdges.get(e.id)
    leavingEdges.set(
      e.id,
      was ?? {
        until: now + LEAVE_MS,
        edge: {
          ...e,
          className: withClass(s.target.edges.find((t) => t.id === e.id)?.className, LEAVING_CLASS),
          data: { ...e.data, leaving: true },
          domAttributes: { ...e.domAttributes, ...LEAVING_ATTRS },
          selectable: false,
          focusable: false,
        } as E,
      },
    )
  }

  return compose({ target, nodes: s.nodes, edges: s.edges, glides, held: new Map(), snap, entering, enteringEdges, leaving, leavingEdges }, now)
}

/** Settles whatever is due by `now`, and moves the glides on. */
function advance<N extends Node, E extends Edge>(s: Shown<N, E>, now: number): Shown<N, E> {
  const due = now + DUE_SLACK_MS
  const keep = <V extends { until: number }>(m: Map<string, V>) => new Map([...m].filter(([, v]) => v.until > due))
  const glides = new Map([...s.glides].filter(([, g]) => g.end > due))
  const entering = keep(s.entering)
  const enteringEdges = keep(s.enteringEdges)
  const leaving = keep(s.leaving)
  const leavingEdges = keep(s.leavingEdges)
  const settled =
    glides.size === s.glides.size && entering.size === s.entering.size && enteringEdges.size === s.enteringEdges.size &&
    leaving.size === s.leaving.size && leavingEdges.size === s.leavingEdges.size
  // Nothing due and nothing gliding: the same state, so no re-render.
  if (settled && glides.size === 0) return s
  return compose({ ...s, glides, entering, enteringEdges, leaving, leavingEdges }, now)
}

/** The next moment something settles, or null when there is nothing left to do. */
function nextDue(s: Shown<Node, Edge>): number | null {
  const times = [
    ...[...s.glides.values()].map((g) => g.end),
    ...[...s.entering.values(), ...s.enteringEdges.values(), ...s.leaving.values(), ...s.leavingEdges.values()].map((v) => v.until),
  ]
  return times.length ? Math.min(...times) : null
}

// Every mounted transition, so a drag handler can reach the one drawing its node.
const cancellers = new Set<(id: string) => void>()

/** A drag took hold of `id`: it stops where it is drawn, and its next move lands without a glide. */
export function cancelGlide(id: string): void {
  for (const cancel of cancellers) cancel(id)
}

function hold<N extends Node, E extends Edge>(s: Shown<N, E>, id: string, now: number): Shown<N, E> {
  const g = s.glides.get(id)
  if (!g && s.snap.has(id)) return s
  const snap = new Set(s.snap).add(id)
  if (!g) return { ...s, snap }
  const glides = new Map(s.glides)
  glides.delete(id)
  return compose({ ...s, glides, held: new Map(s.held).set(id, at(g, now)), snap }, now)
}

/**
 * Eases a graph from one target to the next: moved nodes glide (position and size together), new ones
 * fade in, removed ones linger faded for LEAVE_MS. The first target, and every target under reduced
 * motion, is drawn as is. Frames are requested only while something glides; otherwise a single timer
 * waits for the next thing due, and an idle graph schedules nothing.
 */
export function useGraphTransition<N extends Node, E extends Edge>(
  target: FlowGraph<N, E>,
  { motionSafe, durationMs = GLIDE_MS }: { motionSafe: boolean; durationMs?: number },
): FlowGraph<N, E> {
  const [shown, setShown] = useState(() => initial(target))
  if (shown.target !== target) setShown(motionSafe ? retarget(shown, target, performance.now(), durationMs) : initial(target))
  else if (!motionSafe && shown.nodes !== target.nodes) setShown(initial(target))

  useEffect(() => {
    if (!motionSafe) return
    const due = nextDue(shown as Shown<Node, Edge>)
    if (due === null) return
    const tick = () => setShown((s) => advance(s, performance.now()))
    const timer = setTimeout(tick, Math.max(0, due - performance.now()))
    const frame = shown.glides.size ? requestAnimationFrame(tick) : 0
    return () => {
      clearTimeout(timer)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [shown, motionSafe])

  useEffect(() => {
    const cancel = (id: string) => setShown((s) => hold(s, id, performance.now()))
    cancellers.add(cancel)
    return () => {
      cancellers.delete(cancel)
    }
  }, [])

  return motionSafe ? { nodes: shown.nodes, edges: shown.edges } : target
}
