import { VAULT_LOCKED } from '../../../shared/vault'
import { api } from '../lib/api'
import { toast } from '../ui/Toaster'
import { refreshVaultStatus, vaultStatusStore } from './status'

type Listener = () => void

// The unlock dialog is open while someone awaits an unlock; every waiter shares one prompt.
let waiters: Array<(ok: boolean) => void> = []
const listeners = new Set<Listener>()

export const unlockRequestStore = {
  get: (): boolean => waiters.length > 0,
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

function settle(ok: boolean) {
  if (!waiters.length) return
  const done = waiters
  waiters = []
  listeners.forEach((l) => l())
  done.forEach((resolve) => resolve(ok))
}

/** Called by the dialog once the vaults are open. */
export const resolveUnlock = () => settle(true)
/** Closes the dialog; every pending ensureUnlocked() resolves to false. */
export const cancelUnlock = () => settle(false)

/** Resolves true at once when unlocked; otherwise opens the unlock (or setup) dialog and waits. */
export async function ensureUnlocked(): Promise<boolean> {
  if (vaultStatusStore.get()?.unlocked) return true
  try {
    if ((await refreshVaultStatus()).unlocked) return true
  } catch {
    // Show the dialog anyway; it reports its own errors.
  }
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve)
    if (waiters.length === 1) listeners.forEach((l) => l())
  })
}

function isLocked(err: unknown): boolean {
  return err instanceof Error && err.message === VAULT_LOCKED
}

/**
 * Runs a secret-needing action. When it fails because the vaults are locked, asks for an unlock
 * and retries once; resolves undefined if the user dismisses the prompt.
 */
export async function withUnlock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    if (!isLocked(err)) throw err
  }
  // The cached status may still say unlocked (e.g. auto-lock since the last poll).
  await refreshVaultStatus().catch(() => undefined)
  if (!(await ensureUnlocked())) return undefined
  return fn()
}

// Set once the user's own lock went through, so the lock watcher does not announce it twice.
let userLockPending = false

/** True (once) when the last lock was the user's; the watcher also calls it on every unlocked status. */
export function takeUserLock(): boolean {
  const pending = userLockPending
  userLockPending = false
  return pending
}

/** Locks every vault and says so. */
export async function lockVaults(): Promise<void> {
  try {
    await api.invoke('vault:lock')
  } catch (err) {
    toast({ title: "Couldn't lock vaults", description: err instanceof Error ? err.message : String(err), tone: 'error' })
    return
  }
  userLockPending = true
  toast({ title: 'Vaults locked', tone: 'info' })
  await refreshVaultStatus().catch(() => {
    const s = vaultStatusStore.get()
    if (s) vaultStatusStore.set({ ...s, unlocked: false, corruptVaultIds: [] })
  })
}
