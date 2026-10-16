import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditPage } from '../../src/renderer/src/pages/AuditPage'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import { auditEvent, mockBridge } from './helpers'

const events = [
  auditEvent({ id: 2, action: 'audit.verify', outcome: 'failure', targetType: 'host', targetLabel: 'web-01' }),
  auditEvent({ id: 1, action: 'app.start', outcome: 'success' }),
]

function renderPage() {
  return render(
    <MemoryRouter>
      <AuditPage />
      <Toaster />
    </MemoryRouter>,
  )
}

const listCalls = (invoke: ReturnType<typeof mockBridge>) => invoke.mock.calls.filter(([c]) => c === 'audit:list')

afterEach(() => {
  vi.useRealTimers()
  act(() => clearToasts())
})

describe('audit page', () => {
  it('audit page lists events', async () => {
    const invoke = mockBridge({ 'audit:list': events })
    renderPage()

    const row = (await screen.findByRole('cell', { name: 'audit.verify' })).closest('tr')!
    expect(within(row).getByText('tester@mac')).toBeInTheDocument()
    expect(within(row).getByText('web-01')).toBeInTheDocument()
    expect(within(row).getByText('failure')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'app.start' })).toBeInTheDocument()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const before = listCalls(invoke).length
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search events' }), { target: { value: 'web' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(listCalls(invoke)).toHaveLength(before)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(invoke).toHaveBeenLastCalledWith('audit:list', expect.objectContaining({ text: 'web' }))
  })

  it('verify chain shows result', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'audit:list': events, 'audit:verify': { ok: true, count: 2 } })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })

    await user.click(screen.getByRole('button', { name: /Verify chain/ }))
    expect(await screen.findByText('Chain intact · 2 events')).toBeInTheDocument()

    invoke.mockImplementation(async (channel: string) =>
      channel === 'audit:verify'
        ? { ok: false, count: 5, brokenAtId: 3, reason: 'hash-mismatch' }
        : channel === 'audit:list'
          ? events
          : null,
    )
    await user.click(screen.getByRole('button', { name: /Verify chain/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Chain broken at event #3')
  })

  it('export csv', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'audit:list': events, 'audit:exportCsv': { path: '/tmp/audit.csv' } })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'failure')
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('audit:list', expect.objectContaining({ outcome: 'failure' })),
    )
    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    expect(invoke).toHaveBeenCalledWith('audit:exportCsv', { outcome: 'failure' })
    expect(await screen.findByText(/audit\.csv/)).toBeInTheDocument()
  })

  it('date filters send full ISO timestamps', async () => {
    const invoke = mockBridge({ 'audit:list': events })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-02' } })
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('audit:list', {
        from: new Date(2026, 9, 1).toISOString(),
        to: new Date(2026, 9, 2, 23, 59, 59, 999).toISOString(),
        limit: 200,
      }),
    )
  })

  it('load more pages with beforeId and hides when exhausted', async () => {
    const user = userEvent.setup()
    const page1 = Array.from({ length: 200 }, (_, i) => auditEvent({ id: 300 - i }))
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string, filter?: { beforeId?: number }) => {
      if (channel !== 'audit:list') return null
      return filter?.beforeId ? [auditEvent({ id: 5, action: 'app.quit' })] : page1
    })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('cell', { name: 'app.quit' })).toBeInTheDocument()
    expect(invoke).toHaveBeenLastCalledWith('audit:list', { limit: 200, beforeId: 101 })
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('details drawer shows JSON, closes on Esc and returns focus', async () => {
    const user = userEvent.setup()
    mockBridge({
      'audit:list': [auditEvent({ id: 7, details: { pid: 42 } }), auditEvent({ id: 6, details: { _corrupt: true, bytes: 4 } })],
    })
    renderPage()
    const rows = await screen.findAllByRole('button', { name: /Event #/ })
    rows[0].focus()
    await user.keyboard('{Enter}')
    const drawer = await screen.findByRole('dialog', { name: /Event #7/ })
    expect(drawer).toHaveTextContent('"pid": 42')
    expect(drawer).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(rows[0]).toHaveFocus()

    await user.click(rows[1])
    expect(await screen.findByRole('dialog', { name: /Event #6/ })).toHaveTextContent('"_corrupt": true')
  })

  it('cancelled export shows no error', async () => {
    const user = userEvent.setup()
    mockBridge({ 'audit:list': events, 'audit:exportCsv': null })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })
    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('audit page refresh', () => {
  it('re-lists after verify and after a completed export, not after a cancelled one', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'audit:list': events, 'audit:verify': { ok: true, count: 2 }, 'audit:exportCsv': null })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })
    expect(listCalls(invoke)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /Verify chain/ }))
    await waitFor(() => expect(listCalls(invoke)).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Export CSV/ })).not.toHaveAttribute('aria-busy'))
    expect(listCalls(invoke)).toHaveLength(2)

    invoke.mockImplementation(async (channel: string) =>
      channel === 'audit:exportCsv' ? { path: '/tmp/a.csv' } : channel === 'audit:list' ? events : null,
    )
    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(listCalls(invoke)).toHaveLength(3))
  })

  it('a failed refresh with rows on screen shows an error toast', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'audit:list': events })
    renderPage()
    await screen.findByRole('cell', { name: 'audit.verify' })

    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'audit:list') throw new Error('database is locked')
      return null
    })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'denied')
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't refresh events")
  })

  it('load more is disabled while a refresh is in flight', async () => {
    const user = userEvent.setup()
    const page1 = Array.from({ length: 200 }, (_, i) => auditEvent({ id: 300 - i }))
    const invoke = mockBridge({ 'audit:list': page1 })
    renderPage()
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeEnabled()

    invoke.mockImplementation((channel: string) =>
      channel === 'audit:list' ? new Promise(() => {}) : Promise.resolve(null),
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'denied')
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled()
  })
})
