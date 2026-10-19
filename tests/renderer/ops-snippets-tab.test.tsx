import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertStore } from '../../src/renderer/src/ops/insert'
import { resetSnippets } from '../../src/renderer/src/ops/snippets'
import { InsertHost } from '../../src/renderer/src/pages/ops/InsertHost'
import { RunTab } from '../../src/renderer/src/pages/ops/RunTab'
import { SnippetsTab } from '../../src/renderer/src/pages/ops/SnippetsTab'
import { TabStrip } from '../../src/renderer/src/pages/terminals/TabStrip'
import { disposeAll, getTerminal } from '../../src/renderer/src/terminal/registry'
import { resetSessions, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import type { SnippetMeta } from '../../src/shared/ops'
import type { SessionMeta } from '../../src/shared/ssh'
import { mockBridge } from './helpers'
import { fake, resetFakeXterm } from './terminal-fakes'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const STAMP = '2026-10-19T09:00:00.000Z'
const snip = (id: string, label: string, over: Partial<SnippetMeta> = {}): SnippetMeta => ({
  id,
  label,
  script: 'echo hi',
  description: '',
  tags: [],
  variables: [],
  destructive: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const disk = snip('s-disk', 'Disk usage', { script: 'df -h', tags: ['system'] })
const logs = snip('s-logs', 'Tail logs', { script: 'tail -n {{lines}} {{file}}', tags: ['logs'], variables: [{ name: 'lines', default: '50' }, { name: 'file', default: null }] })
const wipe = snip('s-wipe', 'Prune images', { script: 'docker system prune -af', tags: ['docker'], destructive: true })

const session = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'sess-1',
  kind: 'ssh',
  hostId: 'h-1',
  environmentId: null,
  label: 'web-1',
  color: null,
  state: 'ready',
  hops: [],
  error: null,
  openedAt: STAMP,
  readyAt: STAMP,
  closedAt: null,
  attempt: 1,
  container: null,
  ...over,
})

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

let where = ''
function Where() {
  where = useLocation().pathname
  return null
}

async function renderTab(results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'snippets:list': [disk, logs, wipe], ...results })
  render(
    <MemoryRouter initialEntries={['/ops/snippets']}>
      <Routes>
        <Route path="/ops/snippets" element={<SnippetsTab />} />
        <Route path="/terminals" element={null} />
      </Routes>
      <InsertHost />
      <Where />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

const rows = () => screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))
const openMenu = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }))
const pick = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }))

beforeEach(() => {
  resetFakeXterm()
  vi.mocked(toast).mockClear()
})
afterEach(() => {
  cleanup()
  disposeAll()
  resetSnippets()
  resetSessions()
  clearToasts()
})

