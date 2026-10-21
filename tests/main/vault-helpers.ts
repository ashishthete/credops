import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { deriveKek, newKdfParams, randomKey, seal, type KdfParams } from '../../src/main/vault/crypto'
import type { ClipboardLike } from '../../src/main/vault/types'
import { VaultService, type QuickUnlockDeps } from '../../src/main/vault/vault-service'

/** Cheapest params deriveKek accepts; tests only. */
export const FAST_KDF: Omit<KdfParams, 'salt'> = { alg: 'scrypt', N: 2 ** 10, r: 8, p: 1 }

export const actor = { osUser: 'tester', machine: 'box' }

export interface VaultFixture {
  db: Db
  audit: AuditLog
  vault: VaultService
  /** Advance `now.t` (ms since epoch) to move the clock for both the vault and the audit log. */
  now: { t: number }
  clipboard?: ClipboardLike
}

export function makeVault(
  opts: {
    db?: Db
    quick?: QuickUnlockDeps
    kdf?: Omit<KdfParams, 'salt'>
    clipboard?: ClipboardLike
    now?: { t: number }
  } = {},
): VaultFixture {
  const db = opts.db ?? openDatabase(':memory:')
  const now = opts.now ?? { t: Date.UTC(2026, 0, 1) }
  const clock = (): Date => new Date(now.t)
  let vault: VaultService | undefined
  const audit = new AuditLog(db, { actor, now: clock, knownSecrets: () => vault?.knownValues() ?? [] })
  vault = new VaultService(db, audit, { kdf: opts.kdf ?? FAST_KDF, now: clock, quick: opts.quick })
  return { db, audit, vault, now, clipboard: opts.clipboard }
}

/** Every audit row as one JSON string, for "no secret value" asserts. */
export function auditRows(db: Db): string {
  return JSON.stringify(db.prepare('SELECT * FROM audit_events ORDER BY id').all())
}

/**
 * Rewrites a fresh setup the way vaults were keyed before the wrapped scheme: KEK =
 * deriveKek(password, kdf_params), each vault key sealed by it (the vaults must be empty: their
 * keys are replaced), kdf_params on every row and no password wrap. Ends unlocked on that KEK.
 */
export async function seedLegacy(f: VaultFixture, password: string): Promise<void> {
  const params = newKdfParams(FAST_KDF)
  const kek = await deriveKek(password, params)
  const ids = (f.db.prepare('SELECT id FROM vaults').all() as { id: string }[]).map((r) => r.id)
  for (const id of ids) {
    f.db
      .prepare('UPDATE vaults SET wrapped_key = ?, kdf_params = ? WHERE id = ?')
      .run(seal(kek, randomKey(), `vault:${id}`), JSON.stringify(params), id)
  }
  f.db.prepare('UPDATE vault_state SET password_wrap = NULL, password_kdf = NULL WHERE id = 1').run()
  kek.fill(0)
  f.vault.lock('manual')
  if (!(await f.vault.unlock(password)).ok) throw new Error('legacy seed did not unlock')
}
