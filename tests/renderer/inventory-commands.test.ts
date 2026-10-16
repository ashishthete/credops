import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInventoryCommands } from '../../src/renderer/src/inventory/commands'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { commandStore, getRecents, markRecent } from '../../src/renderer/src/ui/commands'
import { environment, host } from './helpers'

const sessions = vi.hoisted(() => ({ openSsh: vi.fn(), openLocal: vi.fn() }))
vi.mock('../../src/renderer/src/terminal/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/terminal/sessions')>()),
  openSsh: sessions.openSsh,
  openLocal: sessions.openLocal,
}))

let where = ''
const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, { initialEntries: ['/hosts'] }, children)
function useHarness() {
  useInventoryCommands()
  where = useLocation().pathname
}

const command = (id: string) => commandStore.get().find((c) => c.id === id)!

beforeEach(() => {
  where = ''
  sessions.openSsh.mockReset().mockResolvedValue('s1')
  sessions.openLocal.mockReset().mockResolvedValue('s2')
  inventoryStore.set({
    products: [],
    environments: [
      environment({ id: 'prod', name: 'prod', hosts: [{ hostId: 'web1', role: 'app' }, { hostId: 'both', role: 'app' }] }),
      environment({ id: 'staging', name: 'staging', hosts: [{ hostId: 'both', role: 'app' }] }),
    ],
    hosts: [
      host({ id: 'web1', label: 'web-1', address: '10.0.0.5', tags: ['api'], environments: [{ environmentId: 'prod', role: 'app' }] }),
      host({
        id: 'both',
        label: 'shared',
        environments: [
          { environmentId: 'prod', role: 'app' },
          { environmentId: 'staging', role: 'app' },
        ],
      }),
      host({ id: 'loose', label: 'loose' }),
    ],
    identities: [],
    vaults: [],
  })
})

afterEach(() => {
  inventoryStore.set(null)
  localStorage.clear()
})

describe('inventory commands: terminals', () => {
  it('palette Connect uses the only environment, none when several', async () => {
    const { unmount } = renderHook(useHarness, { wrapper })
    expect(command('connect:web1').title).toBe('Connect to web-1')
    expect(command('connect:web1').keywords).toEqual(expect.arrayContaining(['10.0.0.5', 'api', 'prod']))
    expect(command('connect:both').keywords).toEqual(expect.arrayContaining(['prod', 'staging']))

    await act(async () => command('connect:web1').run())
    expect(sessions.openSsh).toHaveBeenLastCalledWith('web1', 'prod')
    await act(async () => command('connect:both').run())
    expect(sessions.openSsh).toHaveBeenLastCalledWith('both', undefined)
    await act(async () => command('connect:loose').run())
    expect(sessions.openSsh).toHaveBeenLastCalledWith('loose', undefined)
    expect(where).toBe('/terminals')
    unmount()
    expect(commandStore.get().some((c) => c.id.startsWith('connect:'))).toBe(false)
  })

  it('a failed open stays on the page', async () => {
    sessions.openSsh.mockResolvedValue(undefined)
    const { unmount } = renderHook(useHarness, { wrapper })
    await act(async () => command('connect:web1').run())
    expect(where).toBe('/hosts')
    unmount()
  })

  it('New local shell opens a shell and goes to the terminals', async () => {
    const { unmount } = renderHook(useHarness, { wrapper })
    expect(command('terminal.local')).toMatchObject({ title: 'New local shell', shortcut: 'mod+t' })
    await act(async () => command('terminal.local').run())
    expect(sessions.openLocal).toHaveBeenCalledTimes(1)
    expect(where).toBe('/terminals')
    unmount()
  })

  it('connect commands are registered ids, so recents keep them', () => {
    const { unmount } = renderHook(useHarness, { wrapper })
    markRecent('connect:web1')
    expect(getRecents()).toContain('connect:web1')
    unmount()
  })
})
