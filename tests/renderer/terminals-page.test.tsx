import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { SECTIONS } from '../../src/renderer/src/shell/sections'
import { openKnownHosts } from '../../src/renderer/src/pages/terminals/KnownHostsDialog'
import { resetSessions, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { SessionMeta } from '../../src/shared/ssh'
import { emitBridgeEvent, environment, host, mockBridge } from './helpers'
import { fake, resetFakeXterm } from './terminal-fakes'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    kind: 'local',
    hostId: null,
    environmentId: null,
    label: id,
    color: null,
    state: 'ready',
    hops: [],
    error: null,
    openedAt: '2026-10-17T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    attempt: 1,
    container: null,
    ...over,
  }
}

const ssh = (id: string, over: Partial<SessionMeta> = {}) =>
  meta(id, { kind: 'ssh', hostId: `${id}-host`, hops: [{ label: id, state: 'up' }], ...over })

// Terminals with no session leaves at once, so a test that starts there goes once a session exists.
let toTerminals: (() => void) | null = null
let navigateTo: (path: string) => void = () => {}
const state = (m: SessionMeta) => {
  act(() => emitBridgeEvent('session:state', m))
  const go = toTerminals
  toTerminals = null
  if (go) act(go)
}
const goTo = (path: string) => act(() => navigateTo(path))
function Nav() {
  const navigate = useNavigate()
  navigateTo = (path) => void navigate(path)
  return null
}
const flush = () => act(async () => {})
const key = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, metaKey: true, ...over })
  })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const tab = (label: string) => screen.getByRole('tab', { name: new RegExp(`^${label}\\b`) })

