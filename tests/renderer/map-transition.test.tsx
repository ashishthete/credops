import './flow-stubs'
import { act, cleanup, createEvent, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, type InventoryData } from '../../src/renderer/src/inventory/store'
import { GAP, HOST_H } from '../../src/renderer/src/map/layout'
import { useGraphTransition } from '../../src/renderer/src/map/useGraphTransition'
import { pinsStore } from '../../src/renderer/src/map/viewport'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { environment, host, mockBridge, product, tunnelMeta } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe.
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const web = product({ id: 'pA', name: 'Web' })
const prod = environment({
  id: 'e1',
  name: 'Prod',
  productIds: ['pA'],
  hosts: [
    { hostId: 'h1', role: 'app' },
    { hostId: 'h2', role: 'db' },
  ],
})
const stage = environment({ id: 'e2', name: 'Stage', productIds: ['pA'], hosts: [{ hostId: 'h3', role: 'app' }] })
const hosts = [host({ id: 'h1', label: 'web-1' }), host({ id: 'h2', label: 'pg' }), host({ id: 'h3', label: 'stage-1' })]
const t1 = tunnelMeta({ id: 't1', label: 'pg-local', hostId: 'h2', environmentId: 'e1' })
// A third Prod host wraps the group onto a second row, so Stage below it moves down by one row.
const ROW = HOST_H + GAP

const flush = () => act(async () => {})
// A frame at a time, so React commits each frame and the next one gets requested, as in a browser.
const FRAME_MS = 16
async function elapse(ms: number) {
  for (let left = ms; left > 0; left -= FRAME_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(FRAME_MS, left))
    })
  }
}
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const edge = (id: string) => document.querySelector<SVGGElement>(`[data-testid="rf__edge-${id}"]`)
/** The node's drawn top edge, read back from React Flow's wrapper transform. */
const yOf = (id: string) => Number(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node(id)!.style.transform)![2])
const xOf = (id: string) => Number(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node(id)!.style.transform)![1])

async function renderMap() {
  mockBridge({ 'product:list': [web], 'env:list': [prod, stage], 'host:list': hosts, 'tunnel:list': [t1], 'tunnel:status': [] })
  render(
    <MemoryRouter initialEntries={['/map']}>
      <AppShell />
    </MemoryRouter>,
  )
  await flush()
  await flush()
}

/** An inventory edit, as a reload would deliver it. */
async function edit(change: (data: InventoryData) => InventoryData) {
  act(() => inventoryStore.set(change(inventoryStore.get()!)))
  await flush()
}

const addHost = (id: string) =>
  edit((d) => ({
    ...d,
    hosts: [...d.hosts, host({ id, label: `web-${id}` })],
    environments: d.environments.map((e) => (e.id === 'e1' ? { ...e, hosts: [...e.hosts, { hostId: id, role: 'app' as const }] } : e)),
  }))

const removeHost = (id: string) =>
  edit((d) => ({
    ...d,
    hosts: d.hosts.filter((h) => h.id !== id),
    environments: d.environments.map((e) => ({ ...e, hosts: e.hosts.filter((m) => m.hostId !== id) })),
  }))

/** A real drag through d3-drag, which listens for the moves on `event.view`, through each offset in turn. */
async function dragThrough(id: string, offsets: number[]) {
  const mouse = (target: Element | Window, type: 'mouseDown' | 'mouseMove' | 'mouseUp', clientX: number) => {
    const event = createEvent[type](target, { button: 0, buttons: 1, clientX, clientY: 100 })
    Object.defineProperty(event, 'view', { value: window })
    fireEvent(target, event)
  }
  mouse(node(id)!, 'mouseDown', 200)
  for (const dx of offsets) mouse(window, 'mouseMove', 200 + dx)
  mouse(window, 'mouseUp', 200 + offsets[offsets.length - 1])
  // d3-drag swallows the click that ends a drag until its next tick.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

const drag = (id: string, dx: number) => dragThrough(id, [dx / 2, dx])

// jsdom lays the canvas out at 0×0, so every pointer would sit on its edge and React Flow would auto-pan
// the drag in a frame loop that outlives it. The canvas gets the stub viewport's bounds instead.
const rect = HTMLElement.prototype.getBoundingClientRect
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-flow') ? new DOMRect(0, 0, 1000, 800) : rect.call(this)
  })
})

