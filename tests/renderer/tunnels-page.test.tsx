import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import type { TunnelMeta, TunnelRuntime, TunnelStats } from '../../src/shared/tunnels'
import { emitBridgeEvent, environment, host, mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

// Counts how often each card renders its route: a card re-render always re-renders its RouteLine.
const routeRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/renderer/src/pages/tunnels/RouteLine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/pages/tunnels/RouteLine')>()
  return {
    ...actual,
    RouteLine: (props: Parameters<typeof actual.RouteLine>[0]) => {
      const id = props.tunnelId ?? ''
      routeRenders.set(id, (routeRenders.get(id) ?? 0) + 1)
      return createElement(actual.RouteLine, props)
    },
  }
})

const prod = environment({ id: 'e-prod', name: 'prod', color: '#ef5b5b', protected: true })
const stage = environment({ id: 'e-stage', name: 'staging', color: '#2fbf71' })
const db = host({ id: 'h-db', label: 'db' })
const web = host({ id: 'h-web', label: 'web' })

const flush = () => act(async () => {})
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const state = (rt: TunnelRuntime) => act(() => emitBridgeEvent('tunnel:state', rt))
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const card = (label: string) => screen.getByRole('article', { name: label })

async function renderPage(tunnels: TunnelMeta[] = [], runtime: TunnelRuntime[] = [], results: Record<string, unknown> = {}) {
  const invoke = mockBridge({
    'tunnel:list': tunnels,
    'tunnel:status': runtime,
    'host:list': [db, web],
    'env:list': [prod, stage],
    ...results,
  })
  render(
    <MemoryRouter initialEntries={['/tunnels']}>
      <AppShell />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  routeRenders.clear()
  inventoryStore.set(null)
  resetTunnels()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  resetTunnels()
  clearToasts()
})

