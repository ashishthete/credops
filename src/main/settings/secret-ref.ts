import type { SecretKind, SecretMeta } from '../../shared/vault'

/** The part of SecretStore the settings stores read: names and kinds only, never values. */
export interface SecretLookup {
  list(): SecretMeta[]
}

/** Checks that `id` names an existing secret of `kind`. Messages never hold the id or the value. */
export function checkSecretRef(secrets: SecretLookup, id: string | null, kind: SecretKind): string | null {
  if (id === null) return null
  if (typeof id !== 'string') throw new Error('secret not found')
  const found = secrets.list().find((s) => s.id === id)
  if (!found) throw new Error('secret not found')
  if (found.kind !== kind) throw new Error(`that secret is a ${found.kind}; pick a ${kind}`)
  return id
}

/** `id` when it still names a secret, else null: a deleted secret reads as "not configured". */
export function liveSecretRef(secrets: SecretLookup, id: string | null): string | null {
  if (id === null) return null
  return secrets.list().some((s) => s.id === id) ? id : null
}
