import './flow-stubs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, type InventoryData } from '../../src/renderer/src/inventory/store'
import { buildGraph } from '../../src/renderer/src/map/graph'
import { layoutGraph } from '../../src/renderer/src/map/layout'
import { MapCanvas, type MapCanvasProps } from '../../src/renderer/src/map/MapCanvas'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { emitBridgeEvent, environment, host, mockBridge, product, tunnelMeta, tunnelRuntime } from './helpers'
import { renderShell } from './shell-helpers'

// The real components still render; these record what MapCanvas hands them and spy on the viewport.
const seen = vi.hoisted(() => ({
  flow: [] as Record<string, unknown>[],
  minimap: [] as Record<string, unknown>[],
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitView: vi.fn(),
}))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
      seen.flow.push(props as Record<string, unknown>)
      return createElement(actual.ReactFlow, props)
    },
    MiniMap: (props: Parameters<typeof actual.MiniMap>[0]) => {
      seen.minimap.push(props as Record<string, unknown>)
      return createElement(actual.MiniMap, props)
    },
    useReactFlow: () => ({ ...actual.useReactFlow(), zoomIn: seen.zoomIn, zoomOut: seen.zoomOut, fitView: seen.fitView }),
  }
})

const web = product({ id: 'p1', name: 'Web', color: '#5b8cff' })
const prod = environment({
  id: 'e1',
  name: 'Prod',
  color: '#ef5b5b',
  productIds: ['p1'],
  hosts: [
    { hostId: 'h1', role: 'app' },
    { hostId: 'h2', role: 'db' },
  ],
})
const hosts = [host({ id: 'h1', label: 'web' }), host({ id: 'h2', label: 'pg' })]
const data: InventoryData = { products: [web], environments: [prod], hosts, identities: [], vaults: [] }

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const canvas = () => document.querySelector<HTMLElement>('.react-flow')!
const translateOf = (el: HTMLElement) => el.style.transform.match(/-?[\d.]+/g)!.map(Number)
const lastFlow = () => seen.flow.at(-1)!
const flowNode = (id: string) => (lastFlow().nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === id)!

async function renderCanvas(over: Partial<MapCanvasProps> = {}) {
  const graph = buildGraph({ data, tunnels: [], scope: { kind: 'all' } })
  const props: MapCanvasProps = {
    graph,
    layout: layoutGraph(graph),
    scopeKey: 'all',
    selectedId: null,
    dimmed: null,
    highlightId: null,
    onSelect: () => {},
    onActivate: () => {},
    onEdgeSelect: () => {},
    onPin: () => {},
    ...over,
  }
  const view = render(
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>,
  )
  await flush()
  return { ...view, props }
}

beforeEach(() => {
  vi.useFakeTimers()
  inventoryStore.set(null)
  resetTunnels()
  resetSessions()
  seen.flow.length = 0
  seen.minimap.length = 0
  seen.zoomIn.mockClear()
  seen.zoomOut.mockClear()
  seen.fitView.mockClear()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  resetTunnels()
  resetSessions()
})

