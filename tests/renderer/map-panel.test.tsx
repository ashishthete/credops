import './flow-stubs'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, reloadInventory } from '../../src/renderer/src/inventory/store'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { defaultVault, emitBridgeEvent, environment, host, identity, mockBridge, product, session, tunnelMeta, tunnelRuntime } from './helpers'

// Connect lands on the Terminals page, which mounts xterm.
vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe.
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

// The real canvas still renders; this counts its renders and spies on fitView.
const seen = vi.hoisted(() => ({ flowRenders: 0, fitView: vi.fn() }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
      seen.flowRenders++
      return createElement(actual.ReactFlow, props)
    },
    useReactFlow: () => ({ ...actual.useReactFlow(), fitView: seen.fitView }),
  }
})

// Values that exist in the inventory but must never reach the panel.
const USERNAME = 'sentinel-username-7q'
const NOTES = 'sentinel-notes-3x'
const ENV_VALUE = 'sentinel-env-value-9z'

const web = product({ id: 'p1', name: 'Web', description: 'The public storefront' })
const prod = environment({
  id: 'e1',
  name: 'Prod',
  protected: true,
  productIds: ['p1'],
  defaultJumpHostId: 'h1',
  hosts: [
    { hostId: 'h1', role: 'bastion' },
    { hostId: 'h2', role: 'db' },
  ],
})
const stage = environment({ id: 'e2', name: 'Stage', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const ops = { ...defaultVault, id: 'v2', name: 'Ops vault', isDefault: false }
const hosts = [
  host({ id: 'h1', label: 'web', address: '10.0.0.5', identityId: 'i1', notes: NOTES, envVars: { TOKEN: ENV_VALUE }, vaultIds: ['v2'] }),
  host({ id: 'h2', label: 'pg' }),
]
const t1 = tunnelMeta({ id: 't1', label: 'pg-local', hostId: 'h1' })

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const panel = (name: string) => screen.getByRole('complementary', { name })
const section = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: new RegExp(name) })
// Lets a closing panel finish its exit animation.
const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(600)
})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

// Where the router is, read back after each render.
const at = { search: '' }
function LocationProbe() {
  at.search = useLocation().search
  return null
}

async function renderMap(over: Record<string, unknown> = {}, path = '/map') {
  const invoke = mockBridge({
    'product:list': [web],
    'env:list': [prod, stage],
    'host:list': hosts,
    'identity:list': [identity({ id: 'i1', label: 'deploy key', username: USERNAME })],
    'vault:list': [defaultVault, ops],
    'tunnel:list': [t1],
    'tunnel:status': [],
    'session:attach': { meta: {}, buffer: '', end: 0 },
    ...over,
  })
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
  return invoke
}

