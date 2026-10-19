import './flow-stubs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { createElement, Profiler, type ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { edgeTone } from '../../src/renderer/src/map/edges'
import { buildGraph } from '../../src/renderer/src/map/graph'
import { layoutGraph } from '../../src/renderer/src/map/layout'
import { MapCanvas } from '../../src/renderer/src/map/MapCanvas'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import type { TunnelStats } from '../../src/shared/tunnels'
import { emitBridgeEvent, environment, host, mockBridge, product, tunnelMeta, tunnelRuntime } from './helpers'
import { renderShell } from './shell-helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe.
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

// Render counts per edge or node id. A Profiler counts every commit inside the component, including
// the ones its own store subscriptions cause, which a plain wrapper would not see.
const renders = vi.hoisted(() => ({ edges: new Map<string, number>(), hosts: new Map<string, number>(), flow: 0, edges_: [] as { id: string; zIndex?: number }[] }))
const counted = vi.hoisted(
  () =>
    (Inner: ComponentType<{ id: string }>, into: Map<string, number>, h: typeof createElement, P: typeof Profiler) =>
      function Counted(props: { id: string }) {
        return h(P, { id: props.id, onRender: () => into.set(props.id, (into.get(props.id) ?? 0) + 1) }, h(Inner, props))
      },
)
vi.mock('../../src/renderer/src/map/edges', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/map/edges')>()
  const { createElement: h, Profiler: P } = await import('react')
  return { ...actual, edgeTypes: { ...actual.edgeTypes, tunnel: counted(actual.edgeTypes.tunnel as never, renders.edges, h, P) } }
})
vi.mock('../../src/renderer/src/map/nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/map/nodes')>()
  const { createElement: h, Profiler: P } = await import('react')
  return { ...actual, nodeTypes: { ...actual.nodeTypes, host: counted(actual.nodeTypes.host as never, renders.hosts, h, P) } }
})
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
      renders.flow++
      renders.edges_ = (props.edges ?? []) as { id: string; zIndex?: number }[]
      return createElement(actual.ReactFlow, props)
    },
  }
})

// The graph and its layout are built only when the inventory or the tunnel list changes.
const spies = vi.hoisted(() => ({ build: 0, layout: 0 }))
vi.mock('../../src/renderer/src/map/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/map/graph')>()
  return {
    ...actual,
    buildGraph: (...args: Parameters<typeof actual.buildGraph>) => {
      spies.build++
      return actual.buildGraph(...args)
    },
  }
})
vi.mock('../../src/renderer/src/map/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/map/layout')>()
  return {
    ...actual,
    layoutGraph: (...args: Parameters<typeof actual.layoutGraph>) => {
      spies.layout++
      return actual.layoutGraph(...args)
    },
  }
})

const web = product({ id: 'p1', name: 'Web', color: '#5b8cff' })
const shop = product({ id: 'p2', name: 'Shop', color: '#f0a020' })
// Prod belongs to both products: Web (first by id) is its primary, Shop a secondary membership.
const prod = environment({
  id: 'e1',
  name: 'Prod',
  color: '#ef5b5b',
  productIds: ['p1', 'p2'],
  defaultJumpHostId: 'h1',
  hosts: [
    { hostId: 'h1', role: 'bastion' },
    { hostId: 'h2', role: 'app' },
    { hostId: 'h3', role: 'db' },
  ],
})
// h2 names its own jump host; h3 inherits Prod's default.
const hosts = [host({ id: 'h1', label: 'gate' }), host({ id: 'h2', label: 'api', jumpHostId: 'h1' }), host({ id: 'h3', label: 'pg' })]
const t1 = tunnelMeta({ id: 't1', hostId: 'h2', label: 'api-local', type: 'L' })
const t2 = tunnelMeta({ id: 't2', hostId: 'h3', label: 'pg-local', type: 'D' })
const t3 = tunnelMeta({ id: 't3', hostId: 'h2', label: 'hook', type: 'R' })

