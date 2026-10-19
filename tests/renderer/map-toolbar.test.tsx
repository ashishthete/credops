import './flow-stubs'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { VIEWPORT_KEY, pinsStore } from '../../src/renderer/src/map/viewport'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { environment, host, mockBridge, product } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe.
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

// The real React Flow runs; fitView is spied on but still moves the viewport, and the last instance
// (and the last ReactFlow props) are kept so a test can read the viewport back or reach a handler.
type Instance = ReturnType<typeof import('@xyflow/react').useReactFlow>
const seen = vi.hoisted(() => ({
  fitView: vi.fn(),
  instance: null as unknown as Instance,
  flow: null as unknown as Record<string, unknown>,
}))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
      seen.flow = props as Record<string, unknown>
      return createElement(actual.ReactFlow, props)
    },
    useReactFlow: () => {
      const instance = actual.useReactFlow()
      seen.instance = instance
      return {
        ...instance,
        fitView: (options?: Parameters<Instance['fitView']>[0]) => {
          seen.fitView(options)
          return instance.fitView(options)
        },
      }
    },
  }
})

const web = product({ id: 'pA', name: 'Web' })
const billing = product({ id: 'pB', name: 'Billing' })
const prod = environment({
  id: 'e1',
  name: 'Prod',
  productIds: ['pA'],
  hosts: [
    { hostId: 'h1', role: 'app' },
    { hostId: 'h2', role: 'db' },
  ],
})
const stage = environment({ id: 'e2', name: 'Stage', productIds: ['pA'], hosts: [{ hostId: 'h1', role: 'app' }] })
const ledger = environment({ id: 'e3', name: 'Ledger', productIds: ['pB'], hosts: [{ hostId: 'h4', role: 'app' }] })
const hosts = [
  host({ id: 'h1', label: 'web-1', address: '10.0.0.5', tags: ['frontend'] }),
  host({ id: 'h2', label: 'pg', address: 'db.internal' }),
  host({ id: 'h4', label: 'ledger-1', address: '10.2.0.1' }),
]

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const toolbar = () => screen.getByRole('toolbar', { name: 'Map tools' })
const search = () => screen.getByPlaceholderText('Find host, environment…')
const select = (name: string) => within(toolbar()).getByRole('combobox', { name }) as HTMLSelectElement
const options = (name: string) => Array.from(select(name).options).map((o) => o.text)
const flowNode = (id: string) => (seen.flow.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === id)!

const at = { search: '' }
function LocationProbe() {
  at.search = useLocation().search
  return null
}

async function renderMap(path = '/map') {
  mockBridge({ 'product:list': [web, billing], 'env:list': [prod, stage, ledger], 'host:list': hosts, 'tunnel:list': [], 'tunnel:status': [] })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
  await flush()
}

// A real drag through d3-drag: press, move past the threshold, release; React Flow then calls
// onNodeDragStop. d3-drag listens for the moves on `event.view`, which jsdom won't take in the constructor.
async function drag(id: string, dx: number) {
  const mouse = (target: Element | Window, type: 'mouseDown' | 'mouseMove' | 'mouseUp', clientX: number) => {
    const event = createEvent[type](target, { button: 0, buttons: 1, clientX, clientY: 100 })
    Object.defineProperty(event, 'view', { value: window })
    fireEvent(target, event)
  }
  mouse(node(id)!, 'mouseDown', 200)
  mouse(window, 'mouseMove', 200 + dx / 2)
  mouse(window, 'mouseMove', 200 + dx)
  mouse(window, 'mouseUp', 200 + dx)
  // d3-drag swallows the click that ends a drag until its next tick.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

async function change(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
  await flush()
}

async function key(el: HTMLElement, k: string) {
  fireEvent.keyDown(el, { key: k })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  seen.fitView.mockClear()
  localStorage.clear()
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
  resetTunnels()
  resetSessions()
  clearToasts()
})

