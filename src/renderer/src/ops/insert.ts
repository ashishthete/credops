import type { SnippetMeta } from '../../../shared/ops'
import type { SessionMeta } from '../../../shared/ssh'
import { api } from '../lib/api'
import { getTerminal } from '../terminal/registry'
import { sessionStore } from '../terminal/sessions'
import { attempt } from '../ui/common'
import { toast } from '../ui/Toaster'
import { createStore } from '../ui/store'
import { snippetStore } from './snippets'

/** What the insert dialogs show: the snippet picker (the terminal toolbar), or the fields of one snippet's variables. */
export type InsertRequest = { kind: 'pick' } | { kind: 'fill'; snippetId: string }
export const insertStore = createStore<InsertRequest | null>(null)

let afterInsert: (() => void) | null = null
/** What follows a successful insert (the shell shows the terminals page); set by the mounted InsertHost. */
export function onInserted(fn: (() => void) | null): void {
  afterInsert = fn
}

/** The active tab when a snippet can be typed into it: ready, and either an ssh or a local shell. */
export function insertTarget(): SessionMeta | undefined {
  const { sessions, activeId } = sessionStore.get()
  const active = sessions.find((s) => s.id === activeId)
  return active?.state === 'ready' ? active : undefined
}

function noTerminal(): false {
  toast({ title: 'No terminal is ready', description: 'Open a connected terminal tab to insert a snippet.', tone: 'info' })
  return false
}

/**
 * Renders the snippet in main and pastes the result into the active terminal, without a newline, so it can be
 * read and edited before Enter. The toast names the snippet, never its text. `onError` shows a template error
 * inline (the fill dialog) instead of as a toast. Resolves true once written.
 */
export async function insertSnippet(snippet: SnippetMeta, values: Record<string, string>, onError?: (message: string) => void): Promise<boolean> {
  const target = insertTarget()
  if (!target) return noTerminal()
  const done = await attempt("Couldn't insert the snippet", async () => {
    // Trailing breaks would run the line by themselves.
    const text = (await api.invoke('snippets:render', snippet.id, values)).replace(/[\r\n]+$/, '')
    const { term } = getTerminal(target.id)
    // Without bracketed paste the shell reads every line break as Enter and a tab as completion; xterm's paste
    // wraps the text when the shell asked for it, and only then is a multi-line snippet safe to type.
    if (!term.modes.bracketedPasteMode && /[\r\n\t]/.test(text)) {
      toast({ title: 'This snippet has several lines; run it from Ops › Run', tone: 'info' })
      return false
    }
    term.paste(text)
    return true
  }, onError)
  if (done) {
    toast({ title: `Inserted ${snippet.label}`, tone: 'success' })
    afterInsert?.()
  }
  return !!done
}

/** Starts an insert: asks for the variables first when the snippet has any. */
export function requestInsert(snippetId: string): void {
  const snippet = snippetStore.get().snippets.find((s) => s.id === snippetId)
  if (!snippet) return
  if (!insertTarget()) return void noTerminal()
  if (snippet.variables.length) insertStore.set({ kind: 'fill', snippetId })
  else void insertSnippet(snippet, {})
}
