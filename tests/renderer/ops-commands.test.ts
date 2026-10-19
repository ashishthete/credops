import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { useOpsCommands } from '../../src/renderer/src/ops/commands'
import { resetSnippets, snippetStore } from '../../src/renderer/src/ops/snippets'
import { resetSessions, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { commandStore } from '../../src/renderer/src/ui/commands'
import type { SnippetMeta } from '../../src/shared/ops'
import type { SessionMeta } from '../../src/shared/ssh'
import { host, mockBridge } from './helpers'

const STAMP = '2026-10-19T09:00:00.000Z'
const snip = (id: string, label: string, tags: string[] = []): SnippetMeta => ({
  id, label, script: 'echo', description: '', tags, variables: [], destructive: false, createdAt: STAMP, updatedAt: STAMP,
})
const tab = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'sess-1', kind: 'ssh', hostId: 'h-web', environmentId: null, label: 'web', color: null, state: 'ready', hops: [], error: null,
  openedAt: STAMP, readyAt: STAMP, closedAt: null, attempt: 1, container: null, ...over,
})

let where = ''
const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, { initialEntries: ['/products'] }, children, createElement(Where))
function Where() {
  const l = useLocation()
  where = l.pathname + l.search
  return null
}
const ops = () => commandStore.get().filter((c) => c.section === 'Ops')
const titles = () => ops().map((c) => c.title).sort()
const command = (title: string) => commandStore.get().find((c) => c.title === title)!

beforeEach(() => {
  mockBridge({ 'snippets:list': [] })
  resetSnippets()
  snippetStore.set({ snippets: [snip('s1', 'Disk usage', ['system']), snip('s2', 'Tail logs')], loaded: true })
  inventoryStore.set({ products: [], environments: [], hosts: [host({ id: 'h-web', label: 'web' }), host({ id: 'h-db', label: 'db' })], identities: [], vaults: [] })
})
afterEach(() => {
  cleanup()
  resetSnippets()
  resetSessions()
  inventoryStore.set(null)
})

describe('ops commands', () => {
  it('registers run/insert commands per snippet and container commands per host; insert only with an active tab', async () => {
    const { unmount } = renderHook(() => useOpsCommands(), { wrapper })
    expect(titles()).toEqual([
      'Containers on db',
      'Containers on web',
      'New snippet',
      'Run a command on hosts…',
      'Run snippet: Disk usage',
      'Run snippet: Tail logs',
    ])
    expect(command('Run snippet: Disk usage').keywords).toContain('system')

    act(() => sessionStore.set({ sessions: [tab()], order: ['sess-1'], activeId: 'sess-1' }))
    expect(titles()).toContain('Insert snippet into terminal: Disk usage')
    expect(titles()).toContain('Insert snippet into terminal: Tail logs')

    act(() => command('Run snippet: Tail logs').run())
    expect(where).toBe('/ops/run?snippet=s2&hosts=h-web')
    act(() => command('New snippet').run())
    expect(where).toBe('/ops/snippets?action=new')
    act(() => command('Run a command on hosts…').run())
    expect(where).toBe('/ops/run')
    act(() => command('Containers on db').run())
    expect(where).toBe('/ops/containers?host=h-db')

    act(() => sessionStore.set({ sessions: [], order: [], activeId: null }))
    expect(titles().some((t) => t.startsWith('Insert snippet'))).toBe(false)
    expect(command('Run snippet: Tail logs')).toBeDefined()
    unmount()
    expect(ops()).toHaveLength(0)
  })
})
