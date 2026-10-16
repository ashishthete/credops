import { randomUUID } from 'node:crypto'
import {
  CLIPBOARD_CLEAR_MS,
  MAX_SECRET_NAME,
  MAX_SECRET_VALUE,
  SECRET_KINDS,
  VAULT_LOCKED,
  type SecretInput,
  type SecretKind,
  type SecretMeta,
  type SecretPatch,
} from '../../shared/vault'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import type { ClipboardLike } from './types'
import type { VaultService } from './vault-service'

/** The VaultService known-values source this store owns. */
const KNOWN_SOURCE = 'secrets'

interface SecretRow {
  id: string
  vault_id: string
  name: string
  kind: SecretKind
  value_enc: string
  created_at: string
  updated_at: string
}

interface Copied {
  value: string
  /** Date.now() at which the clear is due. */
  deadline: number
  timer: ReturnType<typeof setTimeout>
}

const valueAad = (id: string): string => `secret:${id}:value`

function toMeta(r: SecretRow): SecretMeta {
  return { id: r.id, vaultId: r.vault_id, name: r.name, kind: r.kind, createdAt: r.created_at, updatedAt: r.updated_at }
}

function checkKind(kind: string): SecretKind {
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`secret kind must be one of ${SECRET_KINDS.join(', ')}`)
  }
  return kind as SecretKind
}

/** The message never carries the value. */
function checkValue(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_VALUE) {
    throw new Error(`secret value must be 1-${MAX_SECRET_VALUE} characters`)
  }
  return value
}

/**
 * Secrets in the vaults. Metadata is readable while locked; values are sealed per vault with
 * AAD `secret:<id>:value` and leave main only through reveal (audited) and copy (audited,
 * clipboard self-clears). Decrypted values are registered with the vault for redaction.
 */