describe('tunnels page', () => {
  it('Copy SSH command copies a command for another terminal', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const resolved = {
      hostId: 'h-db',
      environmentId: null,
      address: '198.51.100.99',
      addressSource: 'host',
      port: { value: 22, source: 'global' },
      identity: { source: 'global', username: 'ubuntu', auth: 'default' },
      jump: { hostId: null, source: null },
      chain: [],
      conflicts: [],
    }
    const invoke = await renderPage([tunnelMeta({ id: 't1', label: 'EU', hostId: 'h-db', bindPort: 5475 })], [], { 'host:resolve': resolved })
    render(<Toaster />)
    fireEvent.click(within(card('EU')).getByRole('button', { name: 'Actions for EU' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy SSH command' }))
    await flush()
    expect(calls(invoke, 'host:resolve')[0].slice(1)).toEqual(['h-db'])
    expect(writeText).toHaveBeenCalledWith('ssh -N -L 5475:localhost:5432 ubuntu@198.51.100.99')
    await flush()
    expect(screen.getByText('Copied the ssh command')).toBeInTheDocument()
  })

  it('placeholder is gone and /tunnels renders the page', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    expect(screen.getByRole('heading', { name: 'Tunnels', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Coming in phase 5')).not.toBeInTheDocument()
    expect(card('pg')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New tunnel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import from ssh config' })).toBeInTheDocument()
  })

  it('the header menu offers Import tunnels… and Export tunnels…, empty or not', async () => {
    const invoke = await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export tunnels…' }))
    expect(invoke).toHaveBeenCalledWith('config:export', 'tunnels')
    fireEvent.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    expect(screen.getByRole('menuitem', { name: 'Import tunnels…' })).toBeInTheDocument()
  })

  it('summarises states in the header', async () => {
    await renderPage(
      ['a', 'b', 'c', 'd', 'e'].map((id) => tunnelMeta({ id, hostId: 'h-db' })),
      [
        tunnelRuntime({ id: 'a' }),
        tunnelRuntime({ id: 'b' }),
        tunnelRuntime({ id: 'c' }),
        tunnelRuntime({ id: 'd', state: 'retrying', failures: 1 }),
        tunnelRuntime({ id: 'e', state: 'failed', error: { code: 'auth', message: 'Authentication failed' } }),
      ],
    )
    expect(screen.getByText('3 up · 1 retrying · 1 failed')).toBeInTheDocument()
  })

  it('groups cards by host with environment chip', async () => {
    await renderPage([
      tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', environmentId: 'e-prod' }),
      tunnelMeta({ id: 't2', label: 'redis', hostId: 'h-db', environmentId: 'e-prod' }),
      tunnelMeta({ id: 't3', label: 'app', hostId: 'h-web', type: 'R', bindPort: 9000, targetPort: 3000 }),
    ])
    const dbGroup = screen.getByRole('region', { name: 'db' })
    expect(within(dbGroup).getByRole('heading', { name: /db/ })).toBeInTheDocument()
    expect(within(dbGroup).getByText('prod')).toBeInTheDocument()
    expect(within(dbGroup).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['pg', 'redis'])
    const webGroup = screen.getByRole('region', { name: 'web' })
    expect(within(webGroup).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['app'])
    expect(within(webGroup).queryByText('prod')).not.toBeInTheDocument()
  })

  it('toggle starts and stops', async () => {
    const invoke = await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })])
    const toggle = within(card('pg')).getByRole('switch', { name: 'Run pg' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:start')).toEqual([['tunnel:start', 't1']])

    state(tunnelRuntime({ id: 't1', state: 'connecting', upAt: null }))
    expect(toggle).toHaveAttribute('aria-busy', 'true')
    expect(within(card('pg')).getByText('Connecting…')).toBeInTheDocument()

    state(tunnelRuntime({ id: 't1', state: 'up', upAt: new Date().toISOString() }))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(within(card('pg')).getByText(/^Up\b/)).toBeInTheDocument()
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:stop')).toEqual([['tunnel:stop', 't1']])
  })

  it('stop while connecting cancels the start', async () => {
    const invoke = await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    state(tunnelRuntime({ id: 't1', state: 'connecting', upAt: null }))
    const toggle = within(card('pg')).getByRole('switch', { name: 'Run pg' })
    // The spinner shows, but the switch still takes the click.
    expect(toggle).toHaveAttribute('aria-busy', 'true')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:stop')).toEqual([['tunnel:stop', 't1']])

    // Retrying (backing off) can be stopped too.
    state(tunnelRuntime({ id: 't1', state: 'retrying', failures: 1, retryAt: new Date(Date.now() + 4000).toISOString() }))
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:stop')).toHaveLength(2)
  })

  it('a second click waits for the request in flight', async () => {
    let reply: (v: unknown) => void = () => {}
    const invoke = await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [], {
      'tunnel:start': new Promise((resolve) => (reply = resolve)),
    })
    const toggle = within(card('pg')).getByRole('switch', { name: 'Run pg' })
    fireEvent.click(toggle)
    await flush()
    state(tunnelRuntime({ id: 't1', state: 'connecting', upAt: null }))
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:start')).toHaveLength(1)
    expect(calls(invoke, 'tunnel:stop')).toEqual([])

    await act(async () => reply(null))
    fireEvent.click(toggle)
    await flush()
    expect(calls(invoke, 'tunnel:stop')).toEqual([['tunnel:stop', 't1']])
  })

  it('up shows how long it has been up', async () => {
    const upAt = new Date(Date.now() - 12 * 60_000).toISOString()
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', upAt })])
    expect(within(card('pg')).getByText('Up 12 min')).toBeInTheDocument()
  })

  it('up counts down to its time limit, amber in the last five minutes', async () => {
    const stopsAt = new Date(Date.now() + 45 * 60_000).toISOString()
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', upAt: new Date().toISOString(), stopsAt })])
    const left = within(card('pg')).getByTestId('tunnel-stops-in')
    expect(left).toHaveTextContent('Disconnects in 45 min')
    expect(left).not.toHaveClass('text-warn')
    await act(async () => {
      // Jump the clock rather than play 41 minutes of one-second ticks (slow enough to time out under load).
      vi.setSystemTime(Date.now() + 41 * 60_000 - 15_000)
      await vi.advanceTimersByTimeAsync(15_000) // an up card re-reads the clock every 15 s
    })
    expect(left).toHaveTextContent('Disconnects in 4 min')
    expect(left).toHaveClass('text-warn')
  })

  it('retrying shows a live countdown', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })])
    state(
      tunnelRuntime({
        id: 't1',
        state: 'retrying',
        failures: 2,
        retryAt: new Date(Date.now() + 4000).toISOString(),
        error: { code: 'refused', message: 'Connection refused' },
      }),
    )
    expect(within(card('pg')).getByText('Retrying in 4 s (attempt 3 of 5)')).toBeInTheDocument()
    await tick(1000)
    expect(within(card('pg')).getByText('Retrying in 3 s (attempt 3 of 5)')).toBeInTheDocument()
  })

  it('the first retrying frame counts down from now, not from mount', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    state(tunnelRuntime({ id: 't1', state: 'connecting', upAt: null }))
    // Ten minutes pass with no clock running (stopped and connecting have none).
    // Jumping the clock, not ticking through it: background timers make a 10-minute tick slow under load.
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await tick(0)

    // Every text the countdown ever showed, including any frame an effect later corrected
    // (a corrected text node keeps its first value as the record's oldValue).
    const observer = new MutationObserver(() => {})
    observer.observe(card('pg'), { subtree: true, childList: true, characterData: true, characterDataOldValue: true })
    state(
      tunnelRuntime({
        id: 't1',
        state: 'retrying',
        failures: 1,
        retryAt: new Date(Date.now() + 4000).toISOString(),
        error: { code: 'refused', message: 'Connection refused' },
      }),
    )
    // Taken before any await, so the observer's own callback cannot drain them first.
    const seen = observer.takeRecords().flatMap((r) => [r.oldValue ?? '', ...Array.from(r.addedNodes, (n) => n.textContent ?? '')])
    observer.disconnect()
    seen.push(card('pg').textContent ?? '')

    expect(within(card('pg')).getByText('Retrying in 4 s (attempt 2 of 5)')).toBeInTheDocument()
    const counts = seen.flatMap((t) => [...t.matchAll(/Retrying in (\d+) s/g)].map((m) => Number(m[1])))
    expect(counts.length).toBeGreaterThan(0)
    expect(Math.max(...counts)).toBeLessThanOrEqual(4)
  })

  it('announces failing and waiting for unlock once, not the countdown', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    const live = within(card('pg')).getByTestId('tunnel-announce')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('')

    state(tunnelRuntime({ id: 't1', state: 'retrying', failures: 1, retryAt: new Date(Date.now() + 4000).toISOString() }))
    await tick(2000)
    expect(live).toHaveTextContent('')

    state(tunnelRuntime({ id: 't1', state: 'retrying', retryAt: null, error: { code: 'locked', message: 'Waiting for unlock' } }))
    expect(live).toHaveTextContent('pg is waiting for unlock')

    state(tunnelRuntime({ id: 't1', state: 'failed', error: { code: 'auth', message: 'Authentication failed' } }))
    expect(live).toHaveTextContent('pg failed: Authentication failed')
    // The countdown itself is never in a live region.
    expect(card('pg').querySelectorAll('[aria-live]')).toHaveLength(1)
  })

  it('the server node pulses only while connecting', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'connecting', upAt: null })])
    expect(card('pg').querySelector('[data-node="host"] .od-pulse')).not.toBeNull()
    state(tunnelRuntime({ id: 't1', state: 'retrying', failures: 1, retryAt: new Date(Date.now() + 4000).toISOString() }))
    expect(card('pg').querySelector('.od-pulse')).toBeNull()
    state(tunnelRuntime({ id: 't1', state: 'retrying', retryAt: null, error: { code: 'locked', message: 'Waiting for unlock' } }))
    expect(card('pg').querySelector('.od-pulse')).toBeNull()
  })

  it('locked pause shows waiting for unlock', async () => {
    await renderPage(
      [tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })],
      [tunnelRuntime({ id: 't1', state: 'retrying', retryAt: null, error: { code: 'locked', message: 'Waiting for unlock' } })],
    )
    const c = card('pg')
    expect(within(c).getByText('Waiting for unlock')).toBeInTheDocument()
    expect(c.querySelector('[data-icon="padlock"]')).not.toBeNull()
    expect(within(c).queryByText(/Retrying in/)).not.toBeInTheDocument()
  })

  it('failed shows the holder message and Retry calls start', async () => {
    const invoke = await renderPage(
      [tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })],
      [
        tunnelRuntime({
          id: 't1',
          state: 'failed',
          error: { code: 'port-in-use', message: 'Port 5433 on 127.0.0.1 is in use by postgres (pid 812)' },
        }),
      ],
    )
    const c = card('pg')
    expect(within(c).getByText('Port 5433 on 127.0.0.1 is in use by postgres (pid 812)')).toBeInTheDocument()
    expect(within(c).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    // A bind error breaks the route on the local side.
    expect(c.querySelector('[data-break]')).toHaveAttribute('data-break', 'local')
    fireEvent.click(within(c).getByRole('button', { name: 'Retry' }))
    await flush()
    expect(calls(invoke, 'tunnel:start')).toEqual([['tunnel:start', 't1']])
  })

  it('a link failure breaks the route on the remote side', async () => {
    await renderPage(
      [tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })],
      [tunnelRuntime({ id: 't1', state: 'failed', error: { code: 'auth', message: 'Authentication failed' } })],
    )
    expect(card('pg').querySelector('[data-break]')).toHaveAttribute('data-break', 'remote')
  })

  it('keepalive-only liveness is labelled', async () => {
    await renderPage(
      [
        tunnelMeta({ id: 't1', label: 'app', hostId: 'h-web', type: 'R', bindPort: 9000, targetPort: 3000 }),
        tunnelMeta({ id: 't2', label: 'pg', hostId: 'h-db' }),
      ],
      [tunnelRuntime({ id: 't1', liveness: 'keepalive' }), tunnelRuntime({ id: 't2' })],
    )
    expect(within(card('app')).getByText('Liveness: keepalive only')).toBeInTheDocument()
    expect(within(card('pg')).queryByText('Liveness: keepalive only')).not.toBeInTheDocument()
  })

  it('exposed and protected badges render', async () => {
    await renderPage([
      tunnelMeta({ id: 't1', label: 'open', hostId: 'h-db', bindAddress: '0.0.0.0', environmentId: 'e-prod' }),
      tunnelMeta({ id: 't2', label: 'closed', hostId: 'h-db', environmentId: 'e-stage' }),
    ])
    expect(within(card('open')).getByText('Exposed')).toBeInTheDocument()
    expect(within(card('open')).getByLabelText('Protected environment')).toBeInTheDocument()
    expect(within(card('closed')).queryByText('Exposed')).not.toBeInTheDocument()
    expect(within(card('closed')).queryByLabelText('Protected environment')).not.toBeInTheDocument()
  })

  it('throughput renders from stats without re-rendering siblings', async () => {
    await renderPage(
      [tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' }), tunnelMeta({ id: 't2', label: 'redis', hostId: 'h-db' })],
      [tunnelRuntime({ id: 't1' }), tunnelRuntime({ id: 't2' })],
    )
    const before = routeRenders.get('t2')
    expect(before).toBeGreaterThan(0)
    const stats: TunnelStats = { id: 't1', bytesIn: 0, bytesOut: 0, rateIn: 1_200_000, rateOut: 30_000, connections: 3, rejected: 0, openFailed: 0, lastOpenError: null }
    act(() => emitBridgeEvent('tunnel:stats', [stats]))
    expect(within(card('pg')).getByText('↓ 1.2 MB/s ↑ 30 KB/s · 3 connections')).toBeInTheDocument()
    expect(within(card('pg')).getByText('Throughput of pg')).toBeInTheDocument()
    expect(routeRenders.get('t2')).toBe(before)
  })

  it('connections the server would not forward show why, under the throughput', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1' })])
    const quiet: TunnelStats = { id: 't1', bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0, connections: 0, rejected: 0, openFailed: 0, lastOpenError: null }
    act(() => emitBridgeEvent('tunnel:stats', [quiet]))
    expect(within(card('pg')).queryByTestId('tunnel-open-failures')).not.toBeInTheDocument()
    const reason = "The server couldn't connect to localhost:5432: is anything listening there?"
    act(() => emitBridgeEvent('tunnel:stats', [{ ...quiet, openFailed: 2, lastOpenError: reason }]))
    expect(within(card('pg')).getByTestId('tunnel-open-failures')).toHaveTextContent(`2 connections failed. ${reason}`)
  })

  it('filter chips narrow the grid', async () => {
    await renderPage(
      [
        tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' }),
        tunnelMeta({ id: 't2', label: 'redis', hostId: 'h-db' }),
        tunnelMeta({ id: 't3', label: 'app', hostId: 'h-web' }),
      ],
      [
        tunnelRuntime({ id: 't1' }),
        tunnelRuntime({ id: 't2', state: 'failed', error: { code: 'auth', message: 'Authentication failed' } }),
        tunnelRuntime({ id: 't3', state: 'stopped' }),
      ],
    )
    const labels = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'))
    expect(labels()).toEqual(['pg', 'redis', 'app'])
    fireEvent.click(screen.getByRole('button', { name: /^Running/ }))
    await tick(1000)
    expect(labels()).toEqual(['pg'])
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    await tick(1000)
    expect(labels()).toEqual(['redis'])
    expect(screen.queryByRole('region', { name: 'web' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    await tick(1000)
    expect(labels()).toEqual(['pg', 'redis', 'app'])
  })

  it('empty state offers create and import', async () => {
    await renderPage()
    const empty = screen.getByTestId('tunnels-empty')
    expect(within(empty).getByText('Port forwards that stay up')).toBeInTheDocument()
    expect(within(empty).getByRole('button', { name: 'New tunnel' })).toBeInTheDocument()
    fireEvent.click(within(empty).getByRole('button', { name: 'Import from ssh config' }))
    await flush()
    expect(screen.getByRole('dialog', { name: 'Import from ~/.ssh/config' })).toBeInTheDocument()
  })

  it('shows skeleton cards until loaded', async () => {
    mockBridge({ 'tunnel:list': new Promise(() => {}) })
    render(
      <MemoryRouter initialEntries={['/tunnels']}>
        <AppShell />
      </MemoryRouter>,
    )
    await flush()
    expect(screen.getByTestId('tunnels-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('tunnels-empty')).not.toBeInTheDocument()
  })

  it('reduced motion disables flow and pulse', async () => {
    const tunnels = [tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' }), tunnelMeta({ id: 't2', label: 'redis', hostId: 'h-db' })]
    const runtime = [tunnelRuntime({ id: 't1' }), tunnelRuntime({ id: 't2', state: 'connecting', upAt: null })]
    await renderPage(tunnels, runtime)
    expect(document.querySelector('.od-flow')).not.toBeNull()
    expect(document.querySelector('.od-pulse')).not.toBeNull()
    cleanup()

    motion.safe = false
    resetTunnels()
    await renderPage(tunnels, runtime)
    expect(card('pg')).toBeInTheDocument()
    expect(document.querySelector('.od-flow')).toBeNull()
    expect(document.querySelector('.od-pulse')).toBeNull()
  })

  it('R route draws reversed', async () => {
    await renderPage([tunnelMeta({ id: 't1', label: 'app', hostId: 'h-db', type: 'R', bindPort: 9000, targetHost: 'localhost', targetPort: 3000 })])
    const route = within(card('app')).getByRole('img', { name: /route/i })
    expect(route.textContent).toMatch(/db:9000.*this Mac.*localhost:3000/)
  })

  it('node labels keep the port when the address truncates', async () => {
    await renderPage([
      tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', bindAddress: '127.0.0.1', bindPort: 5433, targetHost: 'localhost', targetPort: 5432 }),
      tunnelMeta({ id: 't2', label: 'app', hostId: 'h-db', type: 'R', bindPort: 9000, targetHost: 'localhost', targetPort: 3000 }),
      tunnelMeta({ id: 't3', label: 'v6', hostId: 'h-db', bindAddress: '::1', bindPort: 8443 }),
    ])
    const port = (label: string, role: string) => card(label).querySelector(`[data-node="${role}"] [data-port]`)
    expect(port('pg', 'local')).toHaveTextContent(':5433')
    expect(port('pg', 'local')?.className).toContain('shrink-0')
    expect(port('pg', 'local')?.previousElementSibling).toHaveTextContent(/^127\.0\.0\.1$/)
    expect(port('pg', 'local')?.previousElementSibling?.className).toContain('truncate')
    expect(port('pg', 'target')).toHaveTextContent(':5432')
    expect(port('app', 'host')).toHaveTextContent(':9000')
    expect(port('v6', 'local')?.previousElementSibling).toHaveTextContent('[::1]')
    expect(port('pg', 'host')).toBeNull()
  })

  it('L and SOCKS routes', async () => {
    await renderPage([
      tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' }),
      tunnelMeta({ id: 't2', label: 'socks', hostId: 'h-db', type: 'D', bindPort: 1080, targetHost: null, targetPort: null }),
    ])
    expect(within(card('pg')).getByRole('img', { name: /route/i }).textContent).toMatch(/127\.0\.0\.1:5433.*db.*localhost:5432/)
    expect(within(card('socks')).getByRole('img', { name: /route/i }).textContent).toMatch(/127\.0\.0\.1:1080.*db.*\*/)
  })
})
