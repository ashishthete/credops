import type { HostMeta, ValueSource } from '../../../shared/inventory'
import type { IdentityMeta, VaultMeta } from '../../../shared/vault'

export interface IdentityChoiceGroup {
  group: 'Linked vaults' | 'Other vaults'
  vault: VaultMeta
  identities: IdentityMeta[]
}

/** Identities by vault: the host's linked vaults first. Corrupt vaults can't be read, so they're left out. */
export function identityChoices(
  identities: IdentityMeta[],
  vaults: VaultMeta[],
  linkedVaultIds: string[],
  corruptVaultIds: string[],
): IdentityChoiceGroup[] {
  const entry = (vault: VaultMeta, group: IdentityChoiceGroup['group']): IdentityChoiceGroup => ({
    group,
    vault,
    identities: identities.filter((i) => i.vaultId === vault.id),
  })
  const usable = vaults.filter((v) => !corruptVaultIds.includes(v.id))
  return [
    ...usable.filter((v) => linkedVaultIds.includes(v.id)).map((v) => entry(v, 'Linked vaults')),
    ...usable.filter((v) => !linkedVaultIds.includes(v.id)).map((v) => entry(v, 'Other vaults')),
  ]
}

/** Hosts that can be a jump host for `selfId`: not itself, and not one whose explicit chain already reaches it. */
export function jumpHostChoices(hosts: HostMeta[], selfId: string | null): HostMeta[] {
  if (!selfId) return hosts
  const byId = new Map(hosts.map((h) => [h.id, h]))
  const reachesSelf = (start: HostMeta): boolean => {
    const seen = new Set<string>()
    for (let h: HostMeta | undefined = start; h && !seen.has(h.id); h = h.jumpHostId ? byId.get(h.jumpHostId) : undefined) {
      if (h.id === selfId) return true
      seen.add(h.id)
    }
    return false
  }
  return hosts.filter((h) => !reachesSelf(h))
}

export function sourceLabel(source: ValueSource | null, envName?: string): string {
  switch (source) {
    case 'host':
      return 'From this host'
    case 'environment':
      return `Inherited from ${envName}`
    case 'global':
      return 'App default'
    default:
      return 'None'
  }
}