const flush = () => act(async () => {})
const edge = (id: string) => document.querySelector<SVGGElement>(`[data-testid="rf__edge-${id}"]`)
const pathOf = (id: string) => edge(id)!.querySelector<SVGPathElement>('path.react-flow__edge-path')!
const stats = (over: Partial<TunnelStats> & { id: string }): TunnelStats => ({
  bytesIn: 0,
  bytesOut: 0,
  rateIn: 0,
  rateOut: 0,
  connections: 1,
  rejected: 0,
  ...over,
})

async function renderMap(status = [tunnelRuntime({ id: 't1', state: 'up' }), tunnelRuntime({ id: 't2', state: 'up' })]) {
  mockBridge({
    'product:list': [web, shop],
    'env:list': [prod],
    'host:list': hosts,
    'tunnel:list': [t1, t2, t3],
    'tunnel:status': status,
  })
  renderShell('/map')
  await flush()
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  inventoryStore.set(null)
  resetTunnels()
  resetSessions()
  renders.edges.clear()
  renders.hosts.clear()
  renders.flow = 0
  spies.build = 0
  spies.layout = 0
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

describe('edgeTone', () => {
  it('maps every tunnel state to a tone', () => {
    expect(edgeTone('up')).toBe('ok')
    expect(edgeTone('connecting')).toBe('warn')
    expect(edgeTone('retrying')).toBe('warn')
    expect(edgeTone('failed')).toBe('err')
    expect(edgeTone('stopped')).toBe('muted')
  })
})

describe('map edges', () => {
  it('edge colour follows state and leaves green the moment a tunnel retries', async () => {
    await renderMap([])
    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'up' })))
    expect(pathOf('t:t1')).toHaveAttribute('data-tone', 'ok')
    expect(pathOf('t:t1')).toHaveClass('od-flow')
    expect(pathOf('t:t1')).toHaveAttribute('stroke-dasharray', '3 5')

    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'connecting' })))
    expect(pathOf('t:t1')).toHaveAttribute('data-tone', 'warn')
    expect(pathOf('t:t1')).not.toHaveClass('od-flow')
    expect(pathOf('t:t1')).toHaveAttribute('stroke-dasharray', '3 5')

    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'retrying' })))
    expect(pathOf('t:t1')).toHaveAttribute('data-tone', 'warn')
    expect(pathOf('t:t1')).not.toHaveClass('od-flow')
    expect(pathOf('t:t1')).toHaveAttribute('stroke-dasharray', '3 5')
    expect(screen.getByRole('button', { name: 'api-local, Local forward, retrying' })).toHaveTextContent('retrying')

    act(() => emitBridgeEvent('tunnel:state', tunnelRuntime({ id: 't1', state: 'failed' })))
    expect(pathOf('t:t1')).toHaveAttribute('data-tone', 'err')
    expect(pathOf('t:t1')).not.toHaveAttribute('stroke-dasharray')
    expect(edge('t:t1')!.querySelector('[data-break]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'api-local, Local forward, failed' })).toHaveTextContent('failed')
  })

  it('stopped tunnels are muted and still', async () => {
    await renderMap([])
    const path = pathOf('t:t1')
    expect(path).toHaveAttribute('data-tone', 'muted')
    expect(path).not.toHaveClass('od-flow')
    expect(path).toHaveAttribute('stroke-dasharray', '1 4')
    expect(path.style.opacity).toBe('0.5')
    expect(edge('t:t1')!.querySelector('animateMotion')).toBeNull()
  })

  it('throughput sets the flow speed and width', async () => {
    await renderMap()
    expect(pathOf('t:t1').style.getPropertyValue('--od-flow-dur')).toBe('2.4s')
    expect(pathOf('t:t1').style.strokeWidth).toBe('1.5')

    act(() => emitBridgeEvent('tunnel:stats', [stats({ id: 't1', rateIn: 2_000_000 })]))
    const path = pathOf('t:t1')
    expect(path.style.getPropertyValue('--od-flow-dur')).toBe('0.45s')
    expect(path.style.strokeWidth).toBe('3')
    // The dashes keep one period, so the loop never jumps; only the width scales.
    expect(path).toHaveAttribute('stroke-dasharray', '3 5')
    const dot = edge('t:t1')!.querySelector('animateMotion')!
    expect(dot).toHaveAttribute('dur', '0.45s')
    expect(dot.parentElement).toHaveClass('od-travel')

    act(() => emitBridgeEvent('tunnel:stats', [stats({ id: 't1', rateIn: 20_000 })]))
    expect(pathOf('t:t1').style.getPropertyValue('--od-flow-dur')).toBe('1.1s')
    expect(pathOf('t:t1').style.strokeWidth).toBe('2.25')
  })

  it('the label chip shows type, label and rates', async () => {
    await renderMap()
    act(() => emitBridgeEvent('tunnel:stats', [stats({ id: 't1', rateIn: 1_200_000, rateOut: 30_000 })]))
    const chip = screen.getByRole('button', { name: 'api-local, Local forward, up' })
    expect(chip).toHaveTextContent('L')
    expect(chip).toHaveTextContent('api-local')
    expect(chip).toHaveTextContent('↓ 1.2 MB/s ↑ 30 KB/s')
    expect(chip).toHaveClass('nodrag', 'nopan')
    expect(screen.getByRole('button', { name: 'pg-local, SOCKS proxy, up' })).toHaveTextContent('SOCKS')
    expect(screen.getByRole('button', { name: 'hook, Remote forward, stopped' })).not.toHaveTextContent('↓')
  })

  it('a stats tick re-renders only its own edge', async () => {
    await renderMap()
    const before = {
      t1: renders.edges.get('t:t1') ?? 0,
      t2: renders.edges.get('t:t2') ?? 0,
      hosts: new Map(renders.hosts),
      flow: renders.flow,
      build: spies.build,
      layout: spies.layout,
    }
    expect(before.t1).toBeGreaterThan(0)
    expect(before.t2).toBeGreaterThan(0)
    expect(before.hosts.size).toBe(3)

    act(() => emitBridgeEvent('tunnel:stats', [stats({ id: 't1', rateIn: 5_000, rateOut: 100 })]))
    await flush()
    expect(renders.edges.get('t:t1')).toBe(before.t1 + 1)
    expect(renders.edges.get('t:t2')).toBe(before.t2)
    expect(renders.hosts).toEqual(before.hosts)
    expect(renders.flow).toBe(before.flow)
    expect(spies.build).toBe(before.build)
    expect(spies.layout).toBe(before.layout)
  })

  it('clicking the chip selects its edge', async () => {
    const onEdgeSelect = vi.fn()
    const data = { products: [web, shop], environments: [prod], hosts, identities: [], vaults: [] }
    const graph = buildGraph({ data, tunnels: [t1], scope: { kind: 'all' } })
    render(
      <ReactFlowProvider>
        <MapCanvas
          graph={graph}
          layout={layoutGraph(graph)}
          selectedId={null}
          dimmed={null}
          highlightId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          onEdgeSelect={onEdgeSelect}
        />
      </ReactFlowProvider>,
    )
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'api-local, Local forward, stopped' }))
    expect(onEdgeSelect).toHaveBeenCalledWith('t:t1')
  })

  it('R tunnels flow from host to Mac', async () => {
    await renderMap()
    expect(pathOf('t:t3')).toHaveAttribute('data-source', 'e:e1/h:h2')
    expect(pathOf('t:t3')).toHaveAttribute('data-target', 'mac')
    expect(pathOf('t:t1')).toHaveAttribute('data-source', 'mac')
    expect(pathOf('t:t1')).toHaveAttribute('data-target', 'e:e1/h:h2')
  })

  it('jump edges are dashed and not animated', async () => {
    await renderMap()
    const own = pathOf('j:e:e1/h:h1>e:e1/h:h2')
    const inherited = pathOf('j:e:e1/h:h1>e:e1/h:h3')
    expect(own).toHaveAttribute('stroke-dasharray', '4 4')
    expect(inherited).toHaveAttribute('stroke-dasharray', '10 5')
    expect(edge('j:e:e1/h:h1>e:e1/h:h3')!.querySelector('title')).toHaveTextContent('environment default')
    expect(edge('j:e:e1/h:h1>e:e1/h:h2')!.querySelector('title')).not.toHaveTextContent('environment default')
    for (const p of [own, inherited]) expect(p).not.toHaveClass('od-flow')
    expect(edge('j:e:e1/h:h1>e:e1/h:h2')!.querySelector('animateMotion')).toBeNull()
    expect(edge('j:e:e1/h:h1>e:e1/h:h2')!.querySelector('[data-marker="jump"]')).not.toBeNull()
  })

  it('secondary membership edges are dotted', async () => {
    await renderMap()
    const primary = pathOf('m:p1>e:e1')
    const secondary = pathOf('m:p2>e:e1')
    expect(primary).not.toHaveAttribute('stroke-dasharray')
    expect(primary.style.stroke).toBe('rgb(91, 140, 255)')
    expect(secondary).toHaveAttribute('stroke-dasharray', '1 4')
    expect(secondary.style.stroke).toBe('rgb(240, 160, 32)')
    expect(secondary.style.opacity).toBe('0.4')
  })

  it('tunnel and jump edges draw above the group frames, memberships below', async () => {
    await renderMap()
    // React Flow puts each z-level in its own svg. An edge touching a child node also gets that node's
    // depth added, so the check is the order against the group frame, not the raw number.
    const z = (id: string) => Number((edge(id)!.closest('svg') as SVGSVGElement).style.zIndex)
    const group = Number(document.querySelector<HTMLElement>('.react-flow__node[data-id="e:e1"]')!.style.zIndex)
    expect(z('m:p1>e:e1')).toBe(0)
    expect(z('t:t1')).toBeGreaterThan(group)
    expect(z('j:e:e1/h:h1>e:e1/h:h2')).toBeGreaterThan(group)
    expect(z('t:t1')).toBeGreaterThan(z('m:p1>e:e1'))
    const zIndexOf = (id: string) => renders.edges_.find((e) => e.id === id)?.zIndex
    expect(zIndexOf('t:t1')).toBe(1)
    expect(zIndexOf('j:e:e1/h:h1>e:e1/h:h2')).toBe(1)
    expect(zIndexOf('m:p1>e:e1')).toBe(0)
  })

  it('hovering an edge rings its two end nodes', async () => {
    await renderMap()
    const nodeEl = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
    fireEvent.mouseEnter(edge('t:t1')!)
    await flush()
    expect(nodeEl('mac')).toHaveAttribute('data-related')
    expect(nodeEl('e:e1/h:h2')).toHaveAttribute('data-related')
    expect(nodeEl('e:e1/h:h3')).not.toHaveAttribute('data-related')
    fireEvent.mouseLeave(edge('t:t1')!)
    await flush()
    expect(nodeEl('mac')).not.toHaveAttribute('data-related')
  })

  it('focusing the chip lights the edge and rings its end nodes, as hover does', async () => {
    await renderMap()
    const nodeEl = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
    const chip = screen.getByRole('button', { name: 'api-local, Local forward, up' })
    expect(chip.className).toContain('focus-visible:ring-2')
    expect(pathOf('t:t1').getAttribute('class')).toBe('react-flow__edge-path od-edge od-flow')

    act(() => chip.focus())
    await flush()
    expect(pathOf('t:t1')).toHaveClass('od-edge-lit')
    expect(nodeEl('mac')).toHaveAttribute('data-related')
    expect(nodeEl('e:e1/h:h2')).toHaveAttribute('data-related')
    expect(nodeEl('e:e1/h:h3')).not.toHaveAttribute('data-related')

    act(() => chip.blur())
    await flush()
    expect(pathOf('t:t1')).not.toHaveClass('od-edge-lit')
    expect(nodeEl('mac')).not.toHaveAttribute('data-related')
  })

  it('reduced motion stills every edge', async () => {
    motion.safe = false
    await renderMap()
    act(() => emitBridgeEvent('tunnel:stats', [stats({ id: 't1', rateIn: 5_000_000 }), stats({ id: 't2', rateIn: 5_000_000 })]))
    const canvas = document.querySelector('.react-flow')!
    expect(canvas.querySelector('.od-flow')).toBeNull()
    expect(canvas.querySelector('.od-pulse')).toBeNull()
    expect(canvas.querySelector('animateMotion')).toBeNull()
    expect(canvas.querySelector('.od-travel')).toBeNull()
    expect(pathOf('t:t1')).toHaveAttribute('data-tone', 'ok')
    expect(pathOf('t:t1').style.stroke).toBe('var(--ok)')
  })
})
