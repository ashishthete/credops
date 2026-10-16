import type { SessionMeta, SessionPrompt, PromptAnswer } from '../../../shared/ssh'
import { api } from '../lib/api'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'
import { disposeTerminal, getLastSize, writeData } from './registry'

export interface SessionsState {
  sessions: SessionMeta[]
  activeId: string | null
  /** Tab order, by session id. */
  order: string[]
}

export const sessionStore = createStore<SessionsState>({ sessions: [], activeId: null, order: [] })
/** Pending prompts, oldest first; the head is the one on screen. */
export const promptStore = createStore<SessionPrompt[]>([])

function upsert(meta: SessionMeta, activate = false): void {
  const s = sessionStore.get()
  const known = s.sessions.some((m) => m.id === meta.id)
  sessionStore.set({
    sessions: known ? s.sessions.map((m) => (m.id === meta.id ? meta : m)) : [...s.sessions, meta],
    order: known ? s.order : [...s.order, meta.id],
    activeId: activate || s.activeId === null ? meta.id : s.activeId,
  })
}

function remove(id: string): void {
  const s = sessionStore.get()
  const at = s.order.indexOf(id)
  if (at < 0) return
  const order = s.order.filter((x) => x !== id)
  const activeId = s.activeId === id ? (order[at] ?? order[at - 1] ?? null) : s.activeId
  sessionStore.set({ sessions: s.sessions.filter((m) => m.id !== id), order, activeId })
  promptStore.set(promptStore.get().filter((p) => p.sessionId !== id))
  disposeTerminal(id)
}

/** Subscribes to main's session events and loads the open sessions; returns the unsubscribe. */
export function startSessionSync(): () => void {
  const offs = [
    api.on('session:data', ({ id, data }) => writeData(id, data)),
    api.on('session:state', (meta) => upsert(meta)),
    api.on('session:prompt', (prompt) => {
      if (!promptStore.get().some((p) => p.promptId === prompt.promptId)) promptStore.set([...promptStore.get(), prompt])
    }),
    api.on('session:promptDone', ({ promptId }) => {
      promptStore.set(promptStore.get().filter((p) => p.promptId !== promptId))
    }),
  ]
  api
    .invoke('session:list')
    .then((list) => {
      // Events that landed before the list keep their (newer) entry.
      const known = new Set(sessionStore.get().order)
      for (const meta of list ?? []) if (!known.has(meta.id)) upsert(meta)
    })
    .catch((err) => fail("Couldn't load your sessions", err))
  return () => offs.forEach((off) => off())
}

async function open(failTitle: string, request: () => Promise<SessionMeta>): Promise<string | undefined> {
  const meta = await attempt(failTitle, request)
  if (!meta) return undefined
  // The state event may have beaten the reply here; upsert keeps one entry either way.
  upsert(meta, true)
  return meta.id
}

/** Opens an SSH session at the last-known terminal size; resolves undefined after a toast on failure. */
export function openSsh(hostId: string, environmentId?: string): Promise<string | undefined> {
  const { cols, rows } = getLastSize()
  return open("Couldn't open the session", () => api.invoke('ssh:open', { hostId, environmentId, cols, rows }))
}

export function openLocal(): Promise<string | undefined> {
  const { cols, rows } = getLastSize()
  return open("Couldn't open a shell", () => api.invoke('shell:open', { cols, rows }))
}

export async function closeSession(id: string): Promise<void> {
  try {
    await api.invoke('session:close', id)
  } catch (err) {
    fail("Couldn't close the session", err)
    return
  }
  remove(id)
}

export async function reconnectSession(id: string): Promise<void> {
  const meta = await attempt("Couldn't reconnect", () => api.invoke('session:reconnect', id))
  if (meta) upsert(meta)
}

export function setActive(id: string): void {
  const s = sessionStore.get()
  if (s.order.includes(id) && s.activeId !== id) sessionStore.set({ ...s, activeId: id })
}

export function nextTab(dir: 1 | -1): void {
  const { order, activeId } = sessionStore.get()
  if (order.length === 0) return
  const at = activeId ? order.indexOf(activeId) : -1
  setActive(order[(at + dir + order.length) % order.length])
}

export function moveTab(id: string, toIndex: number): void {
  const s = sessionStore.get()
  const from = s.order.indexOf(id)
  if (from < 0) return
  const order = s.order.filter((x) => x !== id)
  order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id)
  sessionStore.set({ ...s, order })
}

export async function answerPrompt(promptId: string, answer: PromptAnswer): Promise<void> {
  // Optimistic: the prompt leaves the queue now; main's promptDone is then a no-op.
  promptStore.set(promptStore.get().filter((p) => p.promptId !== promptId))
  try {
    await api.invoke('session:answer', promptId, answer)
  } catch (err) {
    fail("Couldn't send your answer", err)
  }
}