beforeEach(() => {
  // Fake only the clocks, never requestAnimationFrame: jsdom drives it from the fake setInterval.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  motion.safe = true
  pinsStore.set({})
  inventoryStore.set(null)
  resetTunnels()
  resetSessions()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetTunnels()
  resetSessions()
  clearToasts()
})

describe('map transitions', () => {
  it('a moved node glides to its new position', async () => {
    await renderMap()
    const from = yOf('e:e2')

    await addHost('h4')
    expect(yOf('e:e2')).toBe(from)

    await elapse(150)
    expect(yOf('e:e2')).toBeGreaterThan(from)
    expect(yOf('e:e2')).toBeLessThan(from + ROW)

    await elapse(150)
    expect(yOf('e:e2')).toBe(from + ROW)
  })

  it('a group resizes as it glides', async () => {
    await renderMap()
    const from = parseFloat(node('e:e1')!.style.height)

    await addHost('h4')
    expect(parseFloat(node('e:e1')!.style.height)).toBe(from)
    await elapse(150)
    const mid = parseFloat(node('e:e1')!.style.height)
    expect(mid).toBeGreaterThan(from)
    expect(mid).toBeLessThan(from + ROW)
    await elapse(150)
    expect(parseFloat(node('e:e1')!.style.height)).toBe(from + ROW)
  })

  it('an entering host fades in', async () => {
    await renderMap()
    await addHost('h4')
    expect(node('e:e1/h:h4')).toHaveClass('od-node-enter')
    // Nodes already drawn don't fade in again.
    expect(node('e:e1/h:h1')).not.toHaveClass('od-node-enter')

    await elapse(300)
    expect(node('e:e1/h:h4')).not.toHaveClass('od-node-enter')
  })

  it('an entering tunnel edge fades in with its host', async () => {
    await renderMap()
    await addHost('h4')
    act(() => tunnelStore.set({ ...tunnelStore.get(), tunnels: [...tunnelStore.get().tunnels, tunnelMeta({ id: 't4', label: 'new', hostId: 'h4', environmentId: 'e1' })] }))
    await flush()
    expect(edge('t:t4')).toHaveClass('od-edge-enter')
    expect(edge('t:t1')).not.toHaveClass('od-edge-enter')

    await elapse(300)
    expect(edge('t:t4')).not.toHaveClass('od-edge-enter')
  })

  it('a removed host lingers then leaves', async () => {
    await renderMap()
    expect(edge('t:t1')).not.toBeNull()

    await removeHost('h2')
    act(() => tunnelStore.set({ ...tunnelStore.get(), tunnels: [] }))
    await flush()
    const leaving = node('e:e1/h:h2')!
    expect(leaving).toHaveAttribute('data-leaving', 'true')
    expect(leaving.style.pointerEvents).toBe('none')
    expect(edge('t:t1')).toHaveAttribute('data-leaving', 'true')
    expect(node('e:e1/h:h1')).not.toHaveAttribute('data-leaving')

    await elapse(180)
    expect(node('e:e1/h:h2')).toBeNull()
    expect(edge('t:t1')).toBeNull()
    expect(node('mac')).toBeNull()
  })

  it('a rebuild mid-glide continues from the current position', async () => {
    await renderMap()
    const from = yOf('e:e2')
    await addHost('h4')
    await elapse(150)
    const mid = yOf('e:e2')

    // Back where it came from: it turns around where it is at that moment, with no jump (mid is the last
    // frame's, a moment earlier).
    await removeHost('h4')
    expect(yOf('e:e2')).toBe(from + ROW * 0.875) // easeOutCubic(0.5)
    expect(yOf('e:e2')).toBeGreaterThanOrEqual(mid)
    await elapse(100)
    expect(yOf('e:e2')).toBeLessThan(mid)
    expect(yOf('e:e2')).toBeGreaterThan(from)
    await elapse(200)
    expect(yOf('e:e2')).toBe(from)
  })

  it('reduced motion skips the glide', async () => {
    motion.safe = false
    await renderMap()
    const from = yOf('e:e2')

    await addHost('h4')
    expect(yOf('e:e2')).toBe(from + ROW)
    expect(document.querySelector('.od-node-enter')).toBeNull()

    await removeHost('h2')
    expect(node('e:e1/h:h2')).toBeNull()
    expect(document.querySelector('[data-leaving]')).toBeNull()
  })

  it('first render does not animate', async () => {
    await renderMap()
    expect(node('e:e2')).not.toBeNull()
    expect(document.querySelector('.od-node-enter, .od-edge-enter, [data-leaving]')).toBeNull()
  })

  it('a scope switch redraws at once rather than gliding', async () => {
    await renderMap()
    await edit((d) => d) // no-op: a new snapshot with nothing moved
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'e2' } })
    await flush()
    expect(node('e:e1')).toBeNull()
    expect(document.querySelector('.od-node-enter, [data-leaving]')).toBeNull()
  })

  it('the panel stays open while its host glides', async () => {
    await renderMap()
    fireEvent.click(node('e:e2/h:h3')!)
    await flush()
    expect(screen.getByRole('complementary', { name: 'stage-1' })).toBeInTheDocument()

    await addHost('h4')
    await elapse(150)
    expect(screen.getByRole('complementary', { name: 'stage-1' })).toBeInTheDocument()
    expect(node('e:e2/h:h3')).toHaveClass('selected')
    await elapse(150)
    expect(screen.getByRole('complementary', { name: 'stage-1' })).toBeInTheDocument()
    expect(node('e:e2/h:h3')).toHaveClass('selected')
  })

  it('dragging a gliding node takes it out of the glide, and the drop wins', async () => {
    await renderMap()
    await addHost('h4')
    await elapse(100)
    const x = xOf('e:e2')

    await drag('e:e2', -60)
    const pin = pinsStore.get().all?.['e:e2']
    expect(pin).toBeDefined()
    expect(pin!.x).toBeLessThan(x)
    expect(xOf('e:e2')).toBe(pin!.x)
    expect(yOf('e:e2')).toBe(pin!.y)
    await elapse(300)
    expect(xOf('e:e2')).toBe(pin!.x)
    expect(yOf('e:e2')).toBe(pin!.y)
  })

  it('Reset layout glides the node back', async () => {
    await renderMap()
    const start = xOf('e:e2')
    await drag('e:e2', -60)
    const dragged = xOf('e:e2')
    expect(dragged).toBeLessThan(start)

    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
    await flush()
    expect(xOf('e:e2')).toBe(dragged)
    await elapse(150)
    expect(xOf('e:e2')).toBeGreaterThan(dragged)
    expect(xOf('e:e2')).toBeLessThan(start)
    await elapse(150)
    expect(xOf('e:e2')).toBe(start)
  })
})

