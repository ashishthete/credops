import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInventoryCommands } from '../../src/renderer/src/inventory/commands'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { openQuickConnect, QuickConnect, rankHosts } from '../../src/renderer/src/pages/terminals/QuickConnect'
import { favouriteStore, reloadFavourites, toggleFavourite } from '../../src/renderer/src/terminal/favourites'
import { commandStore, rankCommands, type Command } from '../../src/renderer/src/ui/commands'
import { environment, host } from './helpers'

const sessions = vi.hoisted(() => ({ openSsh: vi.fn() }))
vi.mock('../../src/renderer/src/terminal/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/terminal/sessions')>()),
  openSsh: sessions.openSsh,
}))

const KEY = 'opsdeck.terminal.favourites'
let where = ''
function Where() {
  where = useLocation().pathname
  return null
}

beforeEach(() => {
  where = ''
  localStorage.clear()
  reloadFavourites()
  sessions.openSsh.mockReset().mockResolvedValue('s1')
  inventoryStore.set({
    products: [],
    environments: [
      environment({ id: 'prod', name: 'prod', hosts: [{ hostId: 'db1', role: 'db' }, { hostId: 'both', role: 'app' }] }),
      environment({ id: 'staging', name: 'staging', hosts: [{ hostId: 'both', role: 'app' }] }),
    ],
    hosts: [
      host({ id: 'db1', label: 'db-primary', address: '10.0.0.9', tags: ['postgres'], environments: [{ environmentId: 'prod', role: 'db' }] }),
      host({ id: 'both', label: 'deploy-box', environments: [{ environmentId: 'prod', role: 'app' }, { environmentId: 'staging', role: 'app' }] }),
      host({ id: 'web', label: 'web-1' }),
    ],
    identities: [],
    vaults: [],
    regions: [],
  })
})

afterEach(() => {
  cleanup()
  inventoryStore.set(null)
  localStorage.clear()
  reloadFavourites()
})

describe('favourites', () => {
  it('starring toggles, persists, and survives a reload; junk in storage reads as none', () => {
    toggleFavourite('web')
    toggleFavourite('db1')
    expect(favouriteStore.get()).toEqual(['web', 'db1'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['web', 'db1'])
    toggleFavourite('web')
    reloadFavourites()
    expect(favouriteStore.get()).toEqual(['db1'])
    localStorage.setItem(KEY, '{nope')
    reloadFavourites()
    expect(favouriteStore.get()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify(['ok', 3, null]))
    reloadFavourites()
    expect(favouriteStore.get()).toEqual(['ok'])
  })

  it('rankHosts puts favourites first with no query, and ahead of near ties on one', () => {
    const hosts = [
      { id: 'a', label: 'api-2', keywords: [] },
      { id: 'b', label: 'api-1', keywords: [] },
      { id: 'c', label: 'cache', keywords: ['10.1.1.1'] },
    ]
    expect(rankHosts(hosts, '', []).map((r) => r.host.id)).toEqual(['b', 'a', 'c'])
    expect(rankHosts(hosts, '', ['c', 'a']).map((r) => r.host.id)).toEqual(['a', 'c', 'b'])
    expect(rankHosts(hosts, 'api', ['a']).map((r) => r.host.id)).toEqual(['a', 'b'])
    expect(rankHosts(hosts, '10.1', []).map((r) => r.host.id)).toEqual(['c'])
    expect(rankHosts(hosts, 'zzz', [])).toEqual([])
  })

  it('the palette lists favourites after Recent on an empty query and ranks them up on a query', () => {
    const cmd = (id: string, title: string, favourite = false): Command => ({ id, title, section: 'Terminals', favourite, run: () => {} })
    const commands = [cmd('x', 'Connect to api-1'), cmd('y', 'Connect to api-2', true), cmd('z', 'Connect to zeta', true), { ...cmd('n', 'New host'), section: 'Hosts' }]
    expect(rankCommands(commands, '', ['z']).map((r) => [r.command.id, r.group])).toEqual([
      ['z', 'Recent'],
      ['y', 'Favourites'],
      ['x', 'Terminals'],
      ['n', 'Hosts'],
    ])
    expect(rankCommands(commands, 'api', []).map((r) => r.command.id)).toEqual(['y', 'x'])
  })

  it('palette Connect commands carry the star, and follow it as it changes', () => {
    const { unmount } = renderHook(useInventoryCommands, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> })
    const command = (id: string) => commandStore.get().find((c) => c.id === id)!
    expect(command('connect:db1').favourite).toBe(false)
    act(() => toggleFavourite('db1'))
    expect(command('connect:db1').favourite).toBe(true)
    expect(command('connect:web').favourite).toBe(false)
    expect(command('terminal.quickConnect')).toMatchObject({ title: 'Quick connect…', section: 'Terminals' })
    unmount()
  })
})

describe('Quick connect', () => {
  const renderDialog = () => {
    render(
      <MemoryRouter initialEntries={['/hosts']}>
        <Where />
        <QuickConnect />
      </MemoryRouter>,
    )
    act(() => openQuickConnect())
  }
  const input = () => screen.getByRole('combobox', { name: 'Host' })
  const options = () => screen.getAllByRole('option').map((o) => o.textContent)

  it('a fuzzy name and Enter open a session to that host with its only environment', async () => {
    renderDialog()
    expect(input()).toHaveFocus()
    fireEvent.change(input(), { target: { value: 'db-p' } })
    expect(options()).toHaveLength(1)
    expect(options()[0]).toContain('db-primary')
    await act(async () => void fireEvent.keyDown(input(), { key: 'Enter' }))
    expect(sessions.openSsh).toHaveBeenCalledWith('db1', 'prod')
    expect(where).toBe('/terminals')
  })

  it('matches address and tags, and a host in several environments connects without one', async () => {
    renderDialog()
    fireEvent.change(input(), { target: { value: 'postgres' } })
    expect(options()[0]).toContain('db-primary')
    fireEvent.change(input(), { target: { value: 'deploy' } })
    await act(async () => void fireEvent.click(screen.getByRole('option', { name: /deploy-box/ })))
    expect(sessions.openSsh).toHaveBeenCalledWith('both', undefined)
  })

  it('arrow keys move; a name not in the inventory says so and connects nothing', async () => {
    renderDialog()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(input(), { target: { value: '203.0.113.7' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/only opens hosts in your inventory/)).toBeInTheDocument()
    await act(async () => void fireEvent.keyDown(input(), { key: 'Enter' }))
    expect(sessions.openSsh).not.toHaveBeenCalled()
  })

  it('the star, or mod+D on the highlighted host, makes a favourite that lists first', () => {
    renderDialog()
    expect(options().map((t) => t!.match(/db-primary|deploy-box|web-1/)![0])).toEqual(['db-primary', 'deploy-box', 'web-1'])
    const row = screen.getByRole('option', { name: /web-1/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Star web-1' }))
    expect(favouriteStore.get()).toEqual(['web'])
    expect(sessions.openSsh).not.toHaveBeenCalled()
    expect(options()[0]).toContain('web-1')
    expect(within(screen.getAllByRole('option')[0]).getByRole('button', { name: 'Unstar web-1' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'd', metaKey: true, ctrlKey: true })
    expect(favouriteStore.get()).toEqual(['web', 'db1'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['web', 'db1'])
  })
})
