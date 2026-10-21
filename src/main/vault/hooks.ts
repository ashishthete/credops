import type { VaultService } from './vault-service'

/** What the vault's lock, unlock and reset hooks act on; index.ts passes the real ones. */
export interface VaultHookTargets {
  sessions: { vaultLocked(): void; closeAll(reason: 'reset'): void }
  tunnels: { vaultLocked(): void; vaultUnlocked(): void; vaultReset(): void }
  runs: { vaultLocked(): void; vaultReset(): void }
  links: { vaultLocked(): void; closeForReset(): void }
  containers: { vaultLocked(): void; vaultReset(): void }
  releases: { vaultReset(): void }
  prompts: { cancelAll(): void }
}

/**
 * The one place the vault's hooks are wired, so the app and its tests share it.
 *
 * On lock, in this order: sessions fail their dials and tunnels mark theirs to pause (both keep
 * what is connected); runs end their queued and dialling hosts as `locked` while running
 * commands finish; every log follow (container and compose) stops and says the vault locked (a new
 * one waits for unlock); exec links fail their dials as `locked` and close idle links; then every
 * prompt left is cancelled. Runs go before links so each dial a run aborts is already marked
 * `locked` for that host. Separate listeners, so one failing never skips the others.
 *
 * Every listener must be synchronous. The vault calls them in order and doesn't await them: a
 * returned promise only has its rejection logged, so its work would still be running after `lock`
 * or `reset` has returned, past the point (for a reset) where the erase has run and setup may begin again.
 */
export function wireVaultHooks(vault: Pick<VaultService, 'onLock' | 'onUnlock' | 'onBeforeReset'>, t: VaultHookTargets): void {
  vault.onLock(() => t.sessions.vaultLocked())
  vault.onLock(() => t.tunnels.vaultLocked())
  vault.onLock(() => t.runs.vaultLocked())
  vault.onLock(() => t.containers.vaultLocked())
  vault.onLock(() => t.links.vaultLocked())
  vault.onLock(() => t.prompts.cancelAll())
  // Resumes paused tunnels; the first unlock also auto-starts.
  vault.onUnlock(() => t.tunnels.vaultUnlocked())
  // A reset needs no password, so nothing the old one guarded may survive it, and it is all stopped
  // before the erase: every running deploy or release first (its playbook cancelled, rollbacks
  // too), then every session (local shells too, for their scrollback), every tunnel, every ops run
  // (with its output), every container and service log follow (with the cached container names)
  // and every exec link, leased ones too. Runs and follows go before links, so each ends as
  // cancelled rather than failing on a dropped link.
  vault.onBeforeReset(() => t.releases.vaultReset())
  vault.onBeforeReset(() => t.sessions.closeAll('reset'))
  vault.onBeforeReset(() => t.tunnels.vaultReset())
  vault.onBeforeReset(() => t.runs.vaultReset())
  vault.onBeforeReset(() => t.containers.vaultReset())
  vault.onBeforeReset(() => t.links.closeForReset())
}
