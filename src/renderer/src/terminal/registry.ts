import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { SCROLLBACK_CHARS } from '../../../shared/ssh'
import { api } from '../lib/api'
import { terminalTheme } from './theme'

export interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
}

interface Entry extends TerminalHandle {
  /** Set once attach has started; live data before it is dropped, because the buffer covers it. */
  attach: Promise<void> | null
  /** The stream offset the replayed buffer reaches; chunks at or below it are already on screen. */
  attachEnd: number
  /** Live data that arrived while the attach was in flight; written after the buffer. */
  queue: { data: string; end: number }[] | null
  queuedChars: number
}

const entries = new Map<string, Entry>()

/** The bundled font first; the fallbacks keep cells monospaced if it hasn't loaded. */
export const TERMINAL_FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
const FONT_SIZE = 13

/**
 * xterm measures its cell from the font at open time. The bundled font loads lazily, so the first
 * terminal could measure (and draw) a fallback; once it arrives, every terminal re-measures.
 */
let fontReady: Promise<void> | null = null
export function loadTerminalFont(): Promise<void> {
  fontReady ??= (async () => {
    try {
      await Promise.all([
        document.fonts.load(`400 ${FONT_SIZE}px "JetBrains Mono Variable"`),
        document.fonts.load(`700 ${FONT_SIZE}px "JetBrains Mono Variable"`),
      ])
    } catch {
      return // no FontFaceSet (tests) or the font failed: the fallbacks stay
    }
    for (const { term, fit } of entries.values()) {
      term.options.fontFamily = 'monospace' // a real change makes xterm re-measure
      term.options.fontFamily = TERMINAL_FONT
      try {
        fit.fit()
      } catch {
        /* not laid out yet */
      }
    }
  })()
  return fontReady
}

let lastSize = { cols: 80, rows: 24 }
/** The size of the most recently fitted terminal; new sessions open at it. */
export const getLastSize = () => lastSize
export function setLastSize(cols: number, rows: number): void {
  lastSize = { cols, rows }
}

/** Creates the terminal on first use and keeps it for the life of the session. */
export function getTerminal(id: string): TerminalHandle {
  let entry = entries.get(id)
  if (!entry) {
    const term = new Terminal({
      scrollback: 10_000,
      fontFamily: TERMINAL_FONT,
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      fontWeightBold: 'bold',
      cursorBlink: true,
      allowProposedApi: false,
      theme: terminalTheme,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_event, url) => void window.open(url)))
    entry = { term, fit, search, attach: null, attachEnd: 0, queue: null, queuedChars: 0 }
    entries.set(id, entry)
    void loadTerminalFont()
  }
  return entry
}

/** The part of a chunk past `attachEnd`; `end` is the stream offset after the chunk. */
function unseen(data: string, end: number, attachEnd: number): string {
  if (end <= attachEnd) return ''
  const start = end - data.length
  return start >= attachEnd ? data : data.slice(attachEnd - start)
}

function write(id: string, entry: Entry, data: string, end: number): void {
  // A tab closed mid-attach disposes the terminal; writing to it would throw.
  if (entries.get(id) !== entry) return
  const text = unseen(data, end, entry.attachEnd)
  if (text) entry.term.write(text)
}

/**
 * Replays main's buffer into the terminal, once. Live data that arrives meanwhile is queued;
 * after the replay, each chunk is written only past the buffer's end offset, so output that
 * is in both the buffer and an event shows once. A failed attach still releases the queue.
 * A no-op for a session that has no terminal (it was closed).
 */
export function attachSession(id: string): Promise<void> {
  const entry = entries.get(id)
  if (!entry) return Promise.resolve()
  entry.attach ??= (async () => {
    entry.queue = []
    try {
      const { buffer, end } = await api.invoke('session:attach', id)
      if (entries.get(id) !== entry) return
      entry.attachEnd = end
      if (buffer) entry.term.write(buffer)
    } catch {
      // The session is gone or main is shutting down; the state events say so.
    }
    const queued = entry.queue ?? []
    entry.queue = null
    entry.queuedChars = 0
    for (const { data, end } of queued) write(id, entry, data, end)
  })()
  return entry.attach
}

/** Terminal output goes straight to xterm; it never passes through React state. */
export function writeData(id: string, data: string, end: number): void {
  const entry = entries.get(id)
  if (!entry?.attach) return
  if (!entry.queue) return write(id, entry, data, end)
  // Bound the in-flight queue at the scrollback size, oldest first, like the buffer itself.
  entry.queue.push({ data, end })
  entry.queuedChars += data.length
  while (entry.queuedChars > SCROLLBACK_CHARS && entry.queue.length > 1) entry.queuedChars -= entry.queue.shift()!.data.length
}

export function disposeTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  entry.term.dispose()
}

export function disposeAll(): void {
  for (const id of [...entries.keys()]) disposeTerminal(id)
}
