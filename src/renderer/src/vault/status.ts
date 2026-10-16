import { useEffect, useSyncExternalStore } from 'react'
import type { VaultStatus } from '../../../shared/vault'
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

/** Fetches vault:status and publishes it to every subscriber. */
export async function refreshVaultStatus(): Promise<VaultStatus> {
  const status = await api.invoke('vault:status')
  vaultStatusStore.set(status)
  return status
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
    const stopEvents = api.on('vault:locked', () => {
      const s = vaultStatusStore.get()
      if (s?.unlocked) vaultStatusStore.set({ ...s, unlocked: false, corruptVaultIds: [] })
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
