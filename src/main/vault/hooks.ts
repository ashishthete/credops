import type { VaultService } from './vault-service'

/** What the vault's lock, unlock and reset hooks act on; index.ts passes the real ones. */
export interface VaultHookTargets {
  sessions: { vaultLocked(): void; closeAll(reason: 'reset'): void }
  tunnels: { vaultLocked(): void; vaultUnlocked(): void; vaultReset(): void }
  runs: { vaultLocked(): void; vaultReset(): void }
  links: { vaultLocked(): void; closeForReset(): void }
  containers: { vaultReset(): void }
  prompts: { cancelAll(): void }
}

/**
 * The one place the vault's hooks are wired, so the app and its tests share it.
 *
 * On lock, in this order: sessions fail their dials and tunnels mark theirs to pause (both keep
 * what is connected); runs end their queued and dialling hosts as `locked` while running
 * commands finish; exec links fail their dials as `locked` and close idle links; then every
 * prompt left is cancelled. Runs go before links so each dial a run aborts is already marked
 * `locked` for that host. Separate listeners, so one failing never skips the others.
 */
export function wireVaultHooks(vault: Pick<VaultService, 'onLock' | 'onUnlock' | 'onReset'>, t: VaultHookTargets): void {
  vault.onLock(() => t.sessions.vaultLocked())
  vault.onLock(() => t.tunnels.vaultLocked())
  vault.onLock(() => t.runs.vaultLocked())
  vault.onLock(() => t.links.vaultLocked())
  vault.onLock(() => t.prompts.cancelAll())
  // Resumes paused tunnels; the first unlock also auto-starts.
  vault.onUnlock(() => t.tunnels.vaultUnlocked())
  // A reset needs no password, so nothing the old one guarded may survive it: every session
  // (local shells too, for their scrollback), every tunnel, every ops run (with its output), every
  // container log follow (with the cached container names) and every exec link, leased ones too,
  // goes before the gate opens. Runs and follows go before links, so each ends as cancelled rather
  // than failing on a dropped link.
  vault.onReset(() => t.sessions.closeAll('reset'))
  vault.onReset(() => t.tunnels.vaultReset())
  vault.onReset(() => t.runs.vaultReset())
  vault.onReset(() => t.containers.vaultReset())
  vault.onReset(() => t.links.closeForReset())
}