describe('Snippets tab', () => {
  it('filters snippets by search and tag', async () => {
    await renderTab()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(within(screen.getByRole('listitem', { name: 'Prune images' })).getByText('Destructive')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search snippets' }), { target: { value: 'disk' } })
    await waitFor(() => expect(rows()).toEqual(['Disk usage']))

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search snippets' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'logs' }))
    await waitFor(() => expect(rows()).toEqual(['Tail logs']))
    expect(within(screen.getByRole('listitem', { name: 'Tail logs' })).getByText('lines')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'system' }))
    await waitFor(() => expect(rows()).toEqual(['Disk usage', 'Tail logs']))
  })

  it('the editor shows detected variables live and main\'s template error inline', async () => {
    const invoke = await renderTab()
    const create = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'snippets:create') throw new Error('Error invoking remote method: The script has an unclosed {{ placeholder')
      return create(channel)
    })
    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Greeter' } })
    fireEvent.change(within(dialog).getByLabelText('Script'), { target: { value: 'echo {{name}} {{who}}' } })
    expect(within(dialog).getByText('name')).toBeTruthy()
    expect(within(dialog).getByText('who')).toBeTruthy()
    expect(within(dialog).getByLabelText('Default for name')).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Script'), { target: { value: 'echo {{name}}' } })
    expect(within(dialog).queryByText('who')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await flush()
    expect(within(dialog).getByText(/unclosed/)).toBeTruthy()
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('insert renders with values and writes to the active session without a newline', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    const invoke = await renderTab({ 'snippets:render': 'tail -n 20 /var/log/syslog' })
    openMenu('Tail logs')
    pick('Insert into terminal')
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('lines'), { target: { value: '20' } })
    fireEvent.change(within(dialog).getByLabelText('file'), { target: { value: '/var/log/syslog' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }))
    await flush()

    expect(calls(invoke, 'snippets:render')[0].slice(1)).toEqual(['s-logs', { lines: '20', file: '/var/log/syslog' }])
    expect(fake.terms[0].paste).toHaveBeenCalledWith('tail -n 20 /var/log/syslog')
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inserted Tail logs' }))
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('syslog')
  })

  it('insert without variables writes at once, and says so when no terminal is ready', async () => {
    const invoke = await renderTab({ 'snippets:render': 'df -h' })
    openMenu('Disk usage')
    pick('Insert into terminal')
    await flush()
    expect(fake.terms).toHaveLength(0)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'No terminal is ready' }))

    sessionStore.set({ sessions: [session({ kind: 'local', hostId: null })], order: ['sess-1'], activeId: 'sess-1' })
    openMenu('Disk usage')
    pick('Insert into terminal')
    await flush()
    expect(fake.terms[0].paste).toHaveBeenCalledWith('df -h')
  })

  it('delete asks for confirmation', async () => {
    const invoke = await renderTab()
    openMenu('Disk usage')
    pick('Delete')
    const dialog = await screen.findByRole('dialog')
    expect(calls(invoke, 'snippets:delete')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls(invoke, 'snippets:delete')[0].slice(1)).toEqual(['s-disk']))
  })

  it('the editor says what is encrypted and what is not', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Snippets are encrypted in your Default vault. Values you type at run time are never stored.')).toBeTruthy()
    expect(within(dialog).getByText("Label, description and tags aren't encrypted, so keep secrets out of them.")).toBeTruthy()
    expect(within(dialog).getByText('Separate tags with commas or spaces.')).toBeTruthy()
  })

  it('a tag error from main shows under Tags, not under the script', async () => {
    const invoke = await renderTab()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'snippets:create') throw new Error('a snippet tag is invalid')
      return base(channel)
    })
    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'X' } })
    fireEvent.change(within(dialog).getByLabelText('Script'), { target: { value: 'ls' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await flush()
    expect(within(within(dialog).getByLabelText('Tags').closest('div')!.parentElement!).getByText('a snippet tag is invalid')).toBeTruthy()
    expect(within(dialog).getByLabelText('Script').getAttribute('aria-invalid')).toBeNull()
  })

  it('edit saves over the same snippet, duplicate saves a copy, and the switch sets destructive', async () => {
    const invoke = await renderTab({
      'snippets:update': { ...logs, destructive: true },
      'snippets:create': { ...disk, id: 's-copy', label: 'Disk usage copy' },
    })
    openMenu('Tail logs')
    pick('Edit')
    let dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Label') as HTMLInputElement).value).toBe('Tail logs')
    expect((within(dialog).getByLabelText('Default for lines') as HTMLInputElement).value).toBe('50')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Always ask for confirmation in protected environments' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await flush()
    const [, id, input] = calls(invoke, 'snippets:update')[0] as [string, string, Record<string, unknown>]
    expect(id).toBe('s-logs')
    expect(input).toMatchObject({ label: 'Tail logs', script: 'tail -n {{lines}} {{file}}', destructive: true, defaults: { lines: '50', file: null } })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    openMenu('Disk usage')
    pick('Duplicate')
    dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Label') as HTMLInputElement).value).toBe('Disk usage copy')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await flush()
    expect(calls(invoke, 'snippets:create')[0][1]).toMatchObject({ label: 'Disk usage copy', script: 'df -h', destructive: false })
  })

  it('a snippet with variables and no ready terminal says so before asking for values', async () => {
    await renderTab()
    openMenu('Tail logs')
    pick('Insert into terminal')
    await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'No terminal is ready' }))
  })

  it('both insert paths end on the terminals page', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:render': 'df -h' })
    openMenu('Disk usage')
    pick('Insert into terminal')
    await flush()
    expect(where).toBe('/terminals')
  })

  it('the terminal toolbar button opens the picker, which inserts the chosen snippet', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    const invoke = await renderTab({ 'snippets:render': 'df -h' })
    render(
      <MemoryRouter>
        <TabStrip sessions={[session()]} activeId="sess-1" envName={() => undefined} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onSnippets={() => insertStore.set({ kind: 'pick' })} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Snippets' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Disk usage/ }))
    await flush()
    expect(fake.terms[0].paste).toHaveBeenCalledWith('df -h')
  })

  it('the fill dialog path ends on the terminals page too', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:render': 'tail -n 50 x' })
    openMenu('Tail logs')
    pick('Insert into terminal')
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('file'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }))
    await flush()
    expect(where).toBe('/terminals')
  })
})

describe('insert and line breaks', () => {
  const multi = snip('s-multi', 'Rotate', { script: 'cd /srv\nrm -rf old' })
  const tabbed = snip('s-tab', 'Tabbed', { script: 'echo a\tb' })
  const run = async (label: string) => {
    openMenu(label)
    pick('Insert into terminal')
    await flush()
  }

  it('a multi-line snippet is refused while bracketed paste is off, and nothing is typed', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:list': [multi], 'snippets:render': 'cd /srv\nrm -rf old' })
    await run('Rotate')
    expect(fake.terms[0].paste).not.toHaveBeenCalled()
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'This snippet has several lines; run it from Ops › Run' }))
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('rm -rf')
  })

  it('a tab is refused while bracketed paste is off', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:list': [tabbed], 'snippets:render': 'echo a\tb' })
    await run('Tabbed')
    expect(fake.terms[0].paste).not.toHaveBeenCalled()
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'This snippet has several lines; run it from Ops › Run' }))
  })

  it('a multi-line snippet is pasted whole when bracketed paste is on', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:list': [multi], 'snippets:render': 'cd /srv\nrm -rf old' })
    Object.assign(getTerminal('sess-1').term.modes, { bracketedPasteMode: true })
    await run('Rotate')
    expect(fake.terms[0].paste).toHaveBeenCalledWith('cd /srv\nrm -rf old')
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inserted Rotate' }))
  })

  it('trailing line breaks are dropped so a single line never runs by itself', async () => {
    sessionStore.set({ sessions: [session()], order: ['sess-1'], activeId: 'sess-1' })
    await renderTab({ 'snippets:render': 'df -h\n' })
    await run('Disk usage')
    expect(fake.terms[0].paste).toHaveBeenCalledWith('df -h')
  })
})

describe('Run tab ?snippet=', () => {
  it('opens the snippet mode with the snippet picked', async () => {
    mockBridge({ 'snippets:list': [disk, logs], 'snippets:render': 'tail -n 50 x' })
    render(
      <MemoryRouter initialEntries={['/ops/run?snippet=s-logs']}>
        <RunTab />
      </MemoryRouter>,
    )
    await flush()
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Snippet' }) as HTMLSelectElement).value).toBe('s-logs'))
    expect(screen.getByRole('radio', { name: 'Snippet' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('lines') as HTMLInputElement).value).toBe('50')
  })
})
