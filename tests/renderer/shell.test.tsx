import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { SECTIONS, sectionShortcut, type SectionId } from '../../src/renderer/src/shell/sections'
import { commandStore } from '../../src/renderer/src/ui/commands'
import type { RunSummary } from '../../src/shared/ops'
import { mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

// Shortcuts follow SECTIONS order, so a section inserted later shifts these without a rewrite.
const digitOf = (id: SectionId) => String(SECTIONS.findIndex((s) => s.id === id) + 1)
const shortcutOf = (id: SectionId) => `mod+${digitOf(id)}`

const runSummary: RunSummary = {
  id: 'r1',
  state: 'running',
  title: 'uptime',
  environmentId: null,
  environmentName: null,
  concurrency: 4,
  hosts: [],
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  outputDropped: false,
}

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
      fireEvent.keyDown(window, { key: '2', metaKey: true })
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

  it(`${shortcutOf('audit')} jumps to Audit`, async () => {
    renderShell()
    expect(SECTIONS.at(-1)!.id).toBe('audit')
    act(() => {
      fireEvent.keyDown(window, { key: digitOf('audit'), metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeInTheDocument()
  })

  // With an empty inventory the page shows its empty state, never the React Flow canvas, so this
  // suite needs none of the map tests' DOM stubs.
  it(`${shortcutOf('map')} opens Map`, async () => {
    renderShell()
    act(() => {
      fireEvent.keyDown(window, { key: digitOf('map'), metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Map', level: 1 })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: /Map/ })).toHaveAttribute('aria-current', 'page')
  })

  // The spec fixes Map at mod+5; the computed test above is what survives sections moving.
  it('mod+5 opens Map', async () => {
    renderShell()
    act(() => {
      fireEvent.keyDown(window, { key: '5', metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Map', level: 1 })).toBeInTheDocument()
  })

  it('placeholder pages name their phase', async () => {
    renderShell('/deployments')
    expect(await screen.findByText('Coming in phase 8')).toBeInTheDocument()
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

  it('the Ops section is in the sidebar with its shortcut and badge', async () => {
    mockBridge({ 'runs:list': [runSummary] })
    renderShell()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: /Ops/ })).toBeInTheDocument()
    expect(await screen.findByLabelText('1 run running')).toHaveTextContent('1')
    const i = SECTIONS.findIndex((s) => s.id === 'ops')
    act(() => {
      fireEvent.keyDown(window, { key: String(i + 1), metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Ops/ })).toHaveAttribute('aria-current', 'page')
  })

  it('/ops redirects to /ops/run', async () => {
    renderShell('/ops')
    expect(await screen.findByRole('link', { name: 'Run', current: 'page' })).toBeInTheDocument()
  })

  it('sections are palette commands while mounted', async () => {
    const { unmount } = renderShell()
    await screen.findByText(/tester@mac/)
    const nav = commandStore.get().filter((c) => c.section === 'Navigate')
    expect(nav.map((c) => c.shortcut)).toEqual(SECTIONS.map((_, i) => `mod+${i + 1}`))
    expect(nav.find((c) => c.id === 'nav.map')).toMatchObject({ title: 'Go to Map', shortcut: shortcutOf('map') })
    unmount()
    expect(commandStore.get().filter((c) => c.section === 'Navigate')).toHaveLength(0)
  })

  it('shows the actor at the bottom of the sidebar', async () => {
    renderShell()
    expect(await screen.findByText('tester@mac')).toBeInTheDocument()
  })
})