describe('map canvas', () => {
  it('a dragged node keeps its place when the selection changes', async () => {
    mockBridge({ 'product:list': [web], 'env:list': [prod], 'host:list': hosts })
    renderShell('/map')
    await flush()
    await flush()
    const start = flowNode('e:e1/h:h1').position
    // The DOM transform is absolute (the group's offset added in); the drag moves it by the same delta,
    // kept inside the group because hosts are bounded by it.
    const [x0, y0] = translateOf(node('e:e1/h:h1')!)
    // React Flow reports a drag as position changes; this is what one frame of a drag sends.
    act(() => {
      ;(lastFlow().onNodesChange as (c: unknown[]) => void)([
        { type: 'position', id: 'e:e1/h:h1', position: { x: start.x + 40, y: start.y - 10 }, dragging: false },
      ])
    })
    await flush()
    expect(flowNode('e:e1/h:h1').position).toEqual({ x: start.x + 40, y: start.y - 10 })

    fireEvent.click(node('e:e1/h:h2')!)
    await flush()
    expect(node('e:e1/h:h2')).toHaveClass('selected')
    expect(flowNode('e:e1/h:h1').position).toEqual({ x: start.x + 40, y: start.y - 10 })
    expect(translateOf(node('e:e1/h:h1')!)).toEqual([x0 + 40, y0 - 10])
  })

  it('runtime churn that leaves the up-count alone does not re-render the canvas', async () => {
    const t1 = tunnelMeta({ id: 't1', hostId: 'h1' })
    mockBridge({
      'product:list': [web],
      'env:list': [prod],
      'host:list': hosts,
      'tunnel:list': [t1],
      'tunnel:status': [tunnelRuntime({ id: 't1', state: 'up' })],
    })
    renderShell('/map')
    await flush()
    await flush()
    expect(screen.getByText('1 environment · 2 hosts · 1 tunnel up')).toBeInTheDocument()
    const renders = seen.flow.length

    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'up', boundPort: 6000 })))
    act(() => emitBridgeEvent('tunnel:stats', [{ id: 't1', bytesIn: 10, bytesOut: 20, rateIn: 1, rateOut: 2, connections: 1, rejected: 0 }]))
    await flush()
    expect(seen.flow.length).toBe(renders)

    // A change that moves the count updates the summary, still without touching the canvas.
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'retrying' })))
    await flush()
    expect(screen.getByText('1 environment · 2 hosts · 0 tunnels up')).toBeInTheDocument()
    expect(seen.flow.length).toBe(renders)
  })

  it('canvas keys zoom and fit only while the canvas itself has focus', async () => {
    await renderCanvas()
    canvas().focus()
    fireEvent.keyDown(canvas(), { key: '+' })
    fireEvent.keyDown(canvas(), { key: '=' })
    fireEvent.keyDown(canvas(), { key: '-' })
    fireEvent.keyDown(canvas(), { key: '0' })
    expect(seen.zoomIn).toHaveBeenCalledTimes(2)
    expect(seen.zoomOut).toHaveBeenCalledTimes(1)
    expect(seen.fitView).toHaveBeenCalledTimes(1)

    // From inside the canvas (a node, a control) or with a modifier, the keys belong to someone else.
    fireEvent.keyDown(node('e:e1/h:h1')!, { key: '+' })
    fireEvent.keyDown(canvas(), { key: '-', metaKey: true })
    fireEvent.keyDown(canvas(), { key: '0', ctrlKey: true })
    expect(seen.zoomIn).toHaveBeenCalledTimes(2)
    expect(seen.zoomOut).toHaveBeenCalledTimes(1)
    expect(seen.fitView).toHaveBeenCalledTimes(1)
  })

  it('the canvas is one labelled tab stop', async () => {
    await renderCanvas()
    expect(canvas()).toHaveAttribute('tabindex', '0')
    expect(canvas()).toHaveAttribute('aria-roledescription', 'map')
    expect(canvas()).toHaveAttribute('aria-label', 'Topology map')
  })

  it('dimmed and highlighted ids map to their classes', async () => {
    await renderCanvas({ dimmed: new Set(['e:e1/h:h1', 'p:p1']), highlightId: 'e:e1/h:h2' })
    expect(node('e:e1/h:h1')).toHaveClass('od-dimmed')
    expect(node('p:p1')).toHaveClass('od-dimmed')
    expect(node('e:e1/h:h2')).toHaveClass('od-highlight')
    expect(node('e:e1/h:h2')).not.toHaveClass('od-dimmed')
    expect(node('e:e1')).not.toHaveClass('od-dimmed')
    expect(node('e:e1')).not.toHaveClass('od-highlight')
  })

  it('the minimap colours nodes by environment', async () => {
    await renderCanvas()
    const color = seen.minimap.at(-1)!.nodeColor as (n: { id: string }) => string
    expect(color({ id: 'p:p1' })).toBe('#5b8cff')
    expect(color({ id: 'e:e1' })).toBe('color-mix(in oklab, #ef5b5b 22%, transparent)')
    expect(color({ id: 'e:e1/h:h1' })).toBe('#ef5b5b')
    expect(color({ id: 'nowhere' })).toBe('var(--muted)')
  })
})
