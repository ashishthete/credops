import type { ExplainSubject, Explanation } from '../../../shared/ai'
import { api } from '../lib/api'
import { errorText } from '../ui/common'
import { createStore } from '../ui/store'

export interface ExplainState {
  open: boolean
  subject: ExplainSubject | null
  state: 'loading' | 'ready' | 'error'
  explanation: Explanation | null
  error: string | null
  /** The live request; a reply for any other id is stale and dropped. */
  requestId: string | null
}

const CLOSED: ExplainState = { open: false, subject: null, state: 'loading', explanation: null, error: null, requestId: null }
export const explainStore = createStore<ExplainState>(CLOSED)

/** The most recent failure seen, for the palette's `Explain last failure`. */
export const lastFailureStore = createStore<ExplainSubject | null>(null)

let returnFocus: Element | null = null

export function resetExplain(): void {
  explainStore.set(CLOSED)
  lastFailureStore.set(null)
  returnFocus = null
}

export function noteFailure(subject: ExplainSubject): void {
  lastFailureStore.set(subject)
}

/** Opens the panel and asks main to explain `subject`. Never touches a session. */
export async function explain(subject: ExplainSubject, trigger: Element | null = document.activeElement): Promise<void> {
  const prev = explainStore.get()
  if (prev.state === 'loading' && prev.requestId) void api.invoke('ai:cancel', prev.requestId).catch(() => undefined)
  if (!prev.open) returnFocus = trigger
  const requestId = crypto.randomUUID()
  explainStore.set({ open: true, subject, state: 'loading', explanation: null, error: null, requestId })
  try {
    const explanation = await api.invoke('ai:explain', requestId, subject)
    if (explainStore.get().requestId === requestId) explainStore.set({ ...explainStore.get(), state: 'ready', explanation })
  } catch (err) {
    if (explainStore.get().requestId === requestId) explainStore.set({ ...explainStore.get(), state: 'error', error: errorText(err) })
  }
}

/** Closes the panel, cancelling a request still in flight, and hands focus back to the trigger. */
export function closeExplain(): void {
  const s = explainStore.get()
  if (!s.open) return
  if (s.state === 'loading' && s.requestId) void api.invoke('ai:cancel', s.requestId).catch(() => undefined)
  explainStore.set(CLOSED)
  const el = returnFocus
  returnFocus = null
  if (el instanceof HTMLElement && el.isConnected) el.focus()
}
