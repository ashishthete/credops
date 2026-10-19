import './flow-stubs'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, reloadInventory } from '../../src/renderer/src/inventory/store'
import { VIEWPORT_KEY } from '../../src/renderer/src/map/viewport'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { defaultVault, environment, host, mockBridge, product, session, tunnelMeta, tunnelRuntime } from './helpers'

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

// The real canvas still renders; these spy on the camera, and getViewport can be pinned to put
// nodes in or out of view.
type Viewport = { x: number; y: number; zoom: number }
const cam = vi.hoisted(() => ({
  setCenter: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitView: vi.fn(),
  viewport: null as Viewport | null,
}))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    useReactFlow: () => {
      const real = actual.useReactFlow()
      return {
        ...real,
        setCenter: cam.setCenter,
        zoomIn: cam.zoomIn,
        zoomOut: cam.zoomOut,
        fitView: (...args: Parameters<typeof real.fitView>) => {
          cam.fitView(...args)
          return real.fitView(...args)
        },
        getViewport: () => cam.viewport ?? real.getViewport(),
      }
    },
  }
})
const IN_VIEW: Viewport = { x: 100, y: 100, zoom: 0.01 }
const OFF_SCREEN: Viewport = { x: -100000, y: -100000, zoom: 1 }

const platform = product({ id: 'p1', name: 'Platform' })
const prod = environment({ id: 'e1', name: 'Prod', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'bastion' }, { hostId: 'h2', role: 'db' }] })
const stage = environment({ id: 'e2', name: 'Stage', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const hosts = [host({ id: 'h1', label: 'web', address: '10.0.0.5' }), host({ id: 'h2', label: 'pg', address: '10.0.0.6' })]
const t1 = tunnelMeta({ id: 't1', label: 'pg-local', hostId: 'h1', environmentId: 'e1' })

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const canvas = () => screen.getByRole('application', { name: /Topology map/ })
const announced = () => screen.getByTestId('map-announce').textContent
const focused = () => document.querySelector<HTMLElement>('.react-flow__node[data-focused="true"]')?.dataset.id ?? null
const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(600)
})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

const at = { search: '' }
function LocationProbe() {
  at.search = useLocation().search
  return null
}

const lists = (over: Record<string, unknown> = {}) => ({
  'product:list': [platform],
  'env:list': [prod, stage],
  'host:list': hosts,
  'identity:list': [],
  'vault:list': [defaultVault],
  'tunnel:list': [t1],
  'tunnel:status': [],
  'session:attach': { meta: {}, buffer: '', end: 0 },
  ...over,
})

