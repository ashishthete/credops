import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { preloadPages } from '../../src/renderer/src/shell/pages'
import { mockBridge, product } from './helpers'

// setup.ts swaps in eager pages for every other suite; this one keeps the real lazy ones.
vi.unmock('../../src/renderer/src/shell/pages')

function renderShell(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  )
}

describe('lazy pages', () => {
  beforeEach(() => {
    mockBridge()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a lazy page opened directly draws once its code has loaded', async () => {
    renderShell('/audit')
    // Suspended: nothing of the page until its chunk resolves.
    expect(screen.queryByRole('heading', { name: 'Audit trail' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Audit trail' })).toBeInTheDocument()
    // The shell around it never waited.
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
  })

  it('navigating from an eager page to lazy ones loads each', async () => {
    mockBridge({ 'product:list': [product({ id: 'p1', name: 'Acme' })] })
    const user = userEvent.setup()
    renderShell('/products')
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    await user.click(within(nav).getByRole('link', { name: /Vaults/ }))
    expect(await screen.findByRole('heading', { name: 'Vaults', level: 1 })).toBeInTheDocument()
    await user.click(within(nav).getByRole('link', { name: /Ops/ }))
    expect(await screen.findByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument()
    await user.click(within(nav).getByRole('link', { name: /Deployments/ }))
    expect(await screen.findByRole('heading', { name: 'Deployments', level: 1 })).toBeInTheDocument()
  })

  it('preloading waits for the app to go idle, and cancels with the shell', async () => {
    vi.useFakeTimers()
    const idle = vi.fn((cb: () => void) => setTimeout(cb, 50) as unknown as number)
    const cancel = vi.fn((id: number) => clearTimeout(id))
    vi.stubGlobal('requestIdleCallback', idle)
    vi.stubGlobal('cancelIdleCallback', cancel)
    try {
      const stop = preloadPages()
      expect(idle).toHaveBeenCalledTimes(1)
      stop()
      expect(cancel).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
