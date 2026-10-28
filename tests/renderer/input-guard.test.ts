import { describe, expect, it } from 'vitest'
import { cursorLine, inFullScreenApp, isDestructive, LineTracker } from '../../src/renderer/src/terminal/inputGuard'

const typed = (...data: string[]) => {
  const t = new LineTracker()
  data.forEach((d) => t.feed(d))
  return t
}

/** A fake xterm buffer: one row per string, `wrapped` rows continuing the one above. */
function screen(rows: (string | { text: string; wrapped: true })[], type: 'normal' | 'alternate' = 'normal') {
  const lines = rows.map((r) => (typeof r === 'string' ? { text: r, wrapped: false } : { text: r.text, wrapped: true }))
  return {
    buffer: {
      active: {
        type,
        baseY: 0,
        cursorY: lines.length - 1,
        getLine: (y: number) =>
          lines[y] && { isWrapped: lines[y].wrapped, translateToString: (trim?: boolean) => (trim ? lines[y].text.trimEnd() : lines[y].text) },
      },
    },
  } as never
}

describe('LineTracker', () => {
  it('follows typing, backspace and Ctrl-W', () => {
    expect(typed('rm -rf /tmp/x').text).toBe('rm -rf /tmp/x')
    expect(typed('rmx', '\x7f', ' -r').text).toBe('rm -r')
    expect(typed('héé', '\x7f\b').text).toBe('h')
    expect(typed('ls -la  /var  ', '\x17').text).toBe('ls -la  ')
    expect(typed('ls', '\x7f\x7f\x7f').text).toBe('')
  })

  it('Enter, Ctrl-C and Ctrl-U start a new line', () => {
    expect(typed('rm x\rls').text).toBe('ls')
    expect(typed('rm x\r\nls').text).toBe('ls')
    expect(typed('rm x', '\x03', 'ls').text).toBe('ls')
    expect(typed('rm x', '\x15').text).toBe('')
  })

  it('cursor keys, history and Tab make it uncertain until the next Enter or Ctrl-C', () => {
    const t = typed('ls', '\x1b[A')
    expect(t.uncertain).toBe(true)
    expect(t.text).toBe('ls')
    t.feed('\x1b[1;5D\x1bOA\x1bb')
    expect(t.text).toBe('ls')
    t.feed('\r')
    expect(t.uncertain).toBe(false)
    expect(typed('rm\t').uncertain).toBe(true)
    expect(typed('rm\t', '\x03').uncertain).toBe(false)
  })

  it('bracketed paste markers are skipped and a line break inside is text, not Enter', () => {
    const t = typed('\x1b[200~echo a\rrm -rf b\x1b[201~')
    expect(t.text).toBe('echo a\nrm -rf b')
    expect(t.uncertain).toBe(false)
  })

  it('stop holds an Enter and reports where it is, keeping the line', () => {
    const t = new LineTracker()
    const seen: string[] = []
    const at = t.feed('ls\rrm -rf /\rmore', (line) => (seen.push(line), isDestructive(line)))
    expect(at).toBe(11)
    expect(seen).toEqual(['ls', 'rm -rf /'])
    expect(t.text).toBe('rm -rf /')
    expect(t.feed('\r')).toBe(-1)
    expect(t.text).toBe('')
  })
})

describe('screen helpers', () => {
  it('cursorLine joins soft-wrapped rows and includes the prompt', () => {
    expect(cursorLine(screen(['old output', '$ sudo systemctl ', { text: 'restart nginx   ', wrapped: true }]))).toBe('$ sudo systemctl restart nginx')
    expect(cursorLine({ buffer: undefined } as never)).toBe('')
  })

  it('a full-screen program is on the alternate buffer', () => {
    expect(inFullScreenApp(screen([''], 'alternate'))).toBe(true)
    expect(inFullScreenApp(screen(['']))).toBe(false)
    expect(inFullScreenApp({} as never)).toBe(false)
  })
})
