import type { SnippetMeta } from '../../../shared/ops'
import type { SessionMeta } from '../../../shared/ssh'
import { api } from '../lib/api'
import { sessionStore } from '../terminal/sessions'
import { attempt } from '../ui/common'
import { toast } from '../ui/Toaster'
import { createStore } from '../ui/store'
import { snippetStore } from './snippets'

/** What the insert dialogs show: the snippet picker (the terminal toolbar), or the fields of one snippet's variables. */
export type InsertRequest = { kind: 'pick' } | { kind: 'fill'; snippetId: string }
export const insertStore = createStore<InsertRequest | null>(null)

/** The active tab when a snippet can be typed into it: ready, and either an ssh or a local shell. */
export function insertTarget(): SessionMeta | undefined {
  const { sessions, activeId } = sessionStore.get()
  const active = sessions.find((s) => s.id === activeId)
  return active?.state === 'ready' ? active : undefined
}

/**
 * Renders the snippet in main and types the result into the active terminal, without a newline, so it can be
 * read and edited before Enter. The toast names the snippet, never its text. `onError` shows a template error
 * inline (the fill dialog) instead of as a toast. Resolves true once written.
 */
export async function insertSnippet(snippet: SnippetMeta, values: Record<string, string>, onError?: (message: string) => void): Promise<boolean> {
  const target = insertTarget()
  if (!target) {
    toast({ title: 'No terminal is ready', description: 'Open a connected terminal tab to insert a snippet.', tone: 'info' })
    return false
  }
  const done = await attempt("Couldn't insert the snippet", async () => {
    const text = await api.invoke('snippets:render', snippet.id, values)
    await api.invoke('session:write', target.id, text)
    return true
  }, onError)
  if (done) toast({ title: `Inserted ${snippet.label}`, tone: 'success' })
  return !!done
}

/** Starts an insert: asks for the variables first when the snippet has any. */
export function requestInsert(snippetId: string): void {
  const snippet = snippetStore.get().snippets.find((s) => s.id === snippetId)
  if (!snippet) return
  if (snippet.variables.length) insertStore.set({ kind: 'fill', snippetId })
  else void insertSnippet(snippet, {})
}
