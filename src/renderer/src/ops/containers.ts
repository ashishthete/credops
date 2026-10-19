import { RUN_OUTPUT_CHARS, type ContainerAction, type ContainerList, type ContainerLogEvent } from '../../../shared/ops'
import { api } from '../lib/api'
import { attempt, errorText } from '../ui/common'
import { createStore } from '../ui/store'

export interface ContainersState {
  list: ContainerList | null
  loading: boolean
  error: string | null
  /** The action in flight per container ref. */
  busy: Record<string, ContainerAction>
}

const BLANK: ContainersState = { list: null, loading: false, error: null, busy: {} }

/** `hostId|environmentId`; no environment keys as an empty id. */
export const containerKey = (hostId: string, environmentId: string | null) => `${hostId}|${environmentId ?? ''}`

export const containerStore = createStore<Record<string, ContainersState>>({})
/** Followed log text per followId, capped like a run's output. */
export const followStore = createStore<Record<string, string>>({})

const logListeners = new Set<(event: ContainerLogEvent) => void>()

/** Every `containers:logs` event, including the end of a follow; the follow views hang off it. */
export function onContainerLog(fn: (event: ContainerLogEvent) => void): () => void {
  logListeners.add(fn)
  return () => {
    logListeners.delete(fn)
  }
}

export function resetContainers(): void {
  containerStore.set({})
  followStore.set({})
}

export function clearFollow(followId: string): void {
  const { [followId]: _gone, ...rest } = followStore.get()
  followStore.set(rest)
}

export function applyContainerLog(event: ContainerLogEvent): void {
  if ('chunk' in event) {
    const text = (followStore.get()[event.followId] ?? '') + event.chunk
    followStore.set({ ...followStore.get(), [event.followId]: text.length > RUN_OUTPUT_CHARS ? text.slice(text.length - RUN_OUTPUT_CHARS) : text })
  }
  logListeners.forEach((fn) => fn(event))
}

function patch(key: string, change: (s: ContainersState) => Partial<ContainersState>): void {
  const all = containerStore.get()
  const s = all[key] ?? BLANK
  containerStore.set({ ...all, [key]: { ...s, ...change(s) } })
}

export async function loadContainers(hostId: string, environmentId: string | null): Promise<void> {
  const key = containerKey(hostId, environmentId)
  patch(key, () => ({ loading: true, error: null }))
  try {
    const list = await api.invoke('containers:list', hostId, environmentId)
    patch(key, () => ({ list, loading: false }))
  } catch (err) {
    patch(key, () => ({ loading: false, error: errorText(err) }))
  }
}

/** Runs a container action, then refreshes the list. `onError` shows a refusal inline (the confirm dialog). */
export async function containerAction(
  hostId: string,
  environmentId: string | null,
  ref: string,
  action: ContainerAction,
  confirm?: string,
  onError?: (message: string) => void,
): Promise<boolean> {
  const key = containerKey(hostId, environmentId)
  patch(key, (s) => ({ busy: { ...s.busy, [ref]: action } }))
  const done = await attempt(
    `Couldn't ${action} ${ref}`,
    async () => {
      await api.invoke('containers:action', hostId, environmentId, ref, action, confirm)
      return true
    },
    onError,
  )
  patch(key, (s) => {
    const { [ref]: _gone, ...busy } = s.busy
    return { busy }
  })
  if (done) await loadContainers(hostId, environmentId)
  return !!done
}
