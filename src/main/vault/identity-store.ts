import { randomUUID } from 'node:crypto'
import {
  IDENTITY_AUTHS,
  MAX_LABEL,
  MAX_SECRET_VALUE,
  MAX_USERNAME,
  type IdentityAuth,
  type IdentityInput,
  type IdentityMeta,
  type IdentityPatch,
} from '../../shared/vault'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { checkText } from '../util/checks'
import type { KeyStore } from './key-store'
import type { VaultService } from './vault-service'

/** The VaultService known-values source this store owns. */
const KNOWN_SOURCE = 'identities'

export type ResolvedIdentity =
  | { username: string; auth: 'agent' }
  | { username: string; auth: 'key'; privateKey: string; passphrase?: string }
  | { username: string; auth: 'password'; password: string }

interface IdentityRow {
  id: string
  vault_id: string
  label: string
  username: string
  auth: IdentityAuth
  ssh_key_id: string | null
  password_enc: string | null
  created_at: string
  updated_at: string
}

const passwordAad = (id: string): string => `identity:${id}:password`

function toMeta(r: IdentityRow): IdentityMeta {
  return {
    id: r.id,
    vaultId: r.vault_id,
    label: r.label,
    username: r.username,
    auth: r.auth,
    sshKeyId: r.ssh_key_id,
    hasPassword: r.password_enc !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function checkAuth(auth: string): IdentityAuth {
  if (!(IDENTITY_AUTHS as readonly string[]).includes(auth)) {
    throw new Error(`identity auth must be one of ${IDENTITY_AUTHS.join(', ')}`)
  }
  return auth as IdentityAuth
}

/** The message never carries the password. */
function checkPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_SECRET_VALUE) {
    throw new Error(`password must be 1-${MAX_SECRET_VALUE} characters`)
  }
  return password
}

/**
 * Login identities: a username plus agent, key (an SSH key in the same vault) or password auth.
 * Passwords are sealed per vault with AAD `identity:<id>:password`; only `password` identities
 * keep one. Material leaves the store only through resolve() (main only). Decrypted passwords are
 * registered with the vault for redaction.
 */
