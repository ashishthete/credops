import { useEffect, useSyncExternalStore } from 'react'
import type { LockReason, VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'

const POLL_MS = 5000

type Listener = () => void

let current: VaultStatus | null = null
const listeners = new Set<Listener>()

/** The last vault status seen from the main process; null until the first fetch. */
export const vaultStatusStore = {
  get: (): VaultStatus | null => current,
  set(next: VaultStatus | null) {
    current = next
    listeners.forEach((l) => l())
  },
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

// The last vault:status failure, cleared by the next success; the gate's splash reports it.
let statusError: string | null = null
const errorListeners = new Set<Listener>()

function setStatusError(next: string | null) {
  if (next === statusError) return
  statusError = next
  errorListeners.forEach((l) => l())
}

/** Fetches vault:status and publishes it to every subscriber. */
export async function refreshVaultStatus(): Promise<VaultStatus> {
  let status: VaultStatus
  try {
    status = await api.invoke('vault:status')
  } catch (err) {
    setStatusError(err instanceof Error ? err.message : String(err))
    throw err
  }
  setStatusError(null)
  vaultStatusStore.set(status)
  return status
}

/** Why the vaults last locked, kept until the gate takes it; null means "found locked by a poll". */
let lockReason: LockReason | null = null

/** Records why the next (or current) lock happens. lockVaults() sets 'manual' before invoking. */
export function noteLockReason(reason: LockReason | null): void {
  lockReason = reason
}

/** Reads the reason without clearing it, for decisions made during render. */
export const peekLockReason = (): LockReason | null => lockReason

/** Returns the reason and clears it. */
export function takeLockReason(): LockReason | null {
  const reason = lockReason
  lockReason = null
  return reason
}

/** Marks the cached status locked without waiting for main (after a lock push or a failed refresh). */
export function markLocked(): void {
  const s = vaultStatusStore.get()
  if (s?.unlocked) vaultStatusStore.set({ ...s, unlocked: false, corruptVaultIds: [] })
}

// Polling is shared: the first useVaultStatus starts it and the last one to unmount stops it.
let pollers = 0
let stopPolling: (() => void) | null = null

function quietRefresh() {
  refreshVaultStatus().catch(() => {
    // Keep the last known status; the next poll tries again.
  })
}

function startPolling(): () => void {
  if (pollers++ === 0) {
    quietRefresh()
    const timer = setInterval(quietRefresh, POLL_MS)
    window.addEventListener('focus', quietRefresh)
    // Main pushes every lock; the poll stays as a backstop.
    // This push arrives before a manual vault:lock invoke resolves, so its reason is what tells
    // the gate whose lock it was.
    const stopEvents = api.on('vault:locked', ({ reason }) => {
      noteLockReason(reason)
      markLocked()
      quietRefresh()
    })
    stopPolling = () => {
      clearInterval(timer)
      window.removeEventListener('focus', quietRefresh)
      stopEvents()
    }
  }
  return () => {
    if (--pollers === 0) {
      stopPolling?.()
      stopPolling = null
    }
  }
}

/** The live vault status: pushed on lock, polled every 5 s and on window focus while anything is subscribed. */
export function useVaultStatus(): VaultStatus | null {
  useEffect(startPolling, [])
  return useSyncExternalStore(vaultStatusStore.subscribe, vaultStatusStore.get)
}

/** The last vault:status error message, or null once a fetch succeeds. */
export function useVaultStatusError(): string | null {
  return useSyncExternalStore(
    (l) => {
      errorListeners.add(l)
      return () => {
        errorListeners.delete(l)
      }
    },
    () => statusError,
  )
}