async function click(el: Element) {
  fireEvent.click(el)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  seen.flowRenders = 0
  seen.fitView.mockClear()
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

describe('map detail panel', () => {
  it('clicking a host opens its panel with focus on Connect', async () => {
    await renderMap()
    await click(node('e:e1/h:h1')!)
    const p = panel('web')
    expect(p).toHaveTextContent('Bastion')
    expect(within(p).getByText('10.0.0.5')).toHaveClass('font-mono')
    expect(p).toHaveTextContent('Ops vault')
    expect(p).toHaveTextContent('Not checked')
    expect(p).toHaveTextContent('0 sessions')
    expect(document.activeElement).toBe(within(p).getByRole('button', { name: 'Connect' }))
    expect(node('e:e1/h:h1')).toHaveClass('selected')
  })

  it('the host panel shows no private fields', async () => {
    await renderMap()
    await click(node('e:e1/h:h1')!)
    const text = panel('web').textContent ?? ''
    expect(inventoryStore.get()?.identities[0].username).toBe(USERNAME)
    for (const secret of [USERNAME, NOTES, ENV_VALUE, 'TOKEN']) expect(text).not.toContain(secret)
  })

  it('lists every environment with this placement marked, and the jump', async () => {
    await renderMap()
    await click(node('e:e2/h:h1')!)
    const envs = within(panel('web')).getByRole('list', { name: 'Environments' })
    expect(within(envs).getByText('Stage').closest('li')).toHaveTextContent('this placement')
    expect(within(envs).getByText('Prod').closest('li')).not.toHaveTextContent('this placement')
    await click(node('e:e1/h:h2')!)
    expect(panel('pg')).toHaveTextContent('via web')
    expect(panel('pg')).toHaveTextContent('environment default')
  })

  it('Connect opens a session for that placement', async () => {
    const invoke = await renderMap({ 'ssh:open': session({ id: 's1', hostId: 'h1', environmentId: 'e2' }) })
    await click(node('e:e2/h:h1')!)
    await click(within(panel('web')).getByRole('button', { name: 'Connect' }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('ssh:open', expect.objectContaining({ hostId: 'h1', environmentId: 'e2' }))
    expect(section('Terminals')).toHaveAttribute('aria-current', 'page')
  })

  it('Open host page goes to the host', async () => {
    await renderMap()
    await click(node('e:e1/h:h1')!)
    await click(within(panel('web')).getByRole('button', { name: 'Open host page' }))
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'web', level: 2 })).toBeInTheDocument()
  })

  it('double-click on a host connects', async () => {
    const invoke = await renderMap({ 'ssh:open': session({ id: 's1', hostId: 'h1', environmentId: 'e1' }) })
    fireEvent.doubleClick(node('e:e1/h:h1')!)
    await flush()
    await flush()
    expect(calls(invoke, 'ssh:open')).toEqual([['ssh:open', expect.objectContaining({ hostId: 'h1', environmentId: 'e1' })]])
    expect(section('Terminals')).toHaveAttribute('aria-current', 'page')
  })

  it('the tunnel switch in the host panel starts and stops', async () => {
    const invoke = await renderMap({ 'tunnel:start': tunnelRuntime({ id: 't1', state: 'up' }) })
    await click(node('e:e1/h:h1')!)
    const row = within(panel('web')).getByRole('listitem', { name: 'pg-local' })
    expect(row).toHaveTextContent('L')
    expect(row).toHaveTextContent('Stopped')
    await click(within(row).getByRole('switch', { name: 'Run pg-local' }))
    expect(calls(invoke, 'tunnel:start')).toEqual([['tunnel:start', 't1']])
    expect(row).toHaveTextContent('Up')
    await click(within(row).getByRole('switch', { name: 'Run pg-local' }))
    expect(calls(invoke, 'tunnel:stop')).toEqual([['tunnel:stop', 't1']])
  })

  it('clicking a tunnel edge opens the tunnel panel with its route and switch', async () => {
    await renderMap({ 'tunnel:status': [tunnelRuntime({ id: 't1', state: 'failed', error: { code: 'port-in-use', message: 'Port 5433 is in use by postgres' } })] })
    const edge = document.querySelector('[data-testid="rf__edge-t:t1"]')!
    await click(edge)
    const p = panel('pg-local')
    expect(within(p).getByRole('img', { name: 'Route: 127.0.0.1:5433 → web → localhost:5432' })).toBeInTheDocument()
    expect(within(p).getByRole('switch', { name: 'Run pg-local' })).toHaveAttribute('aria-checked', 'false')
    expect(p).toHaveTextContent('Port 5433 is in use by postgres')
    expect(document.querySelector('[data-testid="rf__edge-t:t1"]')).toHaveClass('selected')
    await click(within(p).getByRole('button', { name: 'Open in Tunnels' }))
    expect(screen.getByRole('heading', { name: 'Tunnels', level: 1 })).toBeInTheDocument()
  })

  it('the tunnel chip opens the same panel', async () => {
    await renderMap()
    await click(screen.getByRole('button', { name: 'pg-local, Local forward, stopped' }))
    expect(panel('pg-local')).toHaveTextContent('Stopped')
  })

  it('environment panel filters to the environment', async () => {
    await renderMap()
    await click(node('e:e1')!)
    const p = panel('Prod')
    expect(p).toHaveTextContent('Protected')
    expect(p).toHaveTextContent('Web')
    expect(p).toHaveTextContent('2 hosts')
    expect(p).toHaveTextContent('Bastion 1 · Database 1')
    await click(within(p).getByRole('button', { name: 'Filter to this environment' }))
    // ?env=e1 scopes the map to Prod alone.
    expect(node('e:e2')).toBeNull()
    expect(node('e:e1')).not.toBeNull()
    expect(panel('Prod')).toBeInTheDocument()
  })

  it('environment Open in Products goes to its tree node', async () => {
    await renderMap()
    await click(node('e:e2')!)
    await click(within(panel('Stage')).getByRole('button', { name: 'Open in Products' }))
    expect(screen.getByRole('heading', { name: 'Stage', level: 2 })).toBeInTheDocument()
  })

  it('product and This Mac panels', async () => {
    await renderMap()
    await click(node('p:p1')!)
    const p = panel('Web')
    expect(p).toHaveTextContent('The public storefront')
    expect(p).toHaveTextContent('2 environments')
    await click(within(p).getByRole('button', { name: 'Filter to this product' }))
    expect(node('e:e2')).not.toBeNull()
    await click(node('mac')!)
    const mac = panel('This Mac')
    expect(mac).toHaveTextContent('1 tunnel')
    expect(within(mac).getByRole('switch', { name: 'Run pg-local' })).toBeInTheDocument()
  })

  it('Escape and pane click close the panel', async () => {
    await renderMap()
    await click(node('e:e1/h:h1')!)
    expect(panel('web')).toBeInTheDocument()
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    })
    await settle()
    expect(screen.queryByRole('complementary', { name: 'web' })).toBeNull()
    expect(node('e:e1/h:h1')).not.toHaveClass('selected')

    await click(node('e:e1/h:h1')!)
    await click(within(panel('web')).getByRole('button', { name: 'Close' }))
    await settle()
    expect(screen.queryByRole('complementary', { name: 'web' })).toBeNull()

    await click(node('e:e1/h:h1')!)
    await click(document.querySelector('.react-flow__pane')!)
    await settle()
    expect(screen.queryByRole('complementary', { name: 'web' })).toBeNull()
  })

  it('deleting the selected host closes its panel', async () => {
    const invoke = await renderMap()
    await click(node('e:e1/h:h2')!)
    expect(panel('pg')).toBeInTheDocument()
    const prodWithout = { ...prod, hosts: prod.hosts.filter((m) => m.hostId !== 'h2') }
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'host:list') return [hosts[0]]
      if (channel === 'env:list') return [prodWithout, stage]
      if (channel === 'product:list') return [web]
      if (channel === 'vault:list') return [defaultVault, ops]
      if (channel === 'identity:list') return []
      if (channel === 'tunnel:list') return [t1]
      return []
    })
    await act(() => reloadInventory())
    await settle()
    expect(node('e:e1/h:h2')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'pg' })).toBeNull()
    expect(document.querySelector('.react-flow__node.selected')).toBeNull()
    expect(node('e:e1')).not.toBeNull()
  })

  it('double-click on a group or product frames it', async () => {
    await renderMap()
    fireEvent.doubleClick(node('e:e1')!)
    await flush()
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'e:e1' }], duration: 300, padding: 0.15 })
    cleanup()

    motion.safe = false
    await renderMap()
    fireEvent.doubleClick(node('p:p1')!)
    await flush()
    expect(seen.fitView).toHaveBeenLastCalledWith({ nodes: [{ id: 'p:p1' }], duration: 0, padding: 0.15 })
  })

  it('the panel slides in with motion and only fades in under reduced motion', async () => {
    await renderMap()
    await click(node('e:e1/h:h1')!)
    expect(panel('web').style.transform).toMatch(/translateX\(340px\)/)
    await click(within(panel('web')).getByRole('button', { name: 'Close' }))
    await settle()

    motion.safe = false
    await click(node('e:e1/h:h1')!)
    const p = panel('web')
    expect(p.style.opacity).toBe('0')
    expect(p.style.transform).not.toMatch(/translateX/)
  })

  it('stats ticks with the panel open leave the canvas alone', async () => {
    await renderMap({ 'tunnel:status': [tunnelRuntime({ id: 't1', state: 'up' })] })
    await click(node('e:e1/h:h1')!)
    expect(panel('web')).toBeInTheDocument()
    const renders = seen.flowRenders
    act(() => emitBridgeEvent('tunnel:stats', [{ id: 't1', bytesIn: 10, bytesOut: 20, rateIn: 1, rateOut: 2, connections: 1, rejected: 0 }]))
    act(() => emitBridgeEvent('tunnel:stats', [{ id: 't1', bytesIn: 30, bytesOut: 40, rateIn: 3, rateOut: 4, connections: 2, rejected: 0 }]))
    await flush()
    expect(seen.flowRenders).toBe(renders)
    expect(panel('web')).toBeInTheDocument()
  })

  it('the filter writes ?env= exactly, drops ?product= and keeps other params', async () => {
    await renderMap()
    await click(node('e:e1')!)
    await click(within(panel('Prod')).getByRole('button', { name: 'Filter to this environment' }))
    expect(at.search).toBe('?env=e1')
    cleanup()

    await renderMap({}, '/map?product=p1&keep=1')
    await click(node('e:e1')!)
    await click(within(panel('Prod')).getByRole('button', { name: 'Filter to this environment' }))
    expect(at.search).toBe('?keep=1&env=e1')
    await click(within(panel('Prod')).getByRole('button', { name: 'Filter to this environment' }))
    expect(at.search).toBe('?keep=1&env=e1')
  })
})
