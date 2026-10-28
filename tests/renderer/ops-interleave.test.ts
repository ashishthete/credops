import { describe, expect, it } from 'vitest'
import { NO_MERGE, interleave, type Merged } from '../../src/renderer/src/ops/interleave'
import { appendOutput, type HostOutput } from '../../src/renderer/src/ops/runs'
import type { RunHostMeta, RunHostState } from '../../src/shared/ops'

const host = (hostId: string, state: RunHostState = 'running'): RunHostMeta => ({
  hostId,
  label: hostId,
  state,
  exitCode: null,
  signal: null,
  error: null,
  startedAt: null,
  endedAt: null,
  truncated: false,
})

/** The tinted text of a merged stream. */
const errText = (out: HostOutput | undefined) => (out?.errRanges ?? []).map(([a, b]) => out!.text.slice(a, b)).join('')

describe('interleave', () => {
  it('writes whole lines under their host label, in the order they arrive, keeping the stderr tint', () => {
    let a = appendOutput(undefined, 'a1\n', false)
    let b: HostOutput | undefined
    const hosts = [host('a'), host('b')]
    let m: Merged = interleave(NO_MERGE, 'r1', { a }, hosts)
    b = appendOutput(undefined, 'b1\n', true)
    m = interleave(m, 'r1', { a, b }, hosts)
    a = appendOutput(a, 'a2\n', false)
    m = interleave(m, 'r1', { a, b }, hosts)
    expect(m.out?.text).toBe('a │ a1\nb │ b1\na │ a2\n')
    // The label is never tinted; the stderr line is.
    expect(errText(m.out)).toBe('b1\n')
  })

  it("ends a line that set a colour with a reset, so it never runs on into the next host's line", () => {
    const hosts = [host('a'), host('b')]
    const a = appendOutput(undefined, '\u001b[31mred, never reset\n', false)
    const b = appendOutput(undefined, 'plain\n', false)
    const m = interleave(NO_MERGE, 'r1', { a, b }, hosts)
    expect(m.out?.text).toBe('a │ \u001b[31mred, never reset\n\u001b[0mb │ plain\n')
  })

  it('holds a partial line until its newline arrives', () => {
    const hosts = [host('a')]
    let a = appendOutput(undefined, 'hel', false)
    let m = interleave(NO_MERGE, 'r1', { a }, hosts)
    expect(m.out).toBeUndefined()
    a = appendOutput(a, 'lo\nwor', false)
    m = interleave(m, 'r1', { a }, hosts)
    expect(m.out?.text).toBe('a │ hello\n')
    a = appendOutput(a, 'ld\n', false)
    m = interleave(m, 'r1', { a }, hosts)
    expect(m.out?.text).toBe('a │ hello\na │ world\n')
  })

  it("flushes a finished host's last line, which has no newline coming", () => {
    const a = appendOutput(undefined, 'done', true)
    let m = interleave(NO_MERGE, 'r1', { a }, [host('a')])
    expect(m.out).toBeUndefined()
    m = interleave(m, 'r1', { a }, [host('a', 'failed')])
    expect(m.out?.text).toBe('a │ done\n')
    expect(errText(m.out)).toBe('done')
    // Only once.
    m = interleave(m, 'r1', { a }, [host('a', 'failed')])
    expect(m.out?.text).toBe('a │ done\n')
  })

  it('a queued host holds its partial line; only a finished one is flushed', () => {
    const a = appendOutput(undefined, 'partial', false)
    const m = interleave(NO_MERGE, 'r1', { a }, [host('a', 'queued')])
    expect(m.out).toBeUndefined()
    expect(m.cursors.a.line).toEqual([['partial', false]])
  })

  it('output after a flush starts a new labelled line', () => {
    let a = appendOutput(undefined, 'done', false)
    let m = interleave(NO_MERGE, 'r1', { a }, [host('a', 'ok')])
    expect(m.out?.text).toBe('a │ done\n')
    a = appendOutput(a, ' late\n', false)
    m = interleave(m, 'r1', { a }, [host('a', 'ok')])
    expect(m.out?.text).toBe('a │ done\na │  late\n')
  })

  it('a host whose output went back (a reload) is read again from its text', () => {
    const hosts = [host('a')]
    let m = interleave(NO_MERGE, 'r1', { a: appendOutput(undefined, 'one\ntwo\n', false) }, hosts)
    // A shorter snapshot replaces what was seen; its text is read again from the start.
    m = interleave(m, 'r1', { a: appendOutput(undefined, 'fresh\n', false) }, hosts)
    expect(m.out?.text).toBe('a │ one\na │ two\na │ fresh\n')
    // So is output that skipped past what the text still holds.
    const skipped: HostOutput = { text: 'tail\n', errRanges: [], total: 500 }
    m = interleave(m, 'r1', { a: skipped }, hosts)
    expect(m.out?.text.endsWith('a │ fresh\na │ tail\n')).toBe(true)
  })

  it('another run starts over', () => {
    const m = interleave(NO_MERGE, 'r1', { a: appendOutput(undefined, 'x\n', false) }, [host('a')])
    const next = interleave(m, 'r2', { a: appendOutput(undefined, 'y\n', false) }, [host('a')])
    expect(next.out?.text).toBe('a │ y\n')
  })
})
