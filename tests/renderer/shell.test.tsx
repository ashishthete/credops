import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { SECTIONS } from '../../src/renderer/src/shell/sections'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

function renderShell(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  )
}

describe('shell', () => {
  beforeEach(() => {
    mockBridge()
  })

  it('shell renders all sections and navigates', async () => {
    const user = userEvent.setup()
    renderShell()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(SECTIONS.map((s) => expect.stringContaining(s.label)))
    // `/` redirects to the first section.
    expect(within(nav).getByRole('link', { name: /Products/ })).toHaveAttribute('aria-current', 'page')

    await user.click(within(nav).getByRole('link', { name: /Audit/ }))
    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Audit/ })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: /Products/ })).not.toHaveAttribute('aria-current')
  })

  it('vaults is a real page, not a placeholder', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: /Vaults/ }))
    expect(await screen.findByRole('heading', { name: 'Vaults', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Coming in phase 2')).not.toBeInTheDocument()
  })

  it('mod+1 lands on Products', async () => {
    renderShell('/audit')
    act(() => {
      fireEvent.keyDown(window, { key: '1', metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Coming in phase 3')).not.toBeInTheDocument()
  })

  it('Hosts no longer shows a placeholder', async () => {
    renderShell()
    act(() => {
      fireEvent.keyDown(window, { key: '3', metaKey: true })
    })
    // The page swaps its loading layout for the empty one once host:list lands, remounting the
    // heading; wait for that so the assertion never holds a detached node.
    expect(await screen.findByText('No hosts yet')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Coming in phase 3')).not.toBeInTheDocument()
  })

  it('/environments redirects to Products', async () => {
    renderShell('/environments')
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
  })

  it('mod+7 jumps to Audit', async () => {
    renderShell()
    act(() => {
      fireEvent.keyDown(window, { key: '7', metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeInTheDocument()
  })

  it('placeholder pages name their phase', async () => {
    renderShell('/tunnels')
    expect(await screen.findByText('Coming in phase 5')).toBeInTheDocument()
  })

  it('sidebar shows up tunnels and a failed dot', async () => {
    mockBridge({
      'tunnel:list': [tunnelMeta({ id: 'a' }), tunnelMeta({ id: 'b' }), tunnelMeta({ id: 'c' })],
      'tunnel:status': [
        tunnelRuntime({ id: 'a' }),
        tunnelRuntime({ id: 'b' }),
        tunnelRuntime({ id: 'c', state: 'failed' }),
      ],
    })
    renderShell('/audit')
    const badge = await screen.findByLabelText('2 tunnels up, 1 failed')
    expect(badge).toHaveTextContent('2')
    expect(badge.querySelector('[data-dot="failed"]')).not.toBeNull()
  })

  it('sections are palette commands while mounted', async () => {
    const { unmount } = renderShell()
    await screen.findByText(/tester@mac/)
    const nav = commandStore.get().filter((c) => c.section === 'Navigate')
    expect(nav.map((c) => c.shortcut)).toEqual(['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7'])
    unmount()
    expect(commandStore.get().filter((c) => c.section === 'Navigate')).toHaveLength(0)
  })

  it('shows the actor at the bottom of the sidebar', async () => {
    renderShell()
    expect(await screen.findByText('tester@mac')).toBeInTheDocument()
  })
})
