import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputPane, MAX_SPANS } from '../../src/renderer/src/ops/OutputPane'
import { appendOutput, type HostOutput } from '../../src/renderer/src/ops/runs'
import { RUN_OUTPUT_CHARS } from '../../src/shared/ops'

vi.mock('../../src/renderer/src/ui/Toaster', () => ({ toast: vi.fn(() => 'toast-1') }))

afterEach(() => {
  vi.restoreAllMocks()
})

/** jsdom has no layout: give the log a fixed viewport and a content height, and let scrollTop be set. */
function fakeLayout(el: HTMLElement, height = { scroll: 1000, client: 200 }) {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height.scroll })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height.client })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) })
  return height
}

const chunks = (log: HTMLElement) => log.querySelectorAll('[data-chunk]')

describe('OutputPane', () => {
  it('appends chunks, tints stderr, sticks to the bottom and offers Jump to live after a scroll up', async () => {
    let out: HostOutput = appendOutput(undefined, 'hello\n', false)
    const { rerender } = render(<OutputPane output={out} label="db-1" />)
    const log = screen.getByRole('log', { name: 'Output of db-1' })
    const height = fakeLayout(log)
    expect(log).toHaveTextContent('hello')
    const first = chunks(log)[0]

    out = appendOutput(out, 'boom\n', true)
    rerender(<OutputPane output={out} label="db-1" />)
    // The earlier text is the same node: appended, never re-rendered.
    expect(chunks(log)[0]).toBe(first)
    expect(chunks(log)).toHaveLength(2)
    const err = log.querySelector('[data-stream="err"]')
    expect(err).toHaveTextContent('boom')
    expect(err).toHaveClass('text-err')
    expect(log.textContent).toBe('hello\nboom\n')
    // Stuck to the bottom while live.
    expect(log.scrollTop).toBe(1000)

    // The user scrolls up: new text no longer moves the view, and a pill offers the way back.
    log.scrollTop = 300
    fireEvent.scroll(log)
    height.scroll = 1400
    out = appendOutput(out, 'more\n', false)
    rerender(<OutputPane output={out} label="db-1" />)
    expect(log.scrollTop).toBe(300)
    const jump = screen.getByRole('button', { name: 'Jump to live' })

    fireEvent.click(jump)
    expect(log.scrollTop).toBe(1400)
    fireEvent.scroll(log)
    // The pill fades out.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jump to live' })).not.toBeInTheDocument())
  })

  it('copies the host output without a toast', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { toast } = await import('../../src/renderer/src/ui/Toaster')
    const out = appendOutput(appendOutput(undefined, 'a\n', false), 'b\n', true)
    render(<OutputPane output={out} label="db-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy output of db-1' }))
    })
    expect(writeText).toHaveBeenCalledWith('a\nb\n')
    expect(toast).not.toHaveBeenCalled()
  })

  it(`keeps at most ${MAX_SPANS} chunk spans and the store's char cap, merging the oldest`, () => {
    let out: HostOutput | undefined
    const { rerender, container } = render(<OutputPane output={out} label="web-1" />)
    for (let i = 0; i < MAX_SPANS + 300; i++) {
      out = appendOutput(out, `line ${i}\n`, i % 2 === 1)
      rerender(<OutputPane output={out} label="web-1" />)
    }
    const log = screen.getByRole('log', { name: 'Output of web-1' })
    expect(chunks(log).length).toBeLessThanOrEqual(MAX_SPANS)
    expect(log.textContent).toBe(out!.text)
    // Merged spans keep their stderr tint.
    expect(log.querySelector('[data-stream="err"]')).toHaveTextContent('line 1')
    expect(container.querySelectorAll('[data-stream="err"]').length).toBe(MAX_SPANS / 2 + 150)

    // A chunk bigger than the cap leaves only the newest RUN_OUTPUT_CHARS.
    out = appendOutput(out, 'x'.repeat(RUN_OUTPUT_CHARS) + 'tail', false)
    rerender(<OutputPane output={out} label="web-1" />)
    expect(log.textContent!.length).toBe(RUN_OUTPUT_CHARS)
    expect(log.textContent!.endsWith('xtail')).toBe(true)
  })

  it('rebuilds from the snapshot when the output is replaced or cleared', () => {
    const out = appendOutput(appendOutput(undefined, 'one\n', false), 'two\n', false)
    const { rerender } = render(<OutputPane output={out} label="db-1" />)
    const log = screen.getByRole('log', { name: 'Output of db-1' })
    // A reload that comes back shorter (a new run selected, or a reset) starts over.
    rerender(<OutputPane output={appendOutput(undefined, 'fresh\n', true)} label="db-1" />)
    expect(log.textContent).toBe('fresh\n')
    expect(log.querySelector('[data-stream="err"]')).toHaveTextContent('fresh')
    rerender(<OutputPane output={undefined} label="db-1" />)
    expect(screen.getByText('No output yet')).toBeInTheDocument()
  })
})
