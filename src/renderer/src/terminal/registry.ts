import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
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
  /** Live data that arrived while the attach was in flight; written after the buffer. */
  queue: string[] | null
}

const entries = new Map<string, Entry>()

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
      fontFamily: 'JetBrains Mono Variable',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
      theme: terminalTheme,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_event, url) => void window.open(url)))
    entry = { term, fit, search, attach: null, queue: null }
    entries.set(id, entry)
  }
  return entry
}

/**
 * Replays main's buffer into the terminal, once. Live data that arrives meanwhile is queued
 * and written after the buffer, in order. A failed attach still releases the queue.
 */
export function attachSession(id: string): Promise<void> {
  const entry = entries.get(id) ?? (getTerminal(id), entries.get(id)!)
  entry.attach ??= (async () => {
    entry.queue = []
    try {
      const { buffer } = await api.invoke('session:attach', id)
      if (buffer) entry.term.write(buffer)
    } catch {
      // The session is gone or main is shutting down; the state events say so.
    }
    for (const data of entry.queue ?? []) entry.term.write(data)
    entry.queue = null
  })()
  return entry.attach
}

/** Terminal output goes straight to xterm; it never passes through React state. */
export function writeData(id: string, data: string): void {
  const entry = entries.get(id)
  if (!entry?.attach) return
  if (entry.queue) entry.queue.push(data)
  else entry.term.write(data)
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
