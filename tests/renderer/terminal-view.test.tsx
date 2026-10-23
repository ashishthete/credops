import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SECTIONS } from '../../src/renderer/src/shell/sections'
import { useShortcut } from '../../src/renderer/src/ui/shortcuts'
import { disposeAll, getTerminal } from '../../src/renderer/src/terminal/registry'
import { TerminalView } from '../../src/renderer/src/terminal/TerminalView'
import { mockBridge } from './helpers'
import { fake, resetFakeXterm } from './terminal-fakes'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

let resizeCb: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  disposeAll()
  resetFakeXterm()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCb = cb
      }
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
})

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

async function mount(visible = true) {
  const invoke = mockBridge({ 'session:attach': { meta: {}, buffer: '', end: 0 } })
  const view = render(<TerminalView sessionId="s1" visible={visible} />)
  await act(async () => {})
  return { invoke, view }
}

describe('TerminalView', () => {
  it('paste over 32 KiB is chunked', async () => {
    const { invoke } = await mount()
    act(() => fake.terms[0].type('x'.repeat(70_000)))
    const writes = calls(invoke, 'session:write')
    expect(writes.map((c) => (c[2] as string).length)).toEqual([32_768, 32_768, 4_464])
    expect(writes.every((c) => c[1] === 's1')).toBe(true)
  })

  it('resize is debounced and only sent on change', async () => {
    const { invoke } = await mount()
    expect(calls(invoke, 'session:resize')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(50))
    expect(calls(invoke, 'session:resize')).toEqual([['session:resize', 's1', 100, 30]])

    fake.fitSize = { cols: 101, rows: 30 }
    act(() => resizeCb())
    fake.fitSize = { cols: 120, rows: 40 }
    act(() => resizeCb())
    act(() => vi.advanceTimersByTime(49))
    expect(calls(invoke, 'session:resize')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(calls(invoke, 'session:resize')).toHaveLength(2)
    expect(calls(invoke, 'session:resize')[1]).toEqual(['session:resize', 's1', 120, 40])

    act(() => resizeCb()) // same size again
    act(() => vi.advanceTimersByTime(100))
    expect(calls(invoke, 'session:resize')).toHaveLength(2)
  })

  it('a resize that returns to the sent size inside the debounce window sends nothing stale', async () => {
    const { invoke } = await mount()
    act(() => vi.advanceTimersByTime(50)) // 100x30 sent
    fake.fitSize = { cols: 90, rows: 30 }
    act(() => resizeCb())
    fake.fitSize = { cols: 100, rows: 30 }
    act(() => resizeCb())
    act(() => vi.advanceTimersByTime(200))
    expect(calls(invoke, 'session:resize')).toEqual([['session:resize', 's1', 100, 30]])
  })

  it('does not open a hidden terminal until first visible', async () => {
    const { view } = await mount(false)
    expect(fake.terms).toHaveLength(0)
    view.rerender(<TerminalView sessionId="s1" visible />)
    await act(async () => {})
    expect(fake.terms[0].element).toBeDefined()
  })

  it('copy on select writes to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
    await mount()
    const term = fake.terms[0]
    act(() => term.selectionListeners.forEach((l) => l()))
    expect(writeText).not.toHaveBeenCalled()
    term.getSelection.mockReturnValue('selected text')
    act(() => term.selectionListeners.forEach((l) => l()))
    expect(writeText).toHaveBeenCalledWith('selected text')
  })

  it('app combos are released by the key handler; ctrl keys stay with the terminal', async () => {
    await mount()
    const { keyHandler } = fake.terms[0]
    const key = (init: KeyboardEventInit) => keyHandler(new KeyboardEvent('keydown', init))
    expect(key({ key: 'w', metaKey: true })).toBe(false)
    expect(key({ key: 't', metaKey: true })).toBe(false)
    // Every section shortcut, mod+1 to the last, reaches the window.
    for (let i = 0; i < Math.min(SECTIONS.length, 9); i++) expect(key({ key: String(i + 1), metaKey: true }), `mod+${i + 1}`).toBe(false)
    expect(key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })).toBe(false)
    expect(key({ key: 'c', ctrlKey: true })).toBe(true)
    expect(key({ key: 'w', ctrlKey: true })).toBe(true)
    expect(key({ key: 'a' })).toBe(true)
  })

  it('no ⌘ combo reaches the shell on macOS, so ⌘⇧ arrows and ⌘⌫ never type escape codes', async () => {
    await mount()
    const { keyHandler } = fake.terms[0]
    const key = (init: KeyboardEventInit) => keyHandler(new KeyboardEvent('keydown', init))
    expect(key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, shiftKey: true })).toBe(false)
    expect(key({ key: 'Backspace', code: 'Backspace', metaKey: true })).toBe(false)
    expect(key({ key: 'Delete', code: 'Delete', metaKey: true, shiftKey: true })).toBe(false)
    expect(key({ key: 'v', metaKey: true })).toBe(false) // the paste event still reaches xterm
    expect(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true })).toBe(true)
  })

  it('mod+f opens search in the visible view even when a hidden view mounted first', async () => {
    mockBridge({ 'session:attach': { meta: {}, buffer: '', end: 0 } })
    const view = render(
      <>
        <TerminalView sessionId="s1" visible />
        <TerminalView sessionId="s2" visible={false} />
      </>,
    )
    await act(async () => {})
    view.rerender(
      <>
        <TerminalView sessionId="s1" visible={false} />
        <TerminalView sessionId="s2" visible />
      </>,
    )
    await act(async () => {})
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true })
    expect(screen.getAllByLabelText('Search terminal')).toHaveLength(1)
    expect(screen.getByTestId('terminal-s2')).toContainElement(screen.getByLabelText('Search terminal'))
  })

  it('mod+f opens search; Esc closes and refocuses', async () => {
    await mount()
    const search = getTerminal('s1').search as unknown as { findNext: ReturnType<typeof vi.fn>; findPrevious: ReturnType<typeof vi.fn> }
    fireEvent.keyDown(fake.terms[0].element!, { key: 'f', metaKey: true })
    const input = screen.getByLabelText('Search terminal')
    fake.terms[0].focus.mockClear()

    fireEvent.change(input, { target: { value: 'err' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(search.findNext).toHaveBeenLastCalledWith('err', { incremental: false })
    expect(search.findPrevious).toHaveBeenCalledWith('err')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(fake.terms[0].focus).toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.queryByLabelText('Search terminal')).toBeNull()
  })

})
