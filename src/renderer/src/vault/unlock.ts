import { VAULT_LOCKED } from '../../../shared/vault'
import { api } from '../lib/api'
import { toast } from '../ui/Toaster'
import { markLocked, noteLockReason, refreshVaultStatus, vaultStatusStore } from './status'

// Callers waiting for the gate to be passed; a locked status is what puts the gate up.
let waiters: Array<(ok: boolean) => void> = []

function settle(ok: boolean) {
  const done = waiters
  waiters = []
  done.forEach((resolve) => resolve(ok))
}

/** Called by the gate once the vaults are open. */
export const resolveUnlock = () => settle(true)
/** Resolves every pending ensureUnlocked() to false (teardown and tests). */
export const cancelUnlock = () => settle(false)

/**
 * Resolves true at once when unlocked. Otherwise the refreshed (locked) status brings up the
 * auth gate, and this resolves true once the user is back through it.
 */
export async function ensureUnlocked(): Promise<boolean> {
  if (vaultStatusStore.get()?.unlocked) return true
  try {
    if ((await refreshVaultStatus()).unlocked) return true
  } catch {
    // No status means no gate either; report "not unlocked" rather than wait forever.
    return false
  }
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve)
  })
}

function isLocked(err: unknown): boolean {
  return err instanceof Error && err.message === VAULT_LOCKED
}

/**
 * Runs a secret-needing action. When it fails because the vaults are locked, asks for an unlock
 * and retries once; resolves undefined if no unlock happens (status unreadable).
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

/** Locks every vault. The gate announces it once the locked status (or main's push) lands. */
export async function lockVaults(): Promise<void> {
  // Set before the await: main's 'vault:locked' push (reason 'manual') may land first, and either
  // way the gate must know the user asked for this.
  noteLockReason('manual')
  try {
    await api.invoke('vault:lock')
  } catch (err) {
    noteLockReason(null)
    toast({ title: "Couldn't lock vaults", description: err instanceof Error ? err.message : String(err), tone: 'error' })
    return
  }
  await refreshVaultStatus().catch(markLocked)
}
