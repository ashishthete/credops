import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * State a page keeps across navigation: leaving a page unmounts it, so its filters and drafts live here
 * instead, by key. Memory only, since a draft can hold anything typed; a lock unmounts the shell, which
 * empties it (resetKept).
 */
const kept = new Map<string, unknown>()

/** Like useState, but the value outlives the component: the next mount under `key` starts from it. */
export function useKeptState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial instanceof Function ? initial() : initial))
  useEffect(() => {
    kept.set(key, value)
  }, [key, value])
  return [value, setValue]
}

/** Like useRef, but the same object comes back on every mount under `key`. */
export function useKeptRef<T>(key: string, initial: T): { current: T } {
  const [ref] = useState(() => {
    if (!kept.has(key)) kept.set(key, { current: initial })
    return kept.get(key) as { current: T }
  })
  return ref
}

/** Forgets every kept value (the shell unmounting on lock, tests). */
export function resetKept(): void {
  kept.clear()
}
