import type { SnippetInput, SnippetMeta } from '../../../shared/ops'
import { api } from '../lib/api'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'

export interface SnippetsState {
  snippets: SnippetMeta[]
  loaded: boolean
}

const EMPTY: SnippetsState = { snippets: [], loaded: false }

export const snippetStore = createStore<SnippetsState>(EMPTY)

let generation = 0

/** Empties the store (the shell unmounting, tests); a load still in flight is discarded. */
export function resetSnippets(): void {
  generation++
  snippetStore.set(EMPTY)
}

/** Main's order: label (case-insensitive), then id. */
const byLabel = (a: SnippetMeta, b: SnippetMeta) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)

export async function loadSnippets(): Promise<void> {
  const started = generation
  try {
    const snippets = await api.invoke('snippets:list')
    if (started === generation) snippetStore.set({ snippets: snippets ?? [], loaded: true })
  } catch (err) {
    fail("Couldn't load your snippets", err)
  }
}

/** Creates a snippet, or updates `id`'s. `onError` shows a store error inline (a dialog) instead of as a toast. */
export async function saveSnippet(id: string | null, input: SnippetInput, onError?: (message: string) => void): Promise<SnippetMeta | undefined> {
  const meta = await attempt(
    "Couldn't save the snippet",
    () => (id ? api.invoke('snippets:update', id, input) : api.invoke('snippets:create', input)),
    onError,
  )
  if (meta) {
    const s = snippetStore.get()
    snippetStore.set({ ...s, snippets: [...s.snippets.filter((x) => x.id !== meta.id), meta].sort(byLabel) })
  }
  return meta
}

export async function deleteSnippet(id: string): Promise<boolean> {
  const done = await attempt("Couldn't delete the snippet", async () => {
    await api.invoke('snippets:delete', id)
    return true
  })
  if (!done) return false
  const s = snippetStore.get()
  snippetStore.set({ ...s, snippets: s.snippets.filter((x) => x.id !== id) })
  return true
}