async function renderShell(path = '/terminals', results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'session:attach': { meta: {}, buffer: '', end: 0 }, ...results })
  toTerminals = path === '/terminals' ? () => navigateTo('/terminals') : null
  render(
    <MemoryRouter initialEntries={[path === '/terminals' ? '/products' : path]}>
      <Nav />
      <AppShell />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

// Mounts at `path` as is (a reload keeps the hash route), unlike renderShell's /terminals.
async function renderAt(path: string, results: Record<string, unknown>) {
  const invoke = mockBridge({ 'session:attach': { meta: {}, buffer: '', end: 0 }, ...results })
  toTerminals = null
  render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <AppShell />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  resetFakeXterm()
  inventoryStore.set(null)
  resetSessions()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(async () => {
  // Unmount while the fake clock still runs, so AnimatePresence exits finish on it.
  cleanup()
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearToasts()
})

describe('terminals page', () => {
  it('known hosts does not reopen after the shell unmounts and mounts again (vault lock)', async () => {
    await renderShell('/terminals', { 'knownhost:list': [] })
    act(() => openKnownHosts())
    await flush()
    expect(screen.getByRole('dialog', { name: 'Known hosts' })).toBeInTheDocument()
    cleanup()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    await renderShell('/terminals', { 'knownhost:list': [] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.queryByRole('dialog', { name: 'Known hosts' })).not.toBeInTheDocument()
  })

  it('there is no Terminals section; Open sessions shows only while a session is open, and it goes to the tabs', async () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(['products', 'hosts', 'vaults', 'tunnels', 'map', 'ops', 'deployments', 'hub', 'audit'])
    await renderShell('/products')
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).queryByRole('link', { name: /Terminals/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Open sessions/ })).toBeNull()

    state(meta('s1', { label: 'Local shell 1' }))
    const button = screen.getByRole('button', { name: /Open sessions/ })
    expect(button).toHaveAccessibleName('Open sessions, 1 live')
    expect(button).not.toHaveAttribute('aria-current')
    fireEvent.click(button)
    await flush()
    expect(tab('Local shell 1')).toBeVisible()
    expect(screen.getByRole('button', { name: /Open sessions/ })).toHaveAttribute('aria-current', 'page')

    // Closing the last tab takes the button away with it.
    await goTo('/products')
    act(() => sessionStore.set({ sessions: [], activeId: null, order: [] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.queryByRole('button', { name: /Open sessions/ })).toBeNull()
  })

  it('visiting Terminals with no sessions goes back to the previous page, or home', async () => {
    await renderShell('/hosts')
    await goTo('/terminals')
    await flush()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()

    cleanup()
    await renderShell('/hosts')
    await goTo('/vaults')
    await goTo('/terminals')
    await flush()
    expect(screen.getByRole('heading', { name: 'Vaults', level: 1 })).toBeInTheDocument()
  })

  it('a direct visit with no sessions and no earlier page goes home', async () => {
    await renderAt('/terminals', { 'session:list': [] })
    await flush()
    expect(screen.getByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
  })

  it('a reload on Terminals keeps it until the session list lands, then shows the restored tabs', async () => {
    let release!: (list: SessionMeta[]) => void
    await renderAt('/terminals', { 'session:list': new Promise<SessionMeta[]>((r) => (release = r)) })
    await flush()
    expect(screen.queryByRole('heading', { name: 'Products', level: 1 })).toBeNull()
    await act(async () => release([meta('s1', { label: 'Local shell 1' })]))
    await flush()
    expect(tab('Local shell 1')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Products', level: 1 })).toBeNull()
  })

  it('a reload on Terminals with no sessions goes home once the list lands empty', async () => {
    let release!: (list: SessionMeta[]) => void
    await renderAt('/terminals', { 'session:list': new Promise<SessionMeta[]>((r) => (release = r)) })
    await flush()
    await act(async () => release([]))
    await flush()
    expect(screen.getByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
  })

  it('deck stays mounted across navigation', async () => {
    await renderShell()
    state(meta('s1', { label: 'Local shell 1' }))
    await flush()
    expect(fake.terms).toHaveLength(1)
    key('2') // Hosts
    await flush()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open sessions/ }))
    await flush()
    expect(tab('Local shell 1')).toBeVisible()
    expect(fake.terms).toHaveLength(1)
    expect(fake.terms[0].dispose).not.toHaveBeenCalled()
  })

  it('tab shows env colour stripe and status dot per state', async () => {
    await renderShell('/terminals', { 'env:list': [environment({ id: 'e1', name: 'Staging' })] })
    state(ssh('web', { state: 'connecting', color: '#2fbf71', environmentId: 'e1', hops: [{ label: 'web', state: 'connecting' }] }))
    state(meta('local'))
    state(ssh('db', { state: 'failed', error: { code: 'refused', message: 'db refused the connection' } }))
    state(ssh('old', { state: 'closed' }))
    await flush()
    const web = tab('web')
    expect(web).toHaveTextContent('Staging')
    const stripe = (label: string) => tab(label).closest('[data-session]')!.querySelector('[data-stripe]') as HTMLElement
    expect(stripe('web').style.background).toBe('rgb(47, 191, 113)')
    expect(stripe('local').style.background).toBe('var(--accent)')
    const dot = (label: string) => tab(label).querySelector('[data-state]')
    expect(dot('web')).toHaveAttribute('data-state', 'connecting')
    expect(dot('local')).toHaveAttribute('data-state', 'ready')
    expect(dot('db')).toHaveAttribute('data-state', 'failed')
    expect(dot('old')).toHaveAttribute('data-state', 'closed')
    // The dot is decorative; the state is in each tab's accessible name.
    expect(web).toHaveAccessibleName('web, Staging, Connecting')
    expect(tab('local')).toHaveAccessibleName('local, Connected')
    expect(tab('db')).toHaveAccessibleName('db, Failed')
    expect(tab('old')).toHaveAccessibleName('old, Closed')
  })

  it('connect overlay shows the hop chain and marks the failed hop', async () => {
    await renderShell()
    state(ssh('db', { state: 'connecting', hops: [{ label: 'bastion', state: 'connecting' }, { label: 'db', state: 'pending' }] }))
    const chain = () => screen.getByRole('list', { name: 'Connection path' })
    expect(within(chain()).getByText('This Mac')).toBeInTheDocument()
    expect(within(chain()).getByText('bastion').closest('[data-state]')).toHaveAttribute('data-state', 'connecting')

    state(
      ssh('db', {
        state: 'failed',
        hops: [{ label: 'bastion', state: 'up' }, { label: 'db', state: 'failed' }],
        error: { code: 'timeout', message: "db didn't answer within 20 s", hopLabel: 'db' },
      }),
    )
    expect(within(chain()).getByText('bastion').closest('[data-state]')).toHaveAttribute('data-state', 'up')
    expect(within(chain()).getByText('db').closest('[data-state]')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByText("db didn't answer within 20 s")).toBeInTheDocument()
  })

  it('overlay leaves once the session is ready', async () => {
    await renderShell()
    state(ssh('web', { state: 'connecting', hops: [{ label: 'web', state: 'connecting' }] }))
    expect(screen.getByRole('list', { name: 'Connection path' })).toBeInTheDocument()
    state(ssh('web'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.queryByRole('list', { name: 'Connection path' })).not.toBeInTheDocument()
  })

  it('failed host-key-changed shows both fingerprints and ssh-keygen command for openssh source', async () => {
    await renderShell()
    state(
      ssh('db', {
        state: 'failed',
        hops: [{ label: 'db', state: 'failed' }],
        error: {
          code: 'host-key-changed',
          message: 'The host key for db has changed',
          hopLabel: 'db',
          hostKey: {
            host: '[db.internal]:2222',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:newnewnew',
            known: [{ keyType: 'ssh-ed25519', fingerprint: 'SHA256:oldoldold', source: 'openssh', line: 3 }],
          },
        },
      }),
    )
    const card = screen.getByRole('alert')
    expect(within(card).getByText('SHA256:oldoldold')).toBeInTheDocument()
    expect(within(card).getByText('SHA256:newnewnew')).toBeInTheDocument()
    expect(within(card).getByText("ssh-keygen -R '[db.internal]:2222'")).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('host-key-changed to a key of another type shows the pinned keys with their types', async () => {
    await renderShell()
    state(
      ssh('db', {
        state: 'failed',
        hops: [{ label: 'db', state: 'failed' }],
        error: {
          code: 'host-key-changed',
          message: 'The host key for db has changed',
          hopLabel: 'db',
          hostKey: {
            host: 'db.internal',
            keyType: 'ecdsa-sha2-nistp256',
            fingerprint: 'SHA256:newnewnew',
            known: [{ keyType: 'ssh-ed25519', fingerprint: 'SHA256:oldoldold', source: 'openssh', line: 3 }],
          },
        },
      }),
    )
    const card = screen.getByRole('alert')
    expect(within(card).getByText('ssh-ed25519 SHA256:oldoldold')).toBeInTheDocument()
    expect(within(card).getByText('ecdsa-sha2-nistp256 SHA256:newnewnew')).toBeInTheDocument()
    expect(within(card).getByText("ssh-keygen -R 'db.internal'")).toBeInTheDocument()
  })

  it('closing a ready tab asks; closing a failed tab does not', async () => {
    const invoke = await renderShell()
    state(ssh('web'))
    state(ssh('db', { state: 'failed', error: { code: 'refused', message: 'refused' } }))

    fireEvent.click(screen.getByRole('button', { name: 'Close db' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500) // the tab collapses out
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls(invoke, 'session:close')).toEqual([['session:close', 'db']])
    expect(screen.queryByRole('tab', { name: /db/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close web' }))
    const dialog = screen.getByRole('dialog', { name: 'Close web?' })
    expect(dialog).toHaveTextContent('The session will end.')
    expect(calls(invoke, 'session:close')).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await flush()
    expect(calls(invoke, 'session:close')).toEqual([
      ['session:close', 'db'],
      ['session:close', 'web'],
    ])
  })

  it('middle-click closes a tab', async () => {
    const invoke = await renderShell()
    state(ssh('old', { state: 'closed' }))
    fireEvent(tab('old'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await flush()
    expect(calls(invoke, 'session:close')).toEqual([['session:close', 'old']])
  })

  it('reconnect button calls session:reconnect', async () => {
    const invoke = await renderShell('/terminals', { 'session:reconnect': ssh('db', { state: 'connecting', attempt: 2 }) })
    state(ssh('db', { state: 'failed', error: { code: 'refused', message: 'refused' } }))
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Reconnect' }))
    await flush()
    expect(calls(invoke, 'session:reconnect')).toEqual([['session:reconnect', 'db']])
  })

  it('a closed ssh session shows the ended bar with reconnect', async () => {
    const invoke = await renderShell()
    state(ssh('web', { state: 'closed' }))
    const bar = screen.getByRole('status', { name: 'Session ended' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Reconnect' }))
    await flush()
    expect(calls(invoke, 'session:reconnect')).toEqual([['session:reconnect', 'web']])

    state(meta('local', { state: 'closed' }))
    fireEvent.click(tab('local'))
    expect(within(screen.getByRole('status', { name: 'Session ended' })).queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })

  it('typing exit in the last tab closes it and goes back to the page you came from', async () => {
    const invoke = await renderShell('/hosts', { 'shell:open': meta('s1', { label: 'Local shell 1' }) })
    key('t')
    await flush()
    expect(tab('Local shell 1')).toBeVisible()
    state(meta('s1', { label: 'Local shell 1', state: 'closed' }))
    await flush()
    expect(calls(invoke, 'session:close')).toHaveLength(1)
    expect(screen.queryByRole('tab', { name: /Local shell 1/ })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
  })

  it('mod+t opens a local shell; mod+shift+] cycles tabs', async () => {
    const invoke = await renderShell('/products', { 'shell:open': meta('s1', { label: 'Local shell 1' }) })
    key('t')
    await flush()
    expect(calls(invoke, 'shell:open')).toHaveLength(1)
    expect(tab('Local shell 1')).toBeVisible() // mod+t also goes to Terminals
    state(meta('s2', { label: 'Local shell 2' }))
    expect(tab('Local shell 1')).toHaveAttribute('aria-selected', 'true')

    key('}', { code: 'BracketRight', shiftKey: true })
    expect(tab('Local shell 2')).toHaveAttribute('aria-selected', 'true')
    key('}', { code: 'BracketRight', shiftKey: true })
    expect(tab('Local shell 1')).toHaveAttribute('aria-selected', 'true')
    key('{', { code: 'BracketLeft', shiftKey: true })
    expect(tab('Local shell 2')).toHaveAttribute('aria-selected', 'true')
  })

  it('mod+w closes the active tab, only while Terminals is visible', async () => {
    const invoke = await renderShell()
    state(ssh('old', { state: 'closed' }))
    key('2') // Hosts
    await flush()
    key('w')
    await flush()
    expect(calls(invoke, 'session:close')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Open sessions/ }))
    await flush()
    key('w')
    await flush()
    expect(calls(invoke, 'session:close')).toEqual([['session:close', 'old']])
  })

  it('sidebar badge counts live sessions', async () => {
    await renderShell('/products')
    state(ssh('a', { state: 'connecting', hops: [] }))
    state(meta('b'))
    state(ssh('c', { state: 'closed' }))
    expect(screen.getByRole('button', { name: /Open sessions/ }).querySelector('[data-badge]')).toHaveTextContent('2')
  })

  it('reduced motion: no pulse class on the connecting dot', async () => {
    await renderShell()
    state(ssh('web', { state: 'connecting', hops: [{ label: 'web', state: 'connecting' }] }))
    expect(tab('web').querySelector('.animate-ping')).not.toBeNull()
    cleanup()

    motion.safe = false
    await renderShell()
    state(ssh('web', { state: 'connecting', hops: [{ label: 'web', state: 'connecting' }] }))
    expect(tab('web').querySelector('[data-state="connecting"]')).not.toBeNull()
    expect(tab('web').querySelector('.animate-ping')).toBeNull()
    expect(document.querySelector('[aria-label="Connection path"] .animate-ping')).toBeNull()
  })

  describe('fix round 1', () => {
    const settle = (ms = 1000) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    const item = (id: string) => document.querySelector<HTMLElement>(`[data-session="${id}"]`)
    const failed = (id: string) => ssh(id, { state: 'failed', error: { code: 'refused', message: 'refused' } })

    it('a closing tab collapses its width; nothing on the collapsing item pins a min-width', async () => {
      await renderShell()
      state(ssh('web'))
      state(failed('db'))
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Close db' }))
      await settle(16)
      const exiting = item('db')!
      expect(exiting.style.width).toBe('0px')
      expect(Number(exiting.style.opacity)).toBeGreaterThan(0)
      expect(exiting.className).not.toMatch(/min-w-/)
      expect(exiting.querySelector('[data-tab-row]')!.className).toMatch(/min-w-\[120px\]/)
      await settle(500)
      expect(item('db')).toBeNull()
    })

    it('reduced motion: a closing tab leaves on the next frame, with no fade', async () => {
      motion.safe = false
      await renderShell()
      state(ssh('web'))
      state(failed('db'))
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Close db' }))
      await settle(16)
      expect(item('db')).toBeNull()
    })

    it('tabs follow the tab pattern: panels, roving tabindex, arrows/Home/End, close outside the tab', async () => {
      await renderShell()
      state(meta('a'))
      state(meta('b'))
      state(meta('c'))
      await settle()
      const [a, b, c] = ['a', 'b', 'c'].map(tab)

      for (const t of [a, b, c]) {
        const panel = document.getElementById(t.getAttribute('aria-controls')!)!
        expect(panel).toHaveAttribute('role', 'tabpanel')
        expect(panel).toHaveAttribute('aria-labelledby', t.id)
      }
      expect(screen.getByRole('tabpanel', { name: 'a, Connected' })).toBeVisible()
      expect([a, b, c].map((t) => t.tabIndex)).toEqual([0, -1, -1])

      // The close button follows the strip's one tab stop: Tab from the active tab reaches it.
      const close = screen.getByRole('button', { name: 'Close a' })
      expect(close.tabIndex).toBe(0)
      expect(['Close b', 'Close c'].map((n) => screen.getByRole('button', { name: n }).tabIndex)).toEqual([-1, -1])
      expect(a.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(a.contains(close)).toBe(false)
      expect(close.closest('[role="tab"]')).toBeNull()

      a.focus()
      fireEvent.keyDown(a, { key: 'ArrowRight' })
      expect(b).toHaveFocus()
      expect(b).toHaveAttribute('aria-selected', 'true')
      expect([a, b, c].map((t) => t.tabIndex)).toEqual([-1, 0, -1])
      expect(['Close a', 'Close b'].map((n) => screen.getByRole('button', { name: n }).tabIndex)).toEqual([-1, 0])
      fireEvent.keyDown(b, { key: 'End' })
      expect(c).toHaveFocus()
      fireEvent.keyDown(c, { key: 'ArrowRight' }) // wraps
      expect(a).toHaveFocus()
      fireEvent.keyDown(a, { key: 'ArrowLeft' }) // wraps back
      expect(c).toHaveFocus()
      fireEvent.keyDown(c, { key: 'Home' })
      expect(a).toHaveFocus()
      expect(sessionStore.get().activeId).toBe('a')
    })

    it('Delete on a focused tab closes it like the close button', async () => {
      await renderShell()
      state(failed('a'))
      state(meta('b'))
      await settle()
      tab('a').focus()
      fireEvent.keyDown(tab('a'), { key: 'Delete' })
      await flush()
      expect(screen.queryByRole('tab', { name: /^a / })).not.toBeInTheDocument()
      expect(tab('b')).toHaveFocus()
      // A live tab asks first, as the close button does.
      fireEvent.keyDown(tab('b'), { key: 'Delete' })
      expect(screen.getByRole('dialog', { name: 'Close b?' })).toBeInTheDocument()
    })

    it('after a close by click, focus moves to the next tab, else the previous; closing the last leaves Terminals', async () => {
      await renderShell()
      state(failed('a'))
      state(failed('b'))
      state(failed('c'))
      await settle()

      const closeB = screen.getByRole('button', { name: 'Close b' })
      closeB.focus()
      fireEvent.click(closeB)
      await flush()
      expect(tab('c')).toHaveFocus()

      const closeC = screen.getByRole('button', { name: 'Close c' })
      closeC.focus()
      fireEvent.click(closeC)
      await flush()
      expect(tab('a')).toHaveFocus()

      const closeA = screen.getByRole('button', { name: 'Close a' })
      closeA.focus()
      fireEvent.click(closeA)
      await settle()
      // No tab left: the deck goes back to the page you came from.
      expect(screen.getByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
      expect(screen.queryByRole('tab')).toBeNull()
    })

    it('middle-click close and a cancelled or confirmed close all leave focus on a tab', async () => {
      await renderShell()
      state(meta('a'))
      state(failed('b'))
      state(meta('c'))
      await settle()

      // Middle-click a failed tab: it goes at once and focus moves to the next.
      document.body.focus()
      fireEvent(tab('b'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      await flush()
      expect(tab('c')).toHaveFocus()

      // Middle-click a live tab, then cancel: focus lands on that tab.
      document.body.focus()
      fireEvent(tab('a'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      const dialog = screen.getByRole('dialog', { name: 'Close a?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await settle()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(tab('a')).toHaveFocus()

      // Confirm a close by click on ×: the button is gone, so focus moves to the next tab.
      const closeA = screen.getByRole('button', { name: 'Close a' })
      closeA.focus()
      fireEvent.click(closeA)
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Close a?' })).getByRole('button', { name: 'Close' }))
      await settle()
      expect(tab('c')).toHaveFocus()
    })

    it('Reconnect is disabled while one is in flight and sends only one request', async () => {
      let release!: (m: SessionMeta) => void
      const invoke = await renderShell()
      const fallback = invoke.getMockImplementation()!
      invoke.mockImplementation(async (ch: string) =>
        ch === 'session:reconnect' ? new Promise<SessionMeta>((r) => (release = r)) : fallback(ch),
      )
      state(ssh('web', { state: 'closed' }))
      const button = () => within(screen.getByRole('status', { name: 'Session ended' })).getByRole('button', { name: 'Reconnect' })
      fireEvent.click(button())
      await flush()
      expect(button()).toBeDisabled()
      expect(button()).toHaveAttribute('aria-busy', 'true')
      fireEvent.click(button())
      await flush()
      expect(calls(invoke, 'session:reconnect')).toHaveLength(1)

      await act(async () => release(ssh('web', { state: 'failed', attempt: 2, error: { code: 'refused', message: 'refused' } })))
      const card = screen.getByRole('alert')
      expect(within(card).getByRole('button', { name: 'Reconnect' })).toBeEnabled()
      fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }))
      await flush()
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Reconnect' })).toBeDisabled()
      expect(calls(invoke, 'session:reconnect')).toHaveLength(2)
    })
  })
})

describe('terminal deck snippets', () => {
  it('the Snippets button opens the picker and inserts into the active tab', async () => {
    const snippet = {
      id: 's1', label: 'Disk usage', script: 'df -h', description: '', tags: [], variables: [], destructive: false,
      createdAt: '2026-10-19T09:00:00.000Z', updatedAt: '2026-10-19T09:00:00.000Z',
    }
    const invoke = await renderShell('/terminals', { 'snippets:list': [snippet], 'snippets:render': 'df -h' })
    state(ssh('a'))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Snippets' }))
    await flush()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Insert a snippet' })).getByRole('button', { name: /Disk usage/ }))
    await flush()
    expect(calls(invoke, 'session:write').at(-1)?.slice(1)).toEqual(['a', 'df -h'])
  })
})
