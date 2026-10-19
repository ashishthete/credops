import './flow-stubs'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { SECTIONS } from '../../src/renderer/src/shell/sections'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { TunnelMeta, TunnelRuntime } from '../../src/shared/tunnels'
import { emitBridgeEvent, environment, host, mockBridge, product, renderShell, session, tunnelMeta, tunnelRuntime } from './helpers'

const web = product({ id: 'p1', name: 'Web', color: '#5b8cff' })
const billing = product({ id: 'p2', name: 'Billing', color: '#f2a93b' })
const prod = environment({
  id: 'e1',
  name: 'Prod',
  color: '#ef5b5b',
  protected: true,
  productIds: ['p1', 'p2'],
  hosts: [
    { hostId: 'h3', role: 'bastion' },
    { hostId: 'h1', role: 'app' },
    { hostId: 'h2', role: 'db' },
  ],
})
const stage = environment({ id: 'e2', name: 'Stage', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const hosts = [
  host({ id: 'h1', label: 'web', address: '10.0.0.5', jumpHostId: 'h3', vaultIds: [] }),
  host({ id: 'h2', label: 'pg', osIcon: 'linux' }),
  host({ id: 'h3', label: 'bastion' }),
]

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)

async function renderMap(path = '/map', over: Record<string, unknown> = {}, tunnels: TunnelMeta[] = [], runtime: TunnelRuntime[] = []) {
  const invoke = mockBridge({
    'product:list': [web, billing],
    'env:list': [prod, stage],
    'host:list': hosts,
    'tunnel:list': tunnels,
    'tunnel:status': runtime,
    ...over,
  })
  renderShell(path)
  await flush()
  await flush()
  return invoke
}

beforeEach(() => {
  vi.useFakeTimers()
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

describe('map page', () => {
  it(`mod+${SECTIONS.findIndex((s) => s.id === 'map') + 1} opens the Map`, async () => {
    await renderMap('/products')
    act(() => {
      fireEvent.keyDown(window, { key: String(SECTIONS.findIndex((s) => s.id === 'map') + 1), metaKey: true })
    })
    await flush()
    expect(screen.getByRole('heading', { name: 'Map', level: 1 })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: /Map/ })).toHaveAttribute('aria-current', 'page')
  })

  it('summarises what it draws in the header', async () => {
    await renderMap('/map', {}, [tunnelMeta({ id: 't1', hostId: 'h2' }), tunnelMeta({ id: 't2', hostId: 'h2' })], [
      tunnelRuntime({ id: 't1', state: 'up' }),
      tunnelRuntime({ id: 't2', state: 'stopped' }),
    ])
    expect(screen.getByText('2 environments · 3 hosts · 1 tunnel up')).toBeInTheDocument()
  })

  it('renders groups and hosts inside them', async () => {
    await renderMap()
    expect(node('p:p1')).toHaveTextContent('Web')
    expect(node('p:p1')).toHaveTextContent('2 environments')
    expect(node('e:e1')).not.toBeNull()
    const h1 = node('e:e1/h:h1')!
    expect(h1).not.toBeNull()
    expect(h1).toHaveTextContent('web')
    expect(h1).toHaveTextContent('10.0.0.5')
    // Children sit inside their group: React Flow positions them relative to the parent.
    expect(node('e:e1')).toHaveTextContent('Prod')
    expect(node('e:e1')).toHaveTextContent('3 hosts')
    expect(node('e:e1')).toHaveTextContent('also in Billing')
    expect(within(node('e:e1')!).getByLabelText('Protected')).toBeInTheDocument()
  })

  it('host shows role, OS and reachability text', async () => {
    await renderMap()
    const pg = node('e:e1/h:h2')!
    expect(within(pg).getByTitle('Database')).toBeInTheDocument()
    expect(within(pg).getByTitle('Linux')).toBeInTheDocument()
    expect(within(pg).getByLabelText('Not checked')).toBeInTheDocument()
    act(() => emitBridgeEvent('session:state', session({ id: 's1', hostId: 'h2', state: 'ready' })))
    expect(within(pg).getByLabelText('Reachable')).toBeInTheDocument()
    expect(within(pg).getByLabelText('1 session')).toHaveTextContent('1')
  })

  it('a shared host shows its shared chip in both groups', async () => {
    await renderMap()
    expect(node('e:e1/h:h1')).toHaveTextContent('shared ×2')
    expect(node('e:e2/h:h1')).toHaveTextContent('shared ×2')
    expect(node('e:e1/h:h2')).not.toHaveTextContent('shared')
  })

  it('a jump host outside the filter shows a via chip', async () => {
    await renderMap('/map?env=e2')
    expect(node('e:e1')).toBeNull()
    expect(node('e:e2/h:h1')).toHaveTextContent('via bastion')
  })

  it('this Mac appears only when there are tunnels', async () => {
    await renderMap()
    expect(node('mac')).toBeNull()
    cleanup()
    inventoryStore.set(null)
    resetTunnels()
    await renderMap('/map', {}, [tunnelMeta({ id: 't1', hostId: 'h2' }), tunnelMeta({ id: 't2', hostId: 'h1' })])
    expect(node('mac')).toHaveTextContent('This Mac')
    expect(node('mac')).toHaveTextContent('2 tunnels')
  })

  it('minimap and controls render; attribution is hidden', async () => {
    await renderMap()
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull()
    expect(document.querySelector('.react-flow__controls')).not.toBeNull()
    expect(document.querySelector('.react-flow__attribution')).toBeNull()
  })

  it('selecting a node marks it; the pane clears it', async () => {
    await renderMap()
    fireEvent.click(node('e:e1/h:h2')!)
    await flush()
    expect(node('e:e1/h:h2')).toHaveClass('selected')
    fireEvent.click(document.querySelector('.react-flow__pane')!)
    await flush()
    expect(node('e:e1/h:h2')).not.toHaveClass('selected')
  })

  it('empty state offers add and import', async () => {
    await renderMap('/map', { 'product:list': [], 'env:list': [], 'host:list': [] })
    expect(screen.getByText('Nothing to map yet')).toBeInTheDocument()
    expect(screen.getByText('Add hosts and they appear here, grouped by environment.')).toBeInTheDocument()
    expect(document.querySelector('.react-flow')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import from ssh config' }))
    await flush()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('empty state add opens the new host dialog', async () => {
    await renderMap('/map', { 'product:list': [], 'env:list': [], 'host:list': [] })
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    await flush()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: /host/i })).toBeInTheDocument()
  })

  it('loading shows a skeleton', async () => {
    await renderMap('/map', { 'product:list': new Promise(() => {}) })
    expect(screen.getByRole('heading', { name: 'Map', level: 1 })).toBeInTheDocument()
    expect(screen.getByLabelText('Loading map')).toBeInTheDocument()
    expect(document.querySelector('.react-flow')).toBeNull()
  })
})
