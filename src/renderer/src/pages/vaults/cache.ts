import type { IdentityMeta, SecretMeta, SshKeyMeta, VaultMeta } from '../../../../shared/vault'

export interface VaultData {
  vaultId: string
  secrets: SecretMeta[]
  keys: SshKeyMeta[]
  identities: IdentityMeta[]
}

/**
 * What the Vaults page last showed, so coming back to it draws at once and refreshes underneath. Metadata
 * only, never a value. AppShell drops it when it unmounts, which a lock always does: if the shell ever
 * stays mounted across a lock, reset this on the lock as well. Apart from the page so the shell can reset
 * it without loading the page.
 */
export const cache: { vaults: VaultMeta[] | null; data: Map<string, VaultData> } = { vaults: null, data: new Map() }

export function resetVaultsCache() {
  cache.vaults = null
  cache.data.clear()
}
