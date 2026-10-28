import type { Terminal } from '@xterm/xterm'
import { DESTRUCTIVE_PATTERN } from '../../../shared/ops'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * A best-effort copy of the line being typed into a terminal, kept from what xterm sends (`onData`), so a
 * protected session can ask before Enter runs a destructive command.
 *
 * It only sees keystrokes, never the shell, so it is a guess:
 * - Printable text appends; Backspace drops the last character; Ctrl-W drops the last word; Enter, Ctrl-C
 *   and Ctrl-U start a new line. Bracketed paste markers are skipped and a line break inside one is text.
 * - Cursor keys, history (↑, Ctrl-R), Tab completion, Alt combos and other control keys change the line in
 *   ways it can't follow; after one the line is `uncertain` until the next Enter or Ctrl-C, and the caller
 *   should also check what the screen shows (`cursorLine`).
 * - The shell can still edit or replace the line by itself (aliases, `!!` expansion, completion menus, a
 *   key binding), an escape sequence split across two writes is not recognised, and the screen line
 *   includes the prompt, so the fallback can catch a word printed there. It is a speed bump, not a policy:
 *   anything that matters belongs in Ops › Run, which checks the rendered command.
 */
export class LineTracker {
  private line = ''
  private unsure = false
  private pasting = false

  /** The line as typed since the last Enter. */
  get text(): string {
    return this.line
  }

  /** Something the tracker can't follow happened since the last Enter. */
  get uncertain(): boolean {
    return this.unsure
  }

  reset(): void {
    this.line = ''
    this.unsure = false
  }

  /**
   * Follows `data`. Before each Enter, `stop` may hold it: feeding stops there, the line is kept, and the
   * index of that Enter is returned so the caller can send the input before it. Returns -1 when all of
   * `data` was taken.
   */
  feed(data: string, stop?: (line: string, uncertain: boolean) => boolean): number {
    for (let i = 0; i < data.length; ) {
      if (data.startsWith(PASTE_START, i)) {
        this.pasting = true
        i += PASTE_START.length
        continue
      }
      if (data.startsWith(PASTE_END, i)) {
        this.pasting = false
        i += PASTE_END.length
        continue
      }
      const ch = data[i]
      if (ch === '\x1b') {
        this.unsure = true
        i += escapeLength(data, i)
        continue
      }
      if (ch === '\r' || ch === '\n') {
        if (this.pasting) {
          this.line += '\n'
        } else {
          if (stop?.(this.line, this.unsure)) return i
          this.reset()
          // A CR LF pair is one Enter.
          if (ch === '\r' && data[i + 1] === '\n') i++
        }
        i++
        continue
      }
      if (ch === '\x03' || ch === '\x15') this.reset()
      else if (ch === '\x7f' || ch === '\b') this.line = Array.from(this.line).slice(0, -1).join('')
      else if (ch === '\x17') this.line = this.line.replace(/\S*\s*$/, '')
      else if (ch < ' ') this.unsure = true
      else this.line += ch
      i++
    }
    return -1
  }
}

/** How many characters the escape sequence at `i` takes: CSI and SS3 to their final byte, else ESC and one key. */
function escapeLength(data: string, i: number): number {
  const next = data[i + 1]
  if (next === '[') {
    let j = i + 2
    while (j < data.length && !/[@-~]/.test(data[j])) j++
    return Math.min(j + 1, data.length) - i
  }
  if (next === 'O') return Math.min(3, data.length - i)
  return next === undefined ? 1 : 2
}

/** The line under the cursor as the screen shows it, joined across soft wraps; the prompt included. */
export function cursorLine(term: Pick<Terminal, 'buffer'>): string {
  const buf = term.buffer?.active
  if (!buf) return ''
  let y = buf.baseY + buf.cursorY
  const rows: string[] = []
  let line = buf.getLine(y)
  while (line) {
    // Rows above the cursor's are full width: a space at a wrap is part of the line.
    rows.unshift(line.translateToString(rows.length === 0))
    if (!line.isWrapped || y === 0) break
    line = buf.getLine(--y)
  }
  return rows.join('')
}

/** Full-screen programs (vim, less, top) draw on the alternate buffer; what is typed there is not a shell line. */
export function inFullScreenApp(term: Pick<Terminal, 'buffer'>): boolean {
  return term.buffer?.active?.type === 'alternate'
}

export const isDestructive = (text: string): boolean => DESTRUCTIVE_PATTERN.test(text)
