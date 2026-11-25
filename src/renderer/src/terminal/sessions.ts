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
/** Whether the first session list has settled; before it, an empty store may just be a reload. */
export const sessionsLoaded = createStore(false)
/** Pending prompts, oldest first; the head is the one on screen. */
export const promptStore = createStore<SessionPrompt[]>([])

/** Sessions closed from here; late events and replies for them must not bring the tab back. */
const removed = new Set<string>()
/** Sessions with a reconnect in flight; a second click would only earn an error toast. */
const reconnecting = new Set<string>()

/** Empties both stores and forgets closed and reconnecting ids (the shell unmounting, tests). */
export function resetSessions(): void {
  sessionStore.set({ sessions: [], activeId: null, order: [] })
  promptStore.set([])
  removed.clear()
  reconnecting.clear()
  sessionsLoaded.set(false)
}

function upsert(meta: SessionMeta, activate = false): void {
  const s = sessionStore.get()
  const known = s.sessions.some((m) => m.id === meta.id)
  sessionStore.set({
    sessions: known ? s.sessions.map((m) => (m.id === meta.id ? meta : m)) : [...s.sessions, meta],
    order: known ? s.order : [...s.order, meta.id],
    activeId: activate || s.activeId === null ? meta.id : s.activeId,
  })
}

/**
 * Applies an open or reconnect reply. A state event that already landed for the same or a newer
 * attempt is newer than the reply, so it stays; a reply for a session closed meanwhile is dropped.
 */
function applyReply(meta: SessionMeta, activate: boolean): boolean {
  if (removed.has(meta.id)) return false
  const known = sessionStore.get().sessions.find((m) => m.id === meta.id)
  if (!known || known.attempt < meta.attempt) upsert(meta, activate)
  else if (activate) setActive(meta.id)
  return true
}

function remove(id: string): void {
  removed.add(id)
  const s = sessionStore.get()
  const at = s.order.indexOf(id)
  if (at < 0) return
  const order = s.order.filter((x) => x !== id)
  const activeId = s.activeId === id ? (order[at] ?? order[at - 1] ?? null) : s.activeId
  sessionStore.set({ sessions: s.sessions.filter((m) => m.id !== id), order, activeId })
  promptStore.set(promptStore.get().filter((p) => p.sessionId !== id))
  disposeTerminal(id)
}

/**
 * Subscribes to main's session events and loads the open sessions and the prompts still waiting
 * (sent while nothing was listening: locked, or before a reload); returns the unsubscribe.
 */
export function startSessionSync(): () => void {
  /** Prompts settled since the sync started; a slower prompts reply must not bring them back. */
  const done = new Set<string>()
  const offs = [
    api.on('session:data', ({ id, data, end }) => writeData(id, data, end)),
    api.on('session:state', (meta) => {
      if (removed.has(meta.id)) return
      // An event from an older attempt than the stored entry is stale (a reply crossed it).
      const current = sessionStore.get().sessions.find((m) => m.id === meta.id)
      if (current && meta.attempt < current.attempt) return
      upsert(meta)
      // The shell ended on its own (`exit`, logout): the tab goes, like closing it. A drop has an
      // error and keeps its tab for Reconnect.
      if (current?.state === 'ready' && meta.state === 'closed' && !meta.error) void closeSession(meta.id)
    }),
    api.on('session:prompt', (prompt) => {
      if (!promptStore.get().some((p) => p.promptId === prompt.promptId)) promptStore.set([...promptStore.get(), prompt])
    }),
    api.on('session:promptDone', ({ promptId }) => {
      done.add(promptId)
      promptStore.set(promptStore.get().filter((p) => p.promptId !== promptId))
    }),
  ]
  api
    .invoke('session:list')
    .then((list) => {
      // Events that landed before the list keep their (newer) entry.
      const known = new Set(sessionStore.get().order)
      for (const meta of list ?? []) if (!known.has(meta.id) && !removed.has(meta.id)) upsert(meta)
    })
    .catch((err) => fail("Couldn't load your sessions", err))
    .finally(() => sessionsLoaded.set(true))
  api
    .invoke('session:prompts')
    .then((pending) => {
      const queued = promptStore.get()
      const missed = (pending ?? []).filter(
        (p) => !done.has(p.promptId) && !removed.has(p.sessionId) && !queued.some((q) => q.promptId === p.promptId),
      )
      // These were sent before anything that arrived as an event, so they go first.
      if (missed.length) promptStore.set([...missed, ...queued])
    })
    .catch((err) => fail("Couldn't load waiting prompts", err))
  return () => offs.forEach((off) => off())
}

async function open(failTitle: string, request: () => Promise<SessionMeta>): Promise<string | undefined> {
  const meta = await attempt(failTitle, request)
  if (!meta) return undefined
  // The state event may have beaten the reply here; applyReply keeps the newer entry.
  return applyReply(meta, true) ? meta.id : undefined
}

/** Opens an SSH session at the last-known terminal size; resolves undefined after a toast on failure. */
export function openSsh(hostId: string, environmentId?: string, cwd?: string): Promise<string | undefined> {
  const { cols, rows } = getLastSize()
  return open("Couldn't open the session", () => api.invoke('ssh:open', { hostId, environmentId, cols, rows, ...(cwd ? { cwd } : {}) }))
}

/** Opens a `docker exec` tab into a container on the host; resolves undefined after a toast on failure. */
export function openContainer(hostId: string, environmentId: string | null, ref: string): Promise<string | undefined> {
  const { cols, rows } = getLastSize()
  return open("Couldn't open a shell in the container", () =>
    api.invoke('ssh:open', { hostId, environmentId: environmentId ?? undefined, cols, rows, container: ref }),
  )
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

/** One reconnect per session at a time; a reply for a tab closed meanwhile is dropped. */
export async function reconnectSession(id: string): Promise<void> {
  if (reconnecting.has(id)) return
  reconnecting.add(id)
  try {
    const meta = await attempt("Couldn't reconnect", () => api.invoke('session:reconnect', id))
    if (meta && sessionStore.get().order.includes(id)) applyReply(meta, false)
  } finally {
    reconnecting.delete(id)
  }
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

/** mod+1…mod+8 pick that tab and mod+9 the last one, as in Chrome and Safari; a digit past the end does nothing. */
export function selectTabByDigit(digit: number): void {
  const { order } = sessionStore.get()
  const id = digit === 9 ? order.at(-1) : order[digit - 1]
  if (id) setActive(id)
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