async function renderMap(over: Record<string, unknown> = {}, path = '/map') {
  const invoke = mockBridge(lists(over))
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

async function key(k: string) {
  fireEvent.keyDown(canvas(), { key: k })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  cam.viewport = null
  for (const spy of [cam.setCenter, cam.zoomIn, cam.zoomOut, cam.fitView]) spy.mockClear()
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

describe('map keyboard and screen readers', () => {
  it('the canvas is one labelled application, with no extra wrapper role', async () => {
    await renderMap()
    expect(screen.getAllByRole('application')).toHaveLength(1)
    expect(canvas()).toHaveAttribute('aria-roledescription', 'topology map')
    expect(canvas()).toHaveAttribute('tabindex', '0')
  })

  it('arrow keys move a focus ring and announce the node', async () => {
    await renderMap()
    canvas().focus()
    expect(focused()).toBeNull()
    await key('ArrowDown')
    expect(focused()).toBe('p:p1')
    expect(node('p:p1')).toHaveClass('od-focused')
    expect(announced()).toBe('Platform product, 2 environments')
    await key('ArrowRight')
    expect(announced()).toBe('Prod environment, 2 hosts')
    await key('ArrowRight')
    expect(focused()).toBe('e:e1/h:h1')
    expect(announced()).toBe('web, Bastion in Prod, Not checked, 0 sessions, 1 tunnel')
    await key('ArrowDown')
    expect(announced()).toBe('pg, Database in Prod, Not checked, 0 sessions, 0 tunnels')
    // Focus is not selection.
    expect(document.querySelector('.react-flow__node.selected')).toBeNull()
    expect(document.activeElement).toBe(canvas())
  })

  it('a settled change of reach on the focused host is said on its own; a flap is not', async () => {
    await renderMap()
    canvas().focus()
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight']) await key(k)
    expect(announced()).toBe('web, Bastion in Prod, Not checked, 0 sessions, 1 tunnel')
    const run = (state: 'up' | 'stopped') =>
      act(() => tunnelStore.set({ ...tunnelStore.get(), runtime: { t1: tunnelRuntime({ id: 't1', state }) } }))

    // Up and back down inside a second: nothing new is said.
    run('up')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    run('stopped')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(announced()).toBe('web, Bastion in Prod, Not checked, 0 sessions, 1 tunnel')

    run('up')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(announced()).toBe('web, Bastion in Prod, Not checked, 0 sessions, 1 tunnel')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(announced()).toBe('web: Reachable')

    // Moving focus says the whole description again, with the new reach.
    await key('ArrowDown')
    await key('ArrowUp')
    expect(announced()).toBe('web, Bastion in Prod, Reachable, 0 sessions, 1 tunnel')
  })

  it('Enter opens the panel, Enter again connects, Escape closes then lets go', async () => {
    const invoke = await renderMap({ 'ssh:open': session({ id: 's1', hostId: 'h1', environmentId: 'e1' }) })
    canvas().focus()
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight']) await key(k)
    await key('Enter')
    expect(screen.getByRole('complementary', { name: 'web' })).toBeInTheDocument()
    expect(node('e:e1/h:h1')).toHaveClass('selected')
    // The keyboard stays on the canvas.
    await flush()
    expect(document.activeElement).toBe(canvas())

    fireEvent.keyDown(canvas(), { key: 'Escape' })
    await settle()
    // The panel closes (its slide-out is the panel's own business) and focus stays put.
    expect(node('e:e1/h:h1')).not.toHaveClass('selected')
    expect(document.activeElement).toBe(canvas())
    expect(focused()).toBe('e:e1/h:h1')
    canvas().focus()
    await key('Escape')
    expect(focused()).toBeNull()

    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'Enter']) await key(k)
    await key('Enter')
    await flush()
    expect(calls(invoke, 'ssh:open')).toEqual([['ssh:open', expect.objectContaining({ hostId: 'h1', environmentId: 'e1' })]])
  })

  it('Space selects too, and / jumps to the search box', async () => {
    await renderMap()
    canvas().focus()
    await key('ArrowDown')
    await key(' ')
    expect(screen.getByRole('complementary', { name: 'Platform' })).toBeInTheDocument()
    canvas().focus()
    await key('/')
    expect(document.activeElement).toBe(screen.getByLabelText('Find on map'))
  })

  it('a deleted host hands focus to its group', async () => {
    const invoke = await renderMap()
    canvas().focus()
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown']) await key(k)
    expect(focused()).toBe('e:e1/h:h2')
    const prodWithout = { ...prod, hosts: prod.hosts.filter((m) => m.hostId !== 'h2') }
    invoke.mockImplementation(async (channel: string) => {
      const out = lists({ 'host:list': [hosts[0]], 'env:list': [prodWithout, stage] }) as Record<string, unknown>
      return out[channel] ?? []
    })
    await act(() => reloadInventory())
    await settle()
    expect(node('e:e1/h:h2')).toBeNull()
    expect(focused()).toBe('e:e1')
    expect(announced()).toBe('Prod environment, 1 host')
  })

  it('a filter starts with no focus', async () => {
    await renderMap()
    canvas().focus()
    await key('ArrowDown')
    expect(focused()).toBe('p:p1')
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'e2' } })
    await settle()
    expect(focused()).toBeNull()
    expect(announced()).toBe('')
  })
})

