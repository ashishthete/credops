import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette, closeCommandPalette, registerCommand } from '../../src/renderer/src/ui/CommandPalette'
import { Toaster, clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import { useShortcut } from '../../src/renderer/src/ui/shortcuts'

const pressModK = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })

describe('command palette', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    act(() => closeCommandPalette())
    cleanups.splice(0).forEach((fn) => fn())
  })

  it('command palette opens with mod+k and runs a command', async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    cleanups.push(registerCommand({ id: 'go-audit', title: 'Go to Audit', section: 'Navigate', run }))
    render(<CommandPalette />)

    act(() => {
      pressModK()
    })
    const input = await screen.findByRole('combobox')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(input).toHaveFocus()

    await user.type(input, 'aud')
    expect(screen.getByRole('option', { name: /Go to Audit/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')

    expect(run).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('palette ignores unregistered', async () => {
    const user = userEvent.setup()
    const unregister = registerCommand({ id: 'go-audit', title: 'Go to Audit', section: 'Navigate', run: vi.fn() })
    render(<CommandPalette />)
    unregister()

    act(() => {
      pressModK()
    })
    await user.type(await screen.findByRole('combobox'), 'aud')

    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('closes on Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button>before</button>
        <CommandPalette />
      </>,
    )
    const before = screen.getByRole('button', { name: 'before' })
    before.focus()
    act(() => {
      pressModK()
    })
    expect(await screen.findByRole('combobox')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(before).toHaveFocus()
  })

  it('arrow keys wrap and recent commands come first', async () => {
    const user = userEvent.setup()
    const runB = vi.fn()
    cleanups.push(
      registerCommand({ id: 'a', title: 'Alpha', section: 'Navigate', run: vi.fn() }),
      registerCommand({ id: 'b', title: 'Bravo', section: 'Navigate', run: runB }),
    )
    render(<CommandPalette />)

    act(() => {
      pressModK()
    })
    await screen.findByRole('combobox')
    // Up from the first option wraps to the last one.
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { name: /Bravo/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(runB).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    act(() => {
      pressModK()
    })
    await screen.findByRole('combobox')
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    expect(names[0]).toMatch(/Bravo/)
  })
})

describe('toasts', () => {
  afterEach(() => {
    act(() => clearToasts())
    vi.useRealTimers()
  })

  it('toasts stack and cap at 4', () => {
    render(<Toaster />)
    act(() => {
      for (let i = 1; i <= 6; i++) toast({ title: `Toast ${i}` })
    })
    expect(screen.getAllByRole('status')).toHaveLength(4)
  })

  it('error toasts persist', async () => {
    vi.useFakeTimers()
    render(<Toaster />)
    act(() => {
      toast({ title: 'Deploy failed', tone: 'error' })
      toast({ title: 'Saved', tone: 'info' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Deploy failed')
    expect(screen.getByText('Saved')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(screen.getByText('Deploy failed')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})

function ShortcutProbe({ onOne, onK }: { onOne: () => void; onK: () => void }) {
  useShortcut('mod+1', onOne)
  useShortcut('mod+k', onK)
  return <input aria-label="field" />
}

describe('shortcuts', () => {
  it('shortcuts ignore inputs', () => {
    const onOne = vi.fn()
    const onK = vi.fn()
    render(<ShortcutProbe onOne={onOne} onK={onK} />)
    const input = screen.getByLabelText('field')
    input.focus()

    fireEvent.keyDown(input, { key: '1', metaKey: true })
    fireEvent.keyDown(input, { key: 'k', metaKey: true })

    expect(onOne).not.toHaveBeenCalled()
    expect(onK).toHaveBeenCalledOnce()

    fireEvent.keyDown(document.body, { key: '1', metaKey: true })
    expect(onOne).toHaveBeenCalledOnce()
  })
})