export class IdentityStore {
  /** Whether this unlock's passwords are registered with the vault. */
  private loaded = false

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly keys: KeyStore,
    private readonly audit: AuditLog,
  ) {
    vault.onLock(() => {
      this.loaded = false
    })
  }

  /** Works while locked: labels and usernames are not secret. Sorted by label. */
  list(vaultId?: string): IdentityMeta[] {
    const order = 'ORDER BY label COLLATE NOCASE, label, id'
    const rows = (
      vaultId === undefined
        ? this.db.prepare(`SELECT * FROM identities ${order}`).all()
        : this.db.prepare(`SELECT * FROM identities WHERE vault_id = ? ${order}`).all(vaultId)
    ) as unknown as IdentityRow[]
    return rows.map(toMeta)
  }

  create(input: IdentityInput): IdentityMeta {
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    const label = checkText(input.label, 'identity label', MAX_LABEL)
    const username = checkText(input.username, 'username', MAX_USERNAME)
    const auth = checkAuth(input.auth)
    const sshKeyId = this.checkKey(input.vaultId, auth, input.sshKeyId)
    if (auth !== 'password' && input.password !== undefined) throw new Error('a password is only for password auth')
    if (auth === 'password' && input.password === undefined) throw new Error('password auth needs a password')
    const id = randomUUID()
    const enc =
      auth === 'password' ? this.vault.seal(input.vaultId, passwordAad(id), checkPassword(input.password!)) : null
    const ts = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO identities(id, vault_id, label, username, auth, ssh_key_id, password_enc, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, input.vaultId, label, username, auth, sshKeyId, enc, ts, ts)
    if (enc !== null) this.refreshKnown()
    this.audit.append({
      action: 'identity.create',
      outcome: 'success',
      targetType: 'identity',
      targetId: id,
      targetLabel: label,
      details: { auth },
    })
    return toMeta(this.row(id))
  }

  /**
   * Omitted fields are kept. Leaving 'password' auth clears the stored password, leaving 'key'
   * clears the key link; an omitted password keeps the stored one.
   */
  update(id: string, patch: IdentityPatch): IdentityMeta {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    const label = patch.label === undefined ? before.label : checkText(patch.label, 'identity label', MAX_LABEL)
    const username =
      patch.username === undefined ? before.username : checkText(patch.username, 'username', MAX_USERNAME)
    const auth = patch.auth === undefined ? before.auth : checkAuth(patch.auth)
    const keptKey = auth === 'key' && before.auth === 'key' ? before.ssh_key_id! : undefined
    const sshKeyId = this.checkKey(before.vault_id, auth, patch.sshKeyId ?? keptKey)
    let enc: string | null = null
    if (auth !== 'password') {
      if (patch.password !== undefined) throw new Error('a password is only for password auth')
    } else if (patch.password !== undefined) {
      enc = this.vault.seal(before.vault_id, passwordAad(id), checkPassword(patch.password))
    } else if (before.password_enc !== null) {
      enc = before.password_enc
    } else {
      throw new Error('password auth needs a password')
    }
    const fields = [
      label !== before.label && 'label',
      username !== before.username && 'username',
      auth !== before.auth && 'auth',
      sshKeyId !== before.ssh_key_id && 'sshKeyId',
      (patch.password !== undefined || (enc === null && before.password_enc !== null)) && 'password',
    ].filter(Boolean)
    if (fields.length === 0) return toMeta(before)
    this.db
      .prepare(
        `UPDATE identities SET label = ?, username = ?, auth = ?, ssh_key_id = ?, password_enc = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(label, username, auth, sshKeyId, enc, new Date().toISOString(), id)
    if (enc !== before.password_enc) this.refreshKnown()
    this.audit.append({
      action: 'identity.update',
      outcome: 'success',
      targetType: 'identity',
      targetId: id,
      targetLabel: label,
      details: { fields },
    })
    return toMeta(this.row(id))
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    this.db.prepare('DELETE FROM identities WHERE id = ?').run(id)
    if (before.password_enc !== null) this.refreshKnown()
    this.audit.append({
      action: 'identity.delete',
      outcome: 'success',
      targetType: 'identity',
      targetId: id,
      targetLabel: before.label,
      details: { auth: before.auth },
    })
  }

  /** Main-process use only (Phase 4 connects with it): not audited and never exposed over IPC. */
  async resolve(id: string): Promise<ResolvedIdentity> {
    this.vault.assertUnlocked()
    const row = this.row(id)
    this.assertUsable(row.vault_id)
    const { username } = row
    if (row.auth === 'agent') return { username, auth: 'agent' }
    if (row.auth === 'key') return { username, auth: 'key', ...(await this.keys.material(row.ssh_key_id!)) }
    if (!this.loaded) this.refreshKnown()
    return { username, auth: 'password', password: this.vault.open(row.vault_id, passwordAad(id), row.password_enc!) }
  }

  /** Every decrypted password, for redaction; [] while locked. Decrypts once per unlock. */
  knownValues(): readonly string[] {
    if (!this.vault.isUnlocked()) return []
    if (!this.loaded) this.refreshKnown()
    return this.vault.knownValues(KNOWN_SOURCE)
  }

  /** The key id to store: required for 'key' auth, in the identity's vault; refused otherwise. */
  private checkKey(vaultId: string, auth: IdentityAuth, sshKeyId: string | undefined): string | null {
    if (auth !== 'key') {
      if (sshKeyId !== undefined) throw new Error('an ssh key is only for key auth')
      return null
    }
    if (sshKeyId === undefined) throw new Error('key auth needs an ssh key')
    const key = this.db.prepare('SELECT vault_id FROM ssh_keys WHERE id = ?').get(sshKeyId) as
      | { vault_id: string }
      | undefined
    if (!key) throw new Error('ssh key not found')
    if (key.vault_id !== vaultId) throw new Error('the ssh key must be in the same vault as the identity')
    return sshKeyId
  }

  /** Re-registers every readable password; identities in corrupt vaults or failing to open are skipped. */
  private refreshKnown(): void {
    if (!this.vault.isUnlocked()) return
    const rows = this.db
      .prepare('SELECT id, vault_id, password_enc FROM identities WHERE password_enc IS NOT NULL')
      .all() as { id: string; vault_id: string; password_enc: string }[]
    const values: string[] = []
    for (const r of rows) {
      if (this.vault.isCorrupt(r.vault_id)) continue
      try {
        values.push(this.vault.open(r.vault_id, passwordAad(r.id), r.password_enc))
      } catch {
        // Tampered or unreadable: resolve() reports it; there is nothing to redact.
      }
    }
    this.vault.registerKnown(KNOWN_SOURCE, values)
    this.loaded = true
  }

  private assertUsable(vaultId: string): void {
    if (!this.db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(vaultId)) throw new Error('vault not found')
    if (this.vault.isCorrupt(vaultId)) throw new Error('vault key is corrupt')
  }

  private row(id: string): IdentityRow {
    const row = this.db.prepare('SELECT * FROM identities WHERE id = ?').get(id) as IdentityRow | undefined
    if (!row) throw new Error('identity not found')
    return row
  }
}