describe('map transitions, round 1', () => {
  it('a drop in place leaves no mark, so the next move still glides', async () => {
    await renderMap()
    const start = yOf('e:e2')
    const x = xOf('e:e2')
    // Taken hold of and let go where it was (React Flow measures the drag from the move that starts it):
    // pinned, but not moved.
    await dragThrough('e:e2', [40, 40])
    expect(pinsStore.get().all?.['e:e2']).toEqual({ x, y: start })
    expect(xOf('e:e2')).toBe(x)
    expect(yOf('e:e2')).toBe(start)
    // Pinned, so the new row doesn't move it; Reset layout then does.
    await addHost('h4')
    await elapse(300)
    expect(yOf('e:e2')).toBe(start)

    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
    await flush()
    expect(yOf('e:e2')).toBe(start)
    await elapse(150)
    expect(yOf('e:e2')).toBeGreaterThan(start)
    expect(yOf('e:e2')).toBeLessThan(start + ROW)
    await elapse(150)
    expect(yOf('e:e2')).toBe(start + ROW)
  })

  it('a dimmed node fades out from its dimmed strength, and stays inert', async () => {
    await renderMap()
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
    })
    fireEvent.change(screen.getByPlaceholderText('Find host, environment…'), { target: { value: 'web-1' } })
    await flush()
    expect(node('e:e1/h:h2')).toHaveClass('od-dimmed')

    await removeHost('h2')
    let leaving = node('e:e1/h:h2')!
    expect(leaving).toHaveAttribute('data-leaving', 'true')
    expect(leaving).toHaveClass('od-leaving')
    expect(leaving).toHaveClass('od-dimmed')
    expect(leaving.style.pointerEvents).toBe('none')
    // Its tunnel goes with it, faded as it was.
    expect(edge('t:t1')).toHaveAttribute('data-leaving', 'true')
    expect(edge('t:t1')).toHaveClass('od-dimmed')
    // Still faded on the frames after, while it goes.
    await elapse(100)
    leaving = node('e:e1/h:h2')!
    expect(leaving).toHaveClass('od-dimmed')
    expect(leaving.style.pointerEvents).toBe('none')
    await elapse(100)
    expect(node('e:e1/h:h2')).toBeNull()
  })

  it('unmounting mid-glide and mid-leave leaves no timer or frame behind', async () => {
    // Frames still pending: requested, and neither run nor cancelled.
    const pending = new Set<number>()
    const raf = window.requestAnimationFrame.bind(window)
    const caf = window.cancelAnimationFrame.bind(window)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = raf((t) => {
        pending.delete(id)
        cb(t)
      })
      pending.add(id)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pending.delete(id)
      caf(id)
    })
    const errors = vi.spyOn(console, 'error')
    await renderMap()
    // Two new hosts and one gone: Prod still wraps to a second row, so Stage glides while pg leaves.
    await addHost('h4')
    await addHost('h5')
    await removeHost('h2')
    await elapse(50)
    expect(node('e:e1/h:h2')).toHaveAttribute('data-leaving', 'true')
    // Mid-glide (a frame is waiting) and mid-leave.
    expect(pending.size).toBeGreaterThan(0)

    cleanup()
    // Its frame is cancelled at once. Any timer still counted here is jsdom's frame clock, which
    // framer-motion's frame loop (the shell's, not the map's) holds for one more frame; the hook's own
    // timers are checked straight after unmount in the hook tests below.
    expect(pending.size).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(pending.size).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('useGraphTransition', () => {
  const n = (id: string, y: number): Node => ({ id, position: { x: 0, y }, width: 10, height: 10, data: {} })
  const target = (nodes: Node[], edges: Edge[] = []) => ({ nodes, edges })

  it('returns the target itself when idle, and asks for no frames', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const first = target([n('a', 0)])
    const { result, rerender } = renderHook(({ t }) => useGraphTransition(t, { motionSafe: true }), { initialProps: { t: first } })
    expect(result.current.nodes).toBe(first.nodes)
    rerender({ t: target(first.nodes) })
    expect(result.current.nodes).toBe(first.nodes)
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('eases out: past halfway at half the duration', async () => {
    const { result, rerender } = renderHook(({ t }) => useGraphTransition(t, { motionSafe: true, durationMs: 100 }), {
      initialProps: { t: target([n('a', 0)]) },
    })
    rerender({ t: target([n('a', 100)]) })
    expect(result.current.nodes[0].position.y).toBe(0)
    await elapse(50)
    const y = result.current.nodes[0].position.y
    expect(y).toBeGreaterThan(50)
    expect(y).toBeLessThan(100)
    await elapse(50)
    expect(result.current.nodes[0].position.y).toBe(100)
  })

  it('a new target mid-glide starts from where the node is at that moment, not at the last frame', async () => {
    const { result, rerender } = renderHook(({ t }) => useGraphTransition(t, { motionSafe: true, durationMs: 100 }), {
      initialProps: { t: target([n('a', 0)]) },
    })
    rerender({ t: target([n('a', 100)]) })
    // Half way between frames: the last one drew the node a little short of here.
    await elapse(50)
    rerender({ t: target([n('a', 0)]) })
    expect(result.current.nodes[0].position.y).toBe(87.5) // easeOutCubic(0.5) of the way to 100
  })

  it('unmounting mid-glide clears its timer and its frame', async () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { rerender, unmount } = renderHook(({ t }) => useGraphTransition(t, { motionSafe: true }), {
      initialProps: { t: target([n('a', 0)]) },
    })
    rerender({ t: target([n('a', 100)]) })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