describe('map camera and live region', () => {
  const search = () => screen.getByLabelText('Find on map')

  it('focusing an off-screen node pans to it, instantly under reduced motion', async () => {
    await renderMap()
    cam.viewport = OFF_SCREEN
    canvas().focus()
    await key('ArrowDown')
    expect(cam.setCenter).toHaveBeenCalledTimes(1)
    expect(cam.setCenter.mock.calls[0][2]).toEqual({ zoom: 1, duration: 250 })
    cleanup()

    motion.safe = false
    cam.setCenter.mockClear()
    await renderMap()
    cam.viewport = OFF_SCREEN
    canvas().focus()
    await key('ArrowDown')
    expect(cam.setCenter).toHaveBeenCalledTimes(1)
    expect(cam.setCenter.mock.calls[0][2]).toEqual({ zoom: 1, duration: 0 })
  })

  it('the zoom buttons keep their labels and honour reduced motion', async () => {
    const press = async () => {
      // A stored mid-range zoom, so neither zoom button is at its limit.
      localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ all: { x: 0, y: 0, zoom: 1 } }))
      await renderMap()
      cam.fitView.mockClear()
      for (const name of ['Zoom In', 'Zoom Out', 'Fit View']) fireEvent.click(screen.getByRole('button', { name }))
    }
    await press()
    expect(cam.zoomIn).toHaveBeenLastCalledWith({ duration: 200 })
    expect(cam.zoomOut).toHaveBeenLastCalledWith({ duration: 200 })
    expect(cam.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 200 }))
    cleanup()

    motion.safe = false
    await press()
    expect(cam.zoomIn).toHaveBeenLastCalledWith({ duration: 0 })
    expect(cam.zoomOut).toHaveBeenLastCalledWith({ duration: 0 })
    expect(cam.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 0 }))
    localStorage.removeItem(VIEWPORT_KEY)
  })

  it('a node already in view is not panned to', async () => {
    await renderMap()
    cam.viewport = IN_VIEW
    canvas().focus()
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown']) await key(k)
    expect(focused()).toBe('e:e1/h:h2')
    expect(cam.setCenter).not.toHaveBeenCalled()
  })

  it('a node a search zoomed to is still panned to when focused later', async () => {
    await renderMap()
    cam.viewport = IN_VIEW
    fireEvent.change(search(), { target: { value: 'Platform' } })
    fireEvent.keyDown(search(), { key: 'Enter' })
    await flush()
    expect(cam.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ nodes: [{ id: 'p:p1' }] }))
    fireEvent.change(search(), { target: { value: '' } })
    await flush()
    cam.viewport = OFF_SCREEN
    canvas().focus()
    await key('ArrowDown')
    expect(focused()).toBe('p:p1')
    expect(cam.setCenter).toHaveBeenCalledTimes(1)
  })

  it('keys typed in the search box neither zoom nor move focus', async () => {
    await renderMap()
    search().focus()
    cam.fitView.mockClear()
    for (const k of ['/', '+', '=', '-', '0']) {
      fireEvent.keyDown(search(), { key: k })
      fireEvent.change(search(), { target: { value: k } })
      await flush()
    }
    expect(document.activeElement).toBe(search())
    expect(cam.zoomIn).not.toHaveBeenCalled()
    expect(cam.zoomOut).not.toHaveBeenCalled()
    expect(cam.fitView).not.toHaveBeenCalled()
    expect(cam.setCenter).not.toHaveBeenCalled()
    expect(focused()).toBeNull()
  })

  it('has one live region, which also announces the search count', async () => {
    await renderMap()
    const page = screen.getByRole('heading', { name: 'Map', level: 1 }).closest('header')!.parentElement!
    expect(page.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(page.querySelector('[aria-live]')).toBe(screen.getByTestId('map-announce'))
    // React Flow's own (assertive) region is off with its keyboard a11y.
    expect(document.querySelector('.a11y-live-region, [id^="react-flow__aria-live"]')).toBeNull()

    fireEvent.change(search(), { target: { value: 'pg' } })
    await flush()
    expect(announced()).toBe('1 match')
    // The count stays on screen, not as a second region.
    expect(within(screen.getByRole('toolbar', { name: 'Map tools' })).getByText('1 match')).not.toHaveAttribute('aria-live')
    canvas().focus()
    await key('ArrowDown')
    expect(announced()).toBe('Platform product, 2 environments')
    fireEvent.change(search(), { target: { value: 'nothing-here' } })
    await flush()
    expect(announced()).toBe('0 matches')
    expect(page.querySelectorAll('[aria-live]')).toHaveLength(1)
  })

  it('a host placed twice counts its tunnels where they are drawn', async () => {
    await renderMap()
    canvas().focus()
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight']) await key(k)
    expect(announced()).toBe('web, Bastion in Prod, Not checked, 0 sessions, 1 tunnel')
    for (const k of ['ArrowLeft', 'ArrowDown', 'ArrowRight']) await key(k)
    expect(focused()).toBe('e:e2/h:h1')
    expect(announced()).toBe('web, App in Stage, Not checked, 0 sessions, 0 tunnels')
  })
})

