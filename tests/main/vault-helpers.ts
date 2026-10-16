import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase, type Db } from '../../src/main/db/connection'
import type { KdfParams } from '../../src/main/vault/crypto'
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
