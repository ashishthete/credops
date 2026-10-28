import { useSyncExternalStore } from 'react'
import { readStored, writeStored } from '../ui/storage'
import { createStore } from '../ui/store'

// A per-machine UI preference, like the sidebar's collapsed state: kept in localStorage, not in the
// audited settings. A deleted host's id stays until it is unstarred; readers skip ids they don't know.
const KEY = 'opsdeck.terminal.favourites'

function load(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readStored(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Starred host ids, in the order they were starred. */
export const favouriteStore = createStore<readonly string[]>(load())

export const useFavourites = () => useSyncExternalStore(favouriteStore.subscribe, favouriteStore.get)

export function toggleFavourite(hostId: string): void {
  const now = favouriteStore.get()
  const next = now.includes(hostId) ? now.filter((id) => id !== hostId) : [...now, hostId]
  favouriteStore.set(next)
  writeStored(KEY, JSON.stringify(next))
}

/** Reloads from storage (tests). */
export function reloadFavourites(): void {
  favouriteStore.set(load())
}