export class SecretStore {
  private readonly clipboard: ClipboardLike
  /** What copy() last put on the clipboard, until it is cleared. */
  private copied: Copied | null = null
  /** Clipboard writes and clears still running, for flushClipboard(). */
  private readonly inflight = new Set<Promise<unknown>>()
  /** Whether this unlock's values are registered with the vault. */
  private loaded = false
  /** Bumped on every lock, so a copy can tell a lock happened while its write was pending. */
  private locks = 0

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
    deps: { clipboard: ClipboardLike },
  ) {
    this.clipboard = deps.clipboard
    vault.onLock(() => {
      this.locks++
      this.loaded = false
      void this.clearClipboard()
    })
  }

  /** Works while locked: names and kinds are not secret. Sorted by name. */
  list(vaultId?: string): SecretMeta[] {
    const order = 'ORDER BY name COLLATE NOCASE, name, id'
    const rows = (
      vaultId === undefined
        ? this.db.prepare(`SELECT * FROM secrets ${order}`).all()
        : this.db.prepare(`SELECT * FROM secrets WHERE vault_id = ? ${order}`).all(vaultId)
    ) as unknown as SecretRow[]
    return rows.map(toMeta)
  }

  create(input: SecretInput): SecretMeta {
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    const name = this.checkName(input.vaultId, input.name)
    const kind = checkKind(input.kind)
    const id = randomUUID()
    const enc = this.vault.seal(input.vaultId, valueAad(id), checkValue(input.value))
    const ts = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO secrets(id, vault_id, name, kind, value_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, input.vaultId, name, kind, enc, ts, ts)
    this.refreshKnown()
    this.audit.append({
      action: 'secret.create',
      outcome: 'success',
      targetType: 'secret',
      targetId: id,
      targetLabel: name,
      details: { kind },
    })
    return toMeta(this.row(id))
  }

  /** An omitted value keeps the stored ciphertext. */
  update(id: string, patch: SecretPatch): SecretMeta {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    const name = patch.name === undefined ? before.name : this.checkName(before.vault_id, patch.name, id)
    const kind = patch.kind === undefined ? before.kind : checkKind(patch.kind)
    const enc =
      patch.value === undefined
        ? before.value_enc
        : this.vault.seal(before.vault_id, valueAad(id), checkValue(patch.value))
    const fields = [
      name !== before.name && 'name',
      kind !== before.kind && 'kind',
      patch.value !== undefined && 'value',
    ].filter(Boolean)
    if (fields.length === 0) return toMeta(before)
    this.db
      .prepare('UPDATE secrets SET name = ?, kind = ?, value_enc = ?, updated_at = ? WHERE id = ?')
      .run(name, kind, enc, new Date().toISOString(), id)
    if (patch.value !== undefined) this.refreshKnown()
    this.audit.append({
      action: 'secret.update',
      outcome: 'success',
      targetType: 'secret',
      targetId: id,
      targetLabel: name,
      details: { fields },
    })
    return toMeta(this.row(id))
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id)
    this.refreshKnown()
    this.audit.append({
      action: 'secret.delete',
      outcome: 'success',
      targetType: 'secret',
      targetId: id,
      targetLabel: before.name,
      details: { kind: before.kind },
    })
  }

  reveal(id: string): { value: string } {
    const { row, value } = this.decrypt(id)
    this.audit.append({
      action: 'secret.reveal',
      outcome: 'success',
      targetType: 'secret',
      targetId: id,
      targetLabel: row.name,
    })
    return { value }
  }

  /**
   * Puts the value on the clipboard (never returns it); it is cleared after CLIPBOARD_CLEAR_MS or
   * on lock. A lock while the write is pending clears it and rejects with VAULT_LOCKED.
   */
  async copy(id: string): Promise<{ clearsInMs: number }> {
    const { row, value } = this.decrypt(id)
    const locks = this.locks
    const prev = this.copied
    // Tracked before the write so a lock during it clears the clipboard.
    const copied = this.arm(value, CLIPBOARD_CLEAR_MS)
    this.copied = copied
    try {
      await this.track(Promise.resolve(this.clipboard.writeText(value)))
    } catch (err) {
      clearTimeout(copied.timer)
      // The previous copy is still on the clipboard: keep tracking it, and clear it if we locked meanwhile.
      const locked = locks !== this.locks
      if (this.copied === copied || (locked && !this.copied)) {
        this.copied = prev && this.arm(prev.value, Math.max(0, prev.deadline - Date.now()))
        if (locked) await this.clearClipboard()
      }
      throw err
    }
    if (prev) clearTimeout(prev.timer)
    const locked = locks !== this.locks
    // Audited even when locked meanwhile: the value did reach the clipboard.
    this.audit.append({
      action: 'secret.copy',
      outcome: 'success',
      targetType: 'secret',
      targetId: id,
      targetLabel: row.name,
      ...(locked ? { details: { reason: 'locked' } } : {}),
    })
    if (locked) {
      // The lock's clear may have read the clipboard before the write landed: check again.
      if (!this.copied) {
        this.copied = copied
        await this.clearClipboard()
      }
      throw new Error(VAULT_LOCKED)
    }
    return { clearsInMs: CLIPBOARD_CLEAR_MS }
  }

  /** Whether a copied value is still tracked or a clipboard write or clear is running. */
  clipboardPending(): boolean {
    return this.copied !== null || this.inflight.size > 0
  }

  /** Clears a tracked copy now and waits for every pending clipboard write and clear (used at quit). */
  async flushClipboard(): Promise<void> {
    while (this.clipboardPending()) {
      void this.clearClipboard()
      await Promise.allSettled([...this.inflight])
    }
  }

  /** Main-process use only (later phases): not audited and never exposed over IPC. */
  value(id: string): string {
    return this.decrypt(id).value
  }

  /** Every decrypted secret value, for redaction; [] while locked. Decrypts once per unlock. */
  knownValues(): readonly string[] {
    if (!this.vault.isUnlocked()) return []
    if (!this.loaded) this.refreshKnown()
    return this.vault.knownValues(KNOWN_SOURCE)
  }

  /** Re-registers every readable value; secrets in corrupt vaults or failing to open are skipped. */
  private refreshKnown(): void {
    if (!this.vault.isUnlocked()) return
    const rows = this.db.prepare('SELECT * FROM secrets').all() as unknown as SecretRow[]
    const values: string[] = []
    for (const r of rows) {
      if (this.vault.isCorrupt(r.vault_id)) continue
      try {
        values.push(this.vault.open(r.vault_id, valueAad(r.id), r.value_enc))
      } catch {
        // Tampered or unreadable: reveal reports it; there is nothing to redact.
      }
    }
    this.vault.registerKnown(KNOWN_SOURCE, values)
    this.loaded = true
  }

  private decrypt(id: string): { row: SecretRow; value: string } {
    this.vault.assertUnlocked()
    const row = this.row(id)
    this.assertUsable(row.vault_id)
    if (!this.loaded) this.refreshKnown()
    return { row, value: this.vault.open(row.vault_id, valueAad(id), row.value_enc) }
  }

  /** Clears the clipboard only while it still holds `target`'s value; a no-op once `target` is replaced. */
  private clearClipboard(target = this.copied): Promise<void> {
    if (!target || this.copied !== target) return Promise.resolve()
    this.copied = null
    clearTimeout(target.timer)
    return this.track(
      (async (): Promise<void> => {
        try {
          if ((await this.clipboard.readText()) === target.value) await this.clipboard.writeText('')
        } catch (err) {
          console.error('clipboard clear failed:', err instanceof Error ? err.name : 'error')
        }
      })(),
    )
  }

  private arm(value: string, ms: number): Copied {
    const copied: Copied = { value, deadline: Date.now() + ms, timer: undefined as never }
    copied.timer = setTimeout(() => void this.clearClipboard(copied), ms)
    return copied
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p)).catch(() => undefined)
    return p
  }

  private assertUsable(vaultId: string): void {
    if (this.vault.isCorrupt(vaultId)) throw new Error('vault key is corrupt')
  }

  private row(id: string): SecretRow {
    const row = this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | undefined
    if (!row) throw new Error('secret not found')
    return row
  }

  private checkName(vaultId: string, raw: string, selfId = ''): string {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name.length === 0 || name.length > MAX_SECRET_NAME) {
      throw new Error(`secret name must be 1-${MAX_SECRET_NAME} characters`)
    }
    const clash = this.db
      .prepare('SELECT 1 FROM secrets WHERE vault_id = ? AND name = ? AND id <> ?')
      .get(vaultId, name, selfId)
    if (clash) throw new Error('a secret with that name already exists in this vault')
    return name
  }
}
