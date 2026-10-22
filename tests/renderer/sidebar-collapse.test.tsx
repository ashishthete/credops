import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/renderer/src/shell/Sidebar'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { mockBridge } from './helpers'

const KEY = 'opsdeck.sidebar-collapsed'

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/hosts']}>
      <Sidebar />
    </MemoryRouter>,
  )
}
const aside = () => document.querySelector('aside') as HTMLElement
const nav = () => screen.getByRole('navigation', { name: 'Sections' })

describe('collapsible sidebar', () => {
  beforeEach(() => {
    mockBridge()
    localStorage.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts expanded with visible labels', () => {
    renderSidebar()
    expect(aside()).not.toHaveAttribute('data-collapsed')
    expect(within(nav()).getByText('Hosts')).toBeInTheDocument()
  })

  it('toggles from the header button, hiding labels but keeping aria-labels and the active highlight', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(aside()).toHaveAttribute('data-collapsed')
    expect(within(nav()).queryByText('Hosts')).not.toBeInTheDocument()
    const hosts = within(nav()).getByRole('link', { name: 'Hosts' })
    expect(hosts).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lock vaults' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    expect(screen.queryByText('Search…')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(aside()).not.toHaveAttribute('data-collapsed')
    expect(within(nav()).getByText('Hosts')).toBeInTheDocument()
  })

  it('toggles with mod+\\ and from the palette command', () => {
    renderSidebar()
    act(() => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true })
    })
    expect(aside()).toHaveAttribute('data-collapsed')
    const cmd = commandStore.get().find((c) => c.id === 'sidebar.toggle')
    expect(cmd?.title).toBe('Toggle sidebar')
    act(() => cmd?.run())
    expect(aside()).not.toHaveAttribute('data-collapsed')
  })

  it('persists the state and restores it', () => {
    const first = renderSidebar()
    act(() => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true })
    })
    expect(localStorage.getItem(KEY)).toBe('1')
    first.unmount()
    renderSidebar()
    expect(aside()).toHaveAttribute('data-collapsed')
  })

  it('survives localStorage throwing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const user = userEvent.setup()
    renderSidebar()
    expect(aside()).not.toHaveAttribute('data-collapsed')
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(aside()).toHaveAttribute('data-collapsed')
  })
})
