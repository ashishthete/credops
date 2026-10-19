import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette, closeCommandPalette, registerCommand } from '../../src/renderer/src/ui/CommandPalette'
import { getRecents, resetRecents } from '../../src/renderer/src/ui/commands'
import { Sparkline, sparkPoints } from '../../src/renderer/src/ui/Sparkline'
import { Switch } from '../../src/renderer/src/ui/Switch'
import { Toaster, clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import { useShortcut } from '../../src/renderer/src/ui/shortcuts'

const pressModK = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })

// Recents live at module level; one test's palette runs must not reorder the next one's list.
afterEach(() => resetRecents())

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

describe('palette polish', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    act(() => closeCommandPalette())
    cleanups.splice(0).forEach((fn) => fn())
  })

  it('Enter that confirms an IME candidate does not run a command', async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    cleanups.push(registerCommand({ id: 'go-audit', title: 'Go to Audit', section: 'Navigate', run }))
    render(<CommandPalette />)
    act(() => {
      pressModK()
    })
    const input = await screen.findByRole('combobox')
    await user.type(input, 'aud')

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })

    expect(run).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('holding mod+k does not flicker the palette', async () => {
    render(<CommandPalette />)
    act(() => {
      pressModK()
      fireEvent.keyDown(window, { key: 'k', metaKey: true, repeat: true })
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('Tab keeps focus inside the palette so Esc still closes it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button>behind</button>
        <CommandPalette />
      </>,
    )
    act(() => {
      pressModK()
    })
    const input = await screen.findByRole('combobox')
    await user.tab()
    expect(input).toHaveFocus()
    await user.tab({ shift: true })
    expect(input).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('unregistered commands drop out of recents', async () => {
    const user = userEvent.setup()
    const unregisterA = registerCommand({ id: 'a', title: 'Alpha', section: 'Navigate', run: vi.fn() })
    cleanups.push(registerCommand({ id: 'b', title: 'Bravo', section: 'Navigate', run: vi.fn() }))
    render(<CommandPalette />)

    for (const name of [/Alpha/, /Bravo/]) {
      act(() => {
        pressModK()
      })
      await user.click(await screen.findByRole('option', { name }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      if (name.source === 'Alpha') unregisterA()
    }

    expect(getRecents()).toContain('b')
    expect(getRecents()).not.toContain('a')
  })
})

describe('toasts', () => {
  // Fake only the toast clock. Faking requestAnimationFrame too would strand framer-motion's
  // frameloop whenever a test switches clocks mid-animation.
  const useToastClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const elapse = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  afterEach(() => {
    vi.useRealTimers()
    act(() => clearToasts())
  })

  it('toasts stack and cap at 4', () => {
    render(<Toaster />)
    act(() => {
      for (let i = 1; i <= 6; i++) toast({ title: `Toast ${i}` })
    })
    expect(screen.getAllByRole('status')).toHaveLength(4)
  })

  it('error toasts persist', async () => {
    useToastClock()
    render(<Toaster />)
    act(() => {
      toast({ title: 'Deploy failed', tone: 'error' })
      toast({ title: 'Saved', tone: 'info' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Deploy failed')
    expect(screen.getByText('Saved')).toBeInTheDocument()

    await elapse(6000)
    vi.useRealTimers()

    expect(screen.getByText('Deploy failed')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Saved')).not.toBeInTheDocument())
  })

  it('focus inside a toast pauses its timer', async () => {
    useToastClock()
    render(<Toaster />)
    act(() => {
      toast({ title: 'Saved' })
    })
    const dismiss = screen.getByRole('button', { name: 'Dismiss notification' })
    act(() => dismiss.focus())

    await elapse(6000)
    // Give a dismissed toast real frames to finish exiting before checking it stayed.
    vi.useRealTimers()
    await act(() => new Promise((r) => setTimeout(r, 400)))
    expect(screen.getByText('Saved')).toBeInTheDocument()

    useToastClock()
    act(() => dismiss.blur())
    await elapse(6000)
    vi.useRealTimers()
    await waitFor(() => expect(screen.queryByText('Saved')).not.toBeInTheDocument())
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

  it('mod+w from inside .xterm reaches the shortcut handler; ctrl+c does not', () => {
    const onW = vi.fn()
    function Term() {
      useShortcut('mod+w', onW)
      return (
        <div className="xterm">
          <textarea aria-label="xterm input" />
        </div>
      )
    }
    render(<Term />)
    const area = screen.getByLabelText('xterm input')
    area.focus()

    fireEvent.keyDown(area, { key: 'c', ctrlKey: true })
    expect(onW).not.toHaveBeenCalled()
    fireEvent.keyDown(area, { key: 'w', metaKey: true })
    expect(onW).toHaveBeenCalledOnce()
  })
})

describe('Switch', () => {
  function Harness({ busy = false }: { busy?: boolean }) {
    const [on, setOn] = useState(false)
    return <Switch checked={on} onChange={setOn} label="Auto-start" busy={busy} />
  }

  it('Switch toggles with click and Space and exposes aria-checked', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const sw = screen.getByRole('switch', { name: 'Auto-start' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    sw.focus()
    await user.keyboard(' ')
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('a busy Switch ignores clicks', async () => {
    const user = userEvent.setup()
    render(<Harness busy />)
    const sw = screen.getByRole('switch')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveAttribute('aria-busy', 'true')
  })
})

describe('Sparkline', () => {
  it('Sparkline scales points', () => {
    expect(sparkPoints([0, 5, 10], 10)).toBe('0,24 50,12 100,0')
    const { container } = render(<Sparkline values={[0, 5, 10]} max={10} tone="success" label="Inbound" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('polyline')).toHaveAttribute('points', '0,24 50,12 100,0')
    expect(screen.getByText('Inbound')).toBeInTheDocument()
  })

  it('Sparkline all-zero is flat', () => {
    expect(sparkPoints([0, 0, 0])).toBe('0,24 50,24 100,24')
    const { container } = render(<Sparkline values={[0, 0]} tone="info" label="Idle" />)
    expect(container.querySelector('polyline')).toHaveAttribute('points', '0,24 100,24')
  })
})