describe('map toolbar', () => {
  it('product filter narrows the graph and the URL', async () => {
    await renderMap()
    expect(node('e:e1')).not.toBeNull()
    expect(within(toolbar()).queryByRole('button', { name: 'Clear filter' })).toBeNull()

    await change(select('Product'), 'pB')
    expect(at.search).toBe('?product=pB')
    expect(node('e:e1')).toBeNull()
    expect(node('e:e1/h:h1')).toBeNull()
    expect(node('e:e3')).not.toBeNull()
    expect(node('e:e3/h:h4')).not.toBeNull()

    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Clear filter' }))
    await flush()
    expect(at.search).toBe('')
    expect(node('e:e1')).not.toBeNull()
    expect(select('Product').value).toBe('')
  })

  it('environment options follow the product', async () => {
    await renderMap()
    expect(options('Product')).toEqual(['All products', 'Billing', 'Web'])
    expect(options('Environment')).toEqual(['All environments', 'Ledger', 'Prod', 'Stage'])

    await change(select('Product'), 'pA')
    expect(options('Environment')).toEqual(['All environments', 'Prod', 'Stage'])
    await change(select('Environment'), 'e1')
    expect(at.search).toBe('?product=pA&env=e1')
    expect(node('e:e2')).toBeNull()
    expect(node('e:e1/h:h2')).not.toBeNull()

    // Prod isn't in Billing, so switching product drops it.
    await change(select('Product'), 'pB')
    expect(at.search).toBe('?product=pB')
    expect(select('Environment').value).toBe('')
    await change(select('Environment'), 'e3')
    expect(at.search).toBe('?product=pB&env=e3')
    await change(select('Environment'), '')
    expect(at.search).toBe('?product=pB')
  })

  it('search dims non-matches and Enter zooms to the best', async () => {
    await renderMap()
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
    })
    expect(search()).toHaveFocus()

    await change(search(), 'web-1')
    expect(within(toolbar()).getByText('2 matches')).toBeInTheDocument()
    expect(node('e:e1/h:h2')).toHaveAttribute('data-dimmed', 'true')
    expect(node('e:e3/h:h4')).toHaveAttribute('data-dimmed', 'true')
    expect(node('p:pB')).toHaveAttribute('data-dimmed', 'true')
    // Matches, and the groups they sit in, stay at full strength.
    expect(node('e:e1/h:h1')).not.toHaveAttribute('data-dimmed')
    expect(node('e:e2/h:h1')).not.toHaveAttribute('data-dimmed')
    expect(node('e:e1')).not.toHaveAttribute('data-dimmed')
    expect(node('e:e3')).toHaveAttribute('data-dimmed', 'true')
    // Products aren't groups, so Web fades too, and an edge to a faded node fades with it.
    expect(node('p:pA')).toHaveAttribute('data-dimmed', 'true')
    expect(document.querySelector('.react-flow__edge[data-id="m:pB>e:e3"]')).toHaveClass('od-dimmed')

    await key(search(), 'Enter')
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e1/h:h1' }], padding: 0.6, maxZoom: 1.25, duration: 450 })
    expect(node('e:e1/h:h1')).toHaveClass('selected')
    expect(node('e:e1/h:h1')).toHaveClass('od-highlight')
    expect(node('e:e1/h:h1')).toHaveClass('od-ring')
    // The panel opens, but typing stays in the search box so Enter can keep cycling.
    expect(screen.getByRole('complementary', { name: 'web-1' })).toBeInTheDocument()
    expect(search()).toHaveFocus()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(node('e:e1/h:h1')).not.toHaveClass('od-highlight')

    await key(search(), 'Enter')
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e2/h:h1' }], padding: 0.6, maxZoom: 1.25, duration: 450 })
    expect(node('e:e2/h:h1')).toHaveClass('selected')
    await key(search(), 'Enter')
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e1/h:h1' }], padding: 0.6, maxZoom: 1.25, duration: 450 })

    // Escape clears the search (the panel stays); nothing is dimmed any more.
    await key(search(), 'Escape')
    expect(search()).toHaveValue('')
    expect(document.querySelector('[data-dimmed]')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'web-1' })).toBeInTheDocument()
  })

  it('search zoom-to jumps under reduced motion', async () => {
    motion.safe = false
    await renderMap()
    await change(search(), 'pg')
    await key(search(), 'Enter')
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e1/h:h2' }], padding: 0.6, maxZoom: 1.25, duration: 0 })
    // The ring is static: no one-shot animation class.
    expect(node('e:e1/h:h2')).toHaveClass('od-highlight')
    expect(node('e:e1/h:h2')).not.toHaveClass('od-ring')
  })

  it('search outside the filter clears the filter first', async () => {
    await renderMap('/map?product=pB')
    expect(node('e:e1/h:h2')).toBeNull()
    await change(search(), 'pg')
    expect(within(toolbar()).getByText('1 match outside filter')).toBeInTheDocument()
    seen.fitView.mockClear()

    await key(search(), 'Enter')
    await flush()
    expect(at.search).toBe('')
    expect(node('e:e1/h:h2')).toHaveClass('selected')
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e1/h:h2' }], padding: 0.6, maxZoom: 1.25, duration: 450 })
    expect(within(toolbar()).getByText('1 match')).toBeInTheDocument()
  })

  it('restores the stored viewport for the scope', async () => {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ 'p:pA': { x: 120, y: -40, zoom: 1.5 }, 'e:e3': { x: 7, y: 8, zoom: 0.5 } }))
    await renderMap('/map?product=pA')
    expect(seen.instance.getViewport()).toEqual({ x: 120, y: -40, zoom: 1.5 })
    expect(document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform).toBe('translate(120px,-40px) scale(1.5)')
    expect(seen.fitView).not.toHaveBeenCalled()

    // A scope change restores that scope's viewport, or fits when it has none stored.
    await change(select('Environment'), 'e1')
    expect(seen.fitView).toHaveBeenLastCalledWith({ padding: 0.15 })
    await change(select('Product'), 'pB')
    await change(select('Environment'), 'e3')
    expect(seen.instance.getViewport()).toEqual({ x: 7, y: 8, zoom: 0.5 })

    // A move is saved for the scope it happened in, 300 ms after it ends.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => {
      ;(seen.flow.onMoveEnd as (e: null, vp: object) => void)(null, { x: 1, y: 2, zoom: 1 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)['e:e3']).toEqual({ x: 7, y: 8, zoom: 0.5 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)['e:e3']).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('Fit view fits every node', async () => {
    await renderMap()
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Fit view' }))
    expect(seen.fitView).toHaveBeenLastCalledWith({ padding: 0.15, duration: 300 })
  })

  it('dragging pins a node and Reset layout clears it', async () => {
    await renderMap()
    const start = flowNode('e:e1/h:h2').position
    expect(within(toolbar()).queryByRole('button', { name: 'Reset layout' })).toBeNull()

    // Leftwards, because pg sits in the last column of a one-row group and pins clamp inside it.
    await drag('e:e1/h:h2', -60)

    const pinned = pinsStore.get().all?.['e:e1/h:h2']
    expect(pinned).toBeDefined()
    expect(pinned).not.toEqual(start)
    // The layout is rebuilt around the pin, and the pin outlives leaving the page.
    expect(flowNode('e:e1/h:h2').position).toEqual(pinned)
    cleanup()
    await renderMap()
    expect(flowNode('e:e1/h:h2').position).toEqual(pinned)

    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Reset layout' }))
    await flush()
    expect(pinsStore.get().all).toBeUndefined()
    expect(flowNode('e:e1/h:h2').position).toEqual(start)
    expect(within(toolbar()).queryByRole('button', { name: 'Reset layout' })).toBeNull()
  })

  it('dragging one host moves and pins only that host, even with another selected', async () => {
    await renderMap()
    fireEvent.click(node('e:e1/h:h1')!)
    await flush()
    expect(node('e:e1/h:h1')).toHaveClass('selected')
    const selectedAt = flowNode('e:e1/h:h1').position

    await drag('e:e1/h:h2', -60)
    expect(Object.keys(pinsStore.get().all ?? {})).toEqual(['e:e1/h:h2'])
    expect(flowNode('e:e1/h:h1').position).toEqual(selectedAt)
    expect(node('e:e1/h:h1')).toHaveClass('selected')
  })

  it('a pan saved just before a scope switch is kept', async () => {
    await renderMap()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => {
      ;(seen.flow.onMoveEnd as (e: null, vp: object) => void)(null, { x: 11, y: 12, zoom: 1.1 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // The switch's own fit ends a move in the new scope; the old scope's pan must still land.
    await change(select('Product'), 'pA')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!).all).toEqual({ x: 11, y: 12, zoom: 1.1 })
  })

  it('after a search zoom, a later selection focuses its panel as usual', async () => {
    await renderMap()
    await change(search(), 'pg')
    await key(search(), 'Enter')
    expect(search()).toHaveFocus()

    fireEvent.click(node('e:e1/h:h1')!)
    await flush()
    const panel = screen.getByRole('complementary', { name: 'web-1' })
    expect(search()).not.toHaveFocus()
    expect(panel.contains(document.activeElement)).toBe(true)
  })
})
