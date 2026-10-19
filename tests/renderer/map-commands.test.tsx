import './flow-stubs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { pinsStore } from '../../src/renderer/src/map/viewport'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { defaultVault, environment, host, mockBridge, product } from './helpers'

const platform = product({ id: 'p1', name: 'Platform' })
const prod = environment({ id: 'e1', name: 'prod', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const stage = environment({ id: 'e2', name: 'stage', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'db' }] })
const hosts = [host({ id: 'h1', label: 'web' }), host({ id: 'h2', label: 'pg' })]

const flush = () => act(async () => {})
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const focused = () => document.querySelector<HTMLElement>('.react-flow__node[data-focused="true"]')?.dataset.id ?? null
const titles = () =>
  commandStore
    .get()
    .filter((c) => c.section === 'Map')
    .map((c) => c.title)
    .sort()
const command = (title: string) => commandStore.get().find((c) => c.title === title)!

const at = { path: '', search: '' }
function LocationProbe() {
  const l = useLocation()
  at.path = l.pathname
  at.search = l.search
  return null
}

async function renderShell(path: string) {
  mockBridge({
    'product:list': [platform],
    'env:list': [prod, stage],
    'host:list': hosts,
    'identity:list': [],
    'vault:list': [defaultVault],
    'tunnel:list': [],
    'tunnel:status': [],
  })
  const out = render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
  await flush()
  return out
}

async function run(title: string) {
  await act(async () => {
    command(title).run()
  })
  await flush()
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  inventoryStore.set(null)
  pinsStore.set({})
  resetTunnels()
  resetSessions()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  pinsStore.set({})
  resetTunnels()
  resetSessions()
  clearToasts()
})

describe('map commands', () => {
  it('registers the map commands, and drops them on unmount', async () => {
    const { unmount } = await renderShell('/products')
    expect(titles()).toEqual(['Find on map', 'Reset map layout', 'Show pg on map', 'Show prod on map', 'Show stage on map', 'Show web on map'])
    // Opening the map is the section's own command.
    expect(command('Go to Map').shortcut).toBe('mod+6')
    expect(command('Show prod on map').keywords).toContain('Platform')
    unmount()
    expect(titles()).toEqual([])
  })

  it('Show prod on map scopes the map to that environment', async () => {
    await renderShell('/products')
    await run('Show prod on map')
    expect(at.path).toBe('/map')
    expect(at.search).toBe('?env=e1')
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('e1')
  })

  it('Show web on map zooms to its first placement and focuses it', async () => {
    await renderShell('/products')
    await run('Show web on map')
    expect(at.path).toBe('/map')
    // The one-shot param is dropped again.
    expect(at.search).toBe('')
    expect(focused()).toBe('e:e1/h:h1')
    expect(node('e:e1/h:h1')).toHaveClass('selected')
    expect(screen.getByRole('complementary', { name: 'web' })).toBeInTheDocument()
  })

  it('Find on map opens the map with the caret in the search box', async () => {
    await renderShell('/hosts')
    await run('Find on map')
    expect(at.path).toBe('/map')
    expect(at.search).toBe('')
    expect(document.activeElement).toBe(screen.getByLabelText('Find on map'))
  })

  it('Reset map layout clears the dragged positions of the view on screen', async () => {
    await renderShell('/map?env=e2')
    act(() => {
      pinsStore.set({ 'e:e2': { 'e:e2/h:h1': { x: 1, y: 2 } }, all: { 'p:p1': { x: 3, y: 4 } } })
    })
    await run('Reset map layout')
    expect(pinsStore.get()).toEqual({ all: { 'p:p1': { x: 3, y: 4 } } })
    act(() => {
      pinsStore.set({ all: { 'p:p1': { x: 3, y: 4 } } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /Products/ }))
    })
    await run('Reset map layout')
    expect(pinsStore.get()).toEqual({})
  })
})

describe('Show on map from the inventory', () => {
  it('a product and an environment open the map scoped to them', async () => {
    await renderShell('/products?node=p:p1')
    fireEvent.click(screen.getByRole('button', { name: 'Show on map' }))
    await flush()
    expect(at.path).toBe('/map')
    expect(at.search).toBe('?product=p1')

    cleanup()
    await renderShell('/products?node=p:p1/e:e2')
    fireEvent.click(screen.getByRole('button', { name: 'Show on map' }))
    await flush()
    expect(at.search).toBe('?env=e2')
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('e2')
  })

  it("a host's menu shows it on the map, focused", async () => {
    await renderShell('/hosts?host=h2')
    fireEvent.click(screen.getByRole('button', { name: 'pg options' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show on map' }))
    await flush()
    await flush()
    expect(at.path).toBe('/map')
    expect(focused()).toBe('e:e2/h:h2')
    expect(screen.getByRole('complementary', { name: 'pg' })).toBeInTheDocument()
  })
})
