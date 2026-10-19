import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSnippets } from '../../src/renderer/src/ops/snippets'
import { InsertHost } from '../../src/renderer/src/pages/ops/InsertHost'
import { SnippetsTab } from '../../src/renderer/src/pages/ops/SnippetsTab'
import { resetSessions, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import type { SnippetMeta } from '../../src/shared/ops'
import type { SessionMeta } from '../../src/shared/ssh'
import { mockBridge } from './helpers'

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

async function renderTab(results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'snippets:list': [disk, logs, wipe], ...results })
  render(
    <MemoryRouter initialEntries={['/ops/snippets']}>
      <SnippetsTab />
      <InsertHost />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

const rows = () => screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))
const openMenu = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }))
const pick = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }))

beforeEach(() => {
  vi.mocked(toast).mockClear()
})
afterEach(() => {
  cleanup()
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
    expect(calls(invoke, 'session:write')[0].slice(1)).toEqual(['sess-1', 'tail -n 20 /var/log/syslog'])
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inserted Tail logs' }))
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('syslog')
  })

  it('insert without variables writes at once, and says so when no terminal is ready', async () => {
    const invoke = await renderTab({ 'snippets:render': 'df -h' })
    openMenu('Disk usage')
    pick('Insert into terminal')
    await flush()
    expect(calls(invoke, 'session:write')).toHaveLength(0)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({ title: 'No terminal is ready' }))

    sessionStore.set({ sessions: [session({ kind: 'local', hostId: null })], order: ['sess-1'], activeId: 'sess-1' })
    openMenu('Disk usage')
    pick('Insert into terminal')
    await flush()
    expect(calls(invoke, 'session:write')[0].slice(1)).toEqual(['sess-1', 'df -h'])
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
})