describe('map list view', () => {
  const list = () => screen.getByRole('table', { name: 'Hosts by environment' })
  const row = (name: string, group: string) => {
    const body = within(list()).getByRole('rowheader', { name: new RegExp(`^${group}\\b`) }).closest('tbody')!
    return within(body).getByRole('rowheader', { name }).closest('tr')!
  }

  it('mirrors the map, one row per placement', async () => {
    const invoke = await renderMap({
      'ssh:open': session({ id: 's1', hostId: 'h1', environmentId: 'e2' }),
      'tunnel:start': tunnelRuntime({ id: 't1', state: 'up' }),
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'List' }))
    })
    await flush()
    expect(at.search).toBe('?view=list')
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('application')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fit view' })).toBeNull()

    const web = row('web', 'Prod')
    expect(web).toHaveTextContent('10.0.0.5')
    expect(web).toHaveTextContent('Bastion')
    expect(web).toHaveTextContent('Not checked')
    expect(within(web).getByRole('list', { name: 'web tunnels' })).toHaveTextContent('pg-local')
    expect(row('pg', 'Prod')).toHaveTextContent('Database')
    expect(row('web', 'Stage')).toHaveTextContent('App')
    expect(row('web', 'Stage')).toHaveTextContent('None')

    fireEvent.click(within(web).getByRole('switch', { name: 'Run pg-local' }))
    await flush()
    expect(calls(invoke, 'tunnel:start')).toEqual([['tunnel:start', 't1']])

    fireEvent.click(within(row('web', 'Stage')).getByRole('button', { name: 'Connect' }))
    await flush()
    await flush()
    expect(invoke).toHaveBeenCalledWith('ssh:open', expect.objectContaining({ hostId: 'h1', environmentId: 'e2' }))
  })

  it('honours the filter and the search', async () => {
    await renderMap({}, '/map?view=list&env=e2')
    expect(within(list()).queryByRole('rowheader', { name: /^Prod\b/ })).toBeNull()
    expect(row('web', 'Stage')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    await flush()
    fireEvent.change(screen.getByLabelText('Find on map'), { target: { value: 'pg' } })
    await flush()
    expect(within(list()).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Prod, Platform', 'pg'])
    // A matching group keeps all its hosts.
    fireEvent.change(screen.getByLabelText('Find on map'), { target: { value: 'stage' } })
    await flush()
    expect(within(list()).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Stage, Platform', 'web'])
    fireEvent.change(screen.getByLabelText('Find on map'), { target: { value: 'zzz' } })
    await flush()
    expect(list()).toHaveTextContent('No hosts match.')
  })

  it('says in words what the map draws: products per group and jumps per host', async () => {
    const prodJumped = { ...prod, defaultJumpHostId: 'h1' }
    const stageJumped = { ...stage, hosts: [...stage.hosts, { hostId: 'h3', role: 'app' as const }] }
    const cache = host({ id: 'h3', label: 'cache', address: '10.0.0.7', jumpHostId: 'h2' })
    await renderMap({ 'env:list': [prodJumped, stageJumped], 'host:list': [...hosts, cache] }, '/map?view=list')
    // jsdom's accessible names drop the space a browser keeps, so the words are checked as text.
    expect(within(list()).getByRole('rowheader', { name: /^Prod\b/ })).toHaveTextContent('Prod, Platform')
    // Drawn as a jump edge from web's placement.
    expect(row('pg', 'Prod')).toHaveTextContent('10.0.0.6 via web')
    expect(row('web', 'Prod')).not.toHaveTextContent('via')
    expect(row('cache', 'Stage')).toHaveTextContent('10.0.0.7 via pg')

    // Filtered to Stage, pg isn't drawn; the jump is still named.
    cleanup()
    await renderMap({ 'env:list': [prodJumped, stageJumped], 'host:list': [...hosts, cache] }, '/map?view=list&env=e2')
    expect(row('cache', 'Stage')).toHaveTextContent('10.0.0.7 via pg')
  })

  it('Show on map switches back and focuses the placement', async () => {
    await renderMap({}, '/map?view=list')
    fireEvent.click(within(row('pg', 'Prod')).getByRole('button', { name: 'Show on map' }))
    await flush()
    await flush()
    expect(at.search).toBe('')
    expect(focused()).toBe('e:e1/h:h2')
    expect(node('e:e1/h:h2')).toHaveClass('selected')
    expect(screen.getByRole('complementary', { name: 'pg' })).toBeInTheDocument()
  })
})
