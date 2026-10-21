import { randomUUID } from 'node:crypto'
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_VAULT_ID,
  MAX_MASTER_PASSWORD,
  MAX_VAULT_NAME,
  MIN_MASTER_PASSWORD,
  VAULT_COLOR,
  VAULT_LOCKED,
  VAULT_RESET_CONFIRM,
  type LockReason,
  type QuickUnlockMode,
  type UnlockResult,
  type VaultInput,
  type VaultMeta,
  type VaultStatus,
} from '../../shared/vault'
import { parseEnvTemplate, stripEnvSecretRefs } from '../../shared/deploy'
import { SETTINGS } from '../../shared/settings'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { redact } from '../security/redact'
import { checkHexColor } from '../util/checks'
import { DEFAULT_KDF, deriveKek, newKdfParams, openSealed, randomKey, seal, type KdfParams } from './crypto'

/** Electron-backed unlock helpers, injected so tests can fake them (used by quick unlock). */
export interface QuickUnlockDeps {
  keychain: { available(): boolean; encrypt(plain: string): Buffer; decrypt(blob: Buffer): string } // safeStorage
  touchId: { available(): boolean; prompt(reason: string): Promise<void> } // systemPreferences
}

const MAX_UNLOCK_DELAY_MS = 300_000
const TOUCH_ID_REASON = 'unlock your OpsDeck vaults'
const KEK_BYTES = 32

/** Wait required after `failures` consecutive wrong passwords. */
export function unlockDelayMs(failures: number): number {
  if (failures < 3) return 0
  return Math.min(1000 * 2 ** (failures - 3), MAX_UNLOCK_DELAY_MS)
}

type Failure = Extract<UnlockResult, { ok: false }>
type Verified = { ok: true; kek: Buffer; keys: Map<string, Buffer>; corrupt: string[] }

type Opened = { keys: Map<string, Buffer>; corrupt: string[] }

const CANCELLED: Failure = { ok: false, reason: 'cancelled', retryAfterMs: 0 }
const UNAVAILABLE: Failure = { ok: false, reason: 'unavailable', retryAfterMs: 0 }

interface VaultRow {
  id: string
  name: string
  color: string
  created_at: string
  updated_at: string
  secrets: number
  keys: number
  identities: number
}

interface StateRow {
  failed_attempts: number
  last_failed_at: string | null
  quick_unlock: QuickUnlockMode
  quick_unlock_blob: string | null
  auto_lock_minutes: number | null
}

const META_SQL = `SELECT v.id, v.name, v.color, v.created_at, v.updated_at,
    (SELECT COUNT(*) FROM secrets WHERE vault_id = v.id) AS secrets,
    (SELECT COUNT(*) FROM ssh_keys WHERE vault_id = v.id) AS keys,
    (SELECT COUNT(*) FROM identities WHERE vault_id = v.id) AS identities
  FROM vaults v`

const wrapAad = (vaultId: string): string => `vault:${vaultId}`

function toMeta(r: VaultRow): VaultMeta {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    isDefault: r.id === DEFAULT_VAULT_ID,
    counts: { secrets: Number(r.secrets), keys: Number(r.keys), identities: Number(r.identities) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function checkPassword(password: string, isNew: boolean): void {
  if (password.length > MAX_MASTER_PASSWORD) throw new Error('password too long')
  if (isNew && password.length < MIN_MASTER_PASSWORD) throw new Error('password too short')
}

function zero(...bufs: (Buffer | Iterable<Buffer>)[]): void {
  for (const b of bufs) {
    if (Buffer.isBuffer(b)) b.fill(0)
    else for (const k of b) k.fill(0)
  }
}

export class VaultService {
  private readonly kdf: Omit<KdfParams, 'salt'>
  private readonly now: () => Date
  private readonly quick: QuickUnlockDeps | undefined
  /** Key-encryption key derived from the master password; null while locked. */
  private kek: Buffer | null = null
  private readonly keys = new Map<string, Buffer>()
  /** Keyed vaults whose wrapped key failed to open at unlock (Default opened, so not a wrong password). */
  private corrupt: string[] = []
  /** Bumped by every lock(); a password operation that saw it change while awaiting scrypt is abandoned. */
  private epoch = 0
  private readonly known = new Map<string, readonly string[]>()
  private readonly lockListeners = new Set<(reason: LockReason) => unknown>()
  private readonly unlockListeners = new Set<() => unknown>()
  private readonly resetListeners = new Set<() => void>()
  /** Set by install() on a locked-to-unlocked transition; serial() fires the unlock listeners once the section resolves. */
  private unlockedPending = false
  /** Chains password operations so the throttle check and failure count cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    opts: { kdf?: Omit<KdfParams, 'salt'>; now?: () => Date; quick?: QuickUnlockDeps } = {},
  ) {
    this.kdf = opts.kdf ?? DEFAULT_KDF
    this.now = opts.now ?? ((): Date => new Date())
    this.quick = opts.quick
  }

  status(): VaultStatus {
    const s = this.state()
    return {
      setUp: this.isSetUp(),
      unlocked: this.isUnlocked(),
      quickUnlock: s.quick_unlock,
      quickUnlockAvailable: { touchId: this.modeAvailable('touchId'), login: this.modeAvailable('login') },
      autoLockMinutes: s.auto_lock_minutes,
      retryAfterMs: this.retryAfterMs(s),
      corruptVaultIds: this.kek ? [...this.corrupt] : [],
    }
  }

  isUnlocked(): boolean {
    return this.kek !== null
  }

  assertUnlocked(): void {
    if (!this.kek) throw new Error(VAULT_LOCKED)
  }

  setup(password: string): Promise<VaultStatus> {
    return this.serial(async () => {
      if (this.isSetUp()) throw new Error('already set up')
      checkPassword(password, true)
      const epoch = this.epoch
      const params = newKdfParams(this.kdf)
      const kek = await deriveKek(password, params)
      if (epoch !== this.epoch) {
        kek.fill(0)
        throw new Error(VAULT_LOCKED)
      }
      const keys = new Map<string, Buffer>()
      try {
        this.tx(() => {
          const rows = this.db.prepare('SELECT id FROM vaults WHERE wrapped_key IS NULL').all() as { id: string }[]
          const ts = this.now().toISOString()
          for (const { id } of rows) {
            const key = randomKey()
            keys.set(id, key)
            this.db
              .prepare('UPDATE vaults SET wrapped_key = ?, kdf_params = ?, updated_at = ? WHERE id = ?')
              .run(seal(kek, key, wrapAad(id)), JSON.stringify(params), ts, id)
          }
          this.resetFailures()
        })
      } catch (err) {
        zero(kek, keys.values())
        throw err
      }
      this.install(kek, keys, [])
      this.audit.append({ action: 'vault.setup', outcome: 'success', details: { vaults: keys.size } })
      return this.status()
    })
  }

  unlock(password: string): Promise<UnlockResult> {
    return this.serial(async () => {
      if (!this.isSetUp()) throw new Error('not set up')
      checkPassword(password, false)
      const res = await this.verify(password, this.epoch)
      if (!res.ok) {
        this.audit.append({
          action: 'vault.unlock',
          outcome: res.reason === 'throttled' ? 'denied' : 'failure',
          details: { method: 'password', reason: res.reason },
        })
        return res
      }
      this.install(res.kek, res.keys, res.corrupt)
      this.audit.append({
        action: 'vault.unlock',
        outcome: 'success',
        details: { method: 'password', ...(res.corrupt.length ? { corrupt: res.corrupt } : {}) },
      })
      return { ok: true }
    })
  }

  /**
   * Unlocks with the KEK cached in the OS keychain, after a Touch ID prompt in that mode. The
   * cache is checked against the Default vault; one that no longer opens it is discarded and the
   * result is 'unavailable', so the user falls back to the password. Never counts as a failure.
   */
  unlockQuick(): Promise<UnlockResult> {
    return this.serial(async () => {
      if (!this.isSetUp()) throw new Error('not set up')
      if (this.kek) return { ok: true }
      const { quick_unlock: mode, quick_unlock_blob: blob } = this.state()
      const fail = (reason: string, res: Failure): Failure => {
        this.audit.append({ action: 'vault.unlock', outcome: 'failure', details: { method: mode, reason } })
        return res
      }
      if (mode === 'off' || !blob) return UNAVAILABLE
      // Possibly temporary (e.g. a closed laptop lid hides Touch ID): keep the cache.
      if (!this.modeAvailable(mode)) return fail('unavailable', UNAVAILABLE)
      const epoch = this.epoch
      if (mode === 'touchId') {
        try {
          await this.quick!.touchId.prompt(TOUCH_ID_REASON)
        } catch {
          return fail('cancelled', CANCELLED)
        }
        // A lock during the prompt must not reach the keychain (nor discard a good cache).
        if (epoch !== this.epoch) return fail('cancelled', CANCELLED)
      }
      let kek: Buffer
      try {
        kek = Buffer.from(this.quick!.keychain.decrypt(Buffer.from(blob, 'base64')), 'base64')
      } catch {
        this.discardQuickUnlock()
        return fail('cache-unreadable', UNAVAILABLE)
      }
      if (epoch !== this.epoch) {
        kek.fill(0)
        return fail('cancelled', CANCELLED)
      }
      const opened = kek.length === KEK_BYTES ? this.openAll(kek) : null
      if (!opened) {
        kek.fill(0)
        this.discardQuickUnlock()
        return fail('cache-stale', UNAVAILABLE)
      }
      // The OS vouched for the user (Touch ID, or the login keychain), so the password backoff restarts.
      this.resetFailures()
      this.install(kek, opened.keys, opened.corrupt)
      this.audit.append({
        action: 'vault.unlock',
        outcome: 'success',
        details: { method: mode, ...(opened.corrupt.length ? { corrupt: opened.corrupt } : {}) },
      })
      return { ok: true }
    })
  }

  /**
   * Caches the live KEK in the OS keychain for `mode`, or clears the cache for 'off'. 'login' is
   * refused: it would unlock with no prompt at all, defeating the app's auth gate. An
   * existing 'login' row can still be turned off.
   */
  setQuickUnlock(mode: QuickUnlockMode): VaultStatus {
    if (mode === 'login') throw new Error('login quick unlock is not offered')
    this.assertUnlocked()
    if (mode === 'off') {
      this.db.prepare("UPDATE vault_state SET quick_unlock = 'off', quick_unlock_blob = NULL WHERE id = 1").run()
    } else {
      if (!this.modeAvailable(mode)) throw new Error('quick unlock unavailable')
      this.db
        .prepare('UPDATE vault_state SET quick_unlock = ?, quick_unlock_blob = ? WHERE id = 1')
        .run(mode, this.cacheBlob(this.kek!))
    }
    this.audit.append({ action: 'vault.quickunlock', outcome: 'success', details: { mode } })
    return this.status()
  }

  autoLockMinutes(): number | null {
    const row = this.db.prepare('SELECT auto_lock_minutes FROM vault_state WHERE id = 1').get() as {
      auto_lock_minutes: number | null
    }
    return row.auto_lock_minutes
  }

  /** Not secret, so allowed while locked. */
  setAutoLock(minutes: number | null): VaultStatus {
    if (!(AUTO_LOCK_CHOICES as readonly (number | null)[]).includes(minutes)) {
      throw new Error(`auto-lock must be one of ${AUTO_LOCK_CHOICES.map((m) => m ?? 'never').join(', ')}`)
    }
    this.db.prepare('UPDATE vault_state SET auto_lock_minutes = ? WHERE id = 1').run(minutes)
    this.audit.append({ action: 'vault.autolock', outcome: 'success', details: { minutes } })
    return this.status()
  }

  lock(reason: LockReason): void {
    this.epoch++
    this.unlockedPending = false
    if (!this.kek) return
    zero(this.kek, this.keys.values())
    this.kek = null
    this.keys.clear()
    this.corrupt = []
    this.known.clear()
    try {
      this.audit.append({ action: 'vault.lock', outcome: 'success', details: { reason } })
    } finally {
      for (const fn of this.lockListeners) {
        this.runListener('lock', () => fn(reason))
      }
    }
  }

  onLock(fn: (reason: LockReason) => unknown): () => void {
    this.lockListeners.add(fn)
    return () => this.lockListeners.delete(fn)
  }

  /** Fires after each transition from locked to unlocked: setup, password or quick unlock. */
  onUnlock(fn: () => unknown): () => void {
    this.unlockListeners.add(fn)
    return () => this.unlockListeners.delete(fn)
  }

  /**
   * Fires once a reset is confirmed, just before the erase: whatever the old password guarded and
   * outlives a lock (live sessions, tunnels, running deploys) is stopped before its secrets go, and
   * is gone before the gate opens on setup. Synchronous on purpose: reset() does not wait for a
   * promise, so teardown can't be deferred past the erase. An erase that then fails leaves
   * everything stopped and the secrets as they were.
   */
  onBeforeReset(fn: () => void): () => void {
    this.resetListeners.add(fn)
    return () => this.resetListeners.delete(fn)
  }

  changePassword(current: string, next: string): Promise<UnlockResult> {
    return this.serial(async () => {
      this.assertUnlocked()
      checkPassword(current, false)
      checkPassword(next, true)
      const epoch = this.epoch
      const res = await this.verify(current, epoch)
      if (!res.ok) {
        this.audit.append({ action: 'vault.rekey', outcome: 'failure', details: { reason: res.reason } })
        return res
      }
      // Only a password check: re-wrap the live keys, which include any vault created meanwhile.
      zero(res.kek, res.keys.values())
      const params = newKdfParams(this.kdf)
      const kek = await deriveKek(next, params)
      if (epoch !== this.epoch) {
        kek.fill(0)
        this.audit.append({ action: 'vault.rekey', outcome: 'failure', details: { reason: 'cancelled' } })
        return CANCELLED
      }
      // A cache of the old KEK would be stale: refresh it, or turn quick unlock off if we cannot.
      const mode = this.state().quick_unlock
      let blob: string | null = null
      if (mode !== 'off') {
        try {
          if (this.quick?.keychain.available()) blob = this.cacheBlob(kek)
        } catch {
          blob = null
        }
      }
      try {
        this.tx(() => {
          if (mode !== 'off') {
            this.db
              .prepare('UPDATE vault_state SET quick_unlock = ?, quick_unlock_blob = ? WHERE id = 1')
              .run(blob ? mode : 'off', blob)
          }
          const keyed = this.db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE wrapped_key IS NOT NULL').get() as {
            n: number
          }
          // Corrupt vaults keep their old wrapping: their key is gone either way.
          if (Number(keyed.n) !== this.keys.size + this.corrupt.length) throw new Error('vault keys out of sync')
          const ts = this.now().toISOString()
          for (const [id, key] of this.keys) {
            this.db
              .prepare('UPDATE vaults SET wrapped_key = ?, kdf_params = ?, updated_at = ? WHERE id = ?')
              .run(seal(kek, key, wrapAad(id)), JSON.stringify(params), ts, id)
          }
        })
      } catch (err) {
        kek.fill(0)
        this.audit.append({ action: 'vault.rekey', outcome: 'failure', details: { reason: 'write-failed' } })
        throw err
      }
      this.kek!.fill(0)
      this.kek = kek
      this.audit.append({ action: 'vault.rekey', outcome: 'success', details: { vaults: this.keys.size } })
      if (mode !== 'off' && !blob) {
        this.audit.append({ action: 'vault.quickunlock', outcome: 'info', details: { mode: 'off', reason: 'rekey' } })
      }
      return { ok: true }
    })
  }

  /**
   * The forgotten-password way out: erases every secret, key and identity in every vault, unkeys
   * the vaults (so the next step is setup) and turns quick unlock off. Vault names and the
   * inventory stay; its references to identities, and deploy and integration references to
   * secrets, are cleared. Only while locked: an unlocked user changes the password instead. The
   * audit log is kept.
   */
  reset(confirm: string): Promise<VaultStatus> {
    return this.serial(async () => {
      if (confirm !== VAULT_RESET_CONFIRM) throw new Error(`type ${VAULT_RESET_CONFIRM} to confirm`)
      if (this.kek) throw new Error('vaults are unlocked: change the master password in settings instead')
      // Never set up: nothing to erase, and nothing worth an audit row.
      if (!this.isSetUp()) return this.status()
      for (const fn of [...this.resetListeners]) this.runListener('reset', fn)
      let counts = { vaults: 0, items: 0, deployRefs: 0, managedEnvOff: 0, integrationRefs: 0 }
      this.tx(() => {
        const n = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n)
        counts.vaults = n('SELECT COUNT(*) AS n FROM vaults')
        counts.items = n('SELECT (SELECT COUNT(*) FROM secrets) + (SELECT COUNT(*) FROM ssh_keys) + (SELECT COUNT(*) FROM identities) AS n')
        const changed = (sql: string, ...args: (string | number)[]): number => Number(this.db.prepare(sql).run(...args).changes)
        const ts = this.now().toISOString()
        // Inventory that points at identities: cleared, not deleted (the FKs say SET NULL; done
        // explicitly so it holds with foreign_keys off too, and so updated_at moves).
        this.db.prepare('UPDATE hosts SET identity_id = NULL, updated_at = ? WHERE identity_id IS NOT NULL').run(ts)
        this.db
          .prepare('UPDATE environments SET default_identity_id = NULL, updated_at = ? WHERE default_identity_id IS NOT NULL')
          .run(ts)
        // Deploy and integration settings that point at secrets: cleared too, so none dangles (done
        // explicitly, as above). An env template with secret references keeps its keys with those
        // values emptied, and its managed .env goes off, so a deploy before the secrets are linked
        // again leaves the host's .env alone. The audit row gets the counts, never the ids.
        counts.deployRefs = changed('UPDATE deployments SET become_secret_id = NULL, updated_at = ? WHERE become_secret_id IS NOT NULL', ts)
        const templates = this.db
          .prepare("SELECT id, env_template FROM deployments WHERE env_template LIKE '%${secret:%'")
          .all() as { id: string; env_template: string }[]
        const strip = this.db.prepare('UPDATE deployments SET env_template = ?, managed_env = 0, updated_at = ? WHERE id = ?')
        for (const t of templates) {
          if (parseEnvTemplate(t.env_template).secretIds.length === 0) continue
          strip.run(stripEnvSecretRefs(t.env_template), ts, t.id)
          counts.deployRefs++
          counts.managedEnvOff++
        }
        counts.integrationRefs = changed(
          'UPDATE environment_integrations SET teams_webhook_secret_id = NULL, updated_at = ? WHERE teams_webhook_secret_id IS NOT NULL',
          ts,
        )
        const keys = [SETTINGS.aiApiKeySecretId, SETTINGS.sendgridApiKeySecretId, SETTINGS.githubTokenSecretId]
        counts.integrationRefs += changed(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys)
        // Identities reference keys, so they go first.
        for (const table of ['identities', 'ssh_keys', 'secrets']) this.db.prepare(`DELETE FROM ${table}`).run()
        this.db.prepare('UPDATE vaults SET wrapped_key = NULL, kdf_params = NULL, updated_at = ?').run(ts)
        this.db
          .prepare(
            "UPDATE vault_state SET quick_unlock = 'off', quick_unlock_blob = NULL, failed_attempts = 0, last_failed_at = NULL WHERE id = 1",
          )
          .run()
        // In the same transaction: an erase is never left unaudited, nor an audit row unerased.
        this.audit.appendInTx({ action: 'vault.reset', outcome: 'success', details: counts })
      })
      // Locked already, so nothing should be live; drop it anyway and abandon any password work in flight.
      this.epoch++
      this.unlockedPending = false
      if (this.kek) zero(this.kek)
      zero(this.keys.values())
      this.kek = null
      this.keys.clear()
      this.corrupt = []
      this.known.clear()
      return this.status()
    })
  }

  /** Works while locked: names, colors and counts are not secret. Default first, then by name. */
  listVaults(): VaultMeta[] {
    const rows = this.db
      .prepare(`${META_SQL} ORDER BY (v.id = ?) DESC, v.name COLLATE NOCASE, v.id`)
      .all(DEFAULT_VAULT_ID) as unknown as VaultRow[]
    return rows.map(toMeta)
  }

  createVault(input: VaultInput): VaultMeta {
    this.assertUnlocked()
    const name = this.checkName(input.name)
    const color = checkColor(input.color)
    const master = this.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as {
      kdf_params: string
    }
    const id = randomUUID()
    const key = randomKey()
    const ts = this.now().toISOString()
    this.db
      .prepare('INSERT INTO vaults(id, name, color, wrapped_key, kdf_params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, color, seal(this.kek!, key, wrapAad(id)), master.kdf_params, ts, ts)
    this.keys.set(id, key)
    this.audit.append({
      action: 'vault.create',
      outcome: 'success',
      targetType: 'vault',
      targetId: id,
      targetLabel: name,
      details: { color },
    })
    return this.meta(id)
  }

  updateVault(id: string, patch: Partial<VaultInput>): VaultMeta {
    this.assertUnlocked()
    const before = this.meta(id)
    const name = patch.name === undefined ? before.name : this.checkName(patch.name, id)
    const color = patch.color === undefined ? before.color : checkColor(patch.color)
    const fields = [name !== before.name && 'name', color !== before.color && 'color'].filter(Boolean)
    if (fields.length === 0) return before
    this.db
      .prepare('UPDATE vaults SET name = ?, color = ?, updated_at = ? WHERE id = ?')
      .run(name, color, this.now().toISOString(), id)
    this.audit.append({
      action: 'vault.update',
      outcome: 'success',
      targetType: 'vault',
      targetId: id,
      targetLabel: name,
      details: { fields, ...(name !== before.name ? { from: before.name } : {}) },
    })
    return this.meta(id)
  }

  /** Removes the vault and everything in it: identities first (they may reference keys), then keys, then secrets. */
  deleteVault(id: string): void {
    this.assertUnlocked()
    if (id === DEFAULT_VAULT_ID) throw new Error('cannot delete the Default vault')
    const before = this.meta(id)
    this.tx(() => {
      for (const table of ['identities', 'ssh_keys', 'secrets']) {
        this.db.prepare(`DELETE FROM ${table} WHERE vault_id = ?`).run(id)
      }
      this.db.prepare('DELETE FROM vaults WHERE id = ?').run(id)
    })
    this.keys.get(id)?.fill(0)
    this.keys.delete(id)
    this.corrupt = this.corrupt.filter((c) => c !== id)
    this.audit.append({
      action: 'vault.delete',
      outcome: 'success',
      targetType: 'vault',
      targetId: id,
      targetLabel: before.name,
      details: { counts: before.counts },
    })
  }

  seal(vaultId: string, aad: string, plaintext: string): string {
    return seal(this.vaultKey(vaultId), plaintext, aad)
  }

  open(vaultId: string, aad: string, sealed: string): string {
    return openSealed(this.vaultKey(vaultId), sealed, aad).toString('utf8')
  }

  /**
   * Decrypted values the stores hold, for redaction. Each store replaces its own `source` entry;
   * everything is dropped on lock, and registering while locked is ignored.
   */
  registerKnown(source: string, values: readonly string[]): void {
    if (!this.kek) return
    this.known.set(
      source,
      values.filter((s) => s.length > 0),
    )
  }

  /** Every registered value, or only `source`'s; [] while locked. */
  knownValues(source?: string): readonly string[] {
    if (!this.kek) return []
    if (source !== undefined) return this.known.get(source) ?? []
    return [...this.known.values()].flat()
  }

  /** True for a keyed vault whose key failed to open at unlock: its contents cannot be used. */
  isCorrupt(vaultId: string): boolean {
    return this.corrupt.includes(vaultId)
  }

  private vaultKey(vaultId: string): Buffer {
    this.assertUnlocked()
    const key = this.keys.get(vaultId)
    if (!key) throw new Error(this.corrupt.includes(vaultId) ? 'vault key is corrupt' : 'vault not found')
    return key
  }

  private meta(id: string): VaultMeta {
    const row = this.db.prepare(`${META_SQL} WHERE v.id = ?`).get(id) as VaultRow | undefined
    if (!row) throw new Error('vault not found')
    return toMeta(row)
  }

  private checkName(raw: string, selfId = ''): string {
    const name = raw.trim()
    if (name.length === 0 || name.length > MAX_VAULT_NAME) {
      throw new Error(`vault name must be 1-${MAX_VAULT_NAME} characters`)
    }
    // The column is COLLATE NOCASE, so = compares case-insensitively.
    const clash = this.db.prepare('SELECT 1 FROM vaults WHERE name = ? AND id <> ?').get(name, selfId)
    if (clash) throw new Error('a vault with that name already exists')
    return name
  }

  private isSetUp(): boolean {
    const row = this.db.prepare('SELECT wrapped_key FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as
      | { wrapped_key: string | null }
      | undefined
    return row?.wrapped_key != null
  }

  private state(): StateRow {
    return this.db
      .prepare('SELECT failed_attempts, last_failed_at, quick_unlock, quick_unlock_blob, auto_lock_minutes FROM vault_state WHERE id = 1')
      .get() as unknown as StateRow
  }

  private retryAfterMs(s: StateRow = this.state()): number {
    if (!s.last_failed_at) return 0
    const elapsed = this.now().getTime() - Date.parse(s.last_failed_at)
    return Math.max(0, unlockDelayMs(Number(s.failed_attempts)) - Math.max(0, elapsed))
  }

  private resetFailures(): void {
    this.db.prepare('UPDATE vault_state SET failed_attempts = 0, last_failed_at = NULL WHERE id = 1').run()
  }

  /**
   * The throttled password check shared by unlock and changePassword. On success the caller owns
   * the returned buffers. Only the Default vault's unwrap decides a wrong password; another vault
   * that fails to open is reported as corrupt. A lock() since `epoch` abandons the attempt uncounted.
   */
  private async verify(password: string, epoch: number): Promise<Verified | Failure> {
    const wait = this.retryAfterMs()
    if (wait > 0) return { ok: false, reason: 'throttled', retryAfterMs: wait }
    const master = this.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as {
      kdf_params: string | null
    }
    if (!master.kdf_params) throw new Error('invalid kdf params')
    const kek = await deriveKek(password, JSON.parse(master.kdf_params) as KdfParams)
    if (epoch !== this.epoch) {
      kek.fill(0)
      return CANCELLED
    }
    // Read after the await: a vault created during derivation must be included.
    const opened = this.openAll(kek)
    if (!opened) {
      kek.fill(0)
      this.db
        .prepare('UPDATE vault_state SET failed_attempts = failed_attempts + 1, last_failed_at = ? WHERE id = 1')
        .run(this.now().toISOString())
      return { ok: false, reason: 'wrong-password', retryAfterMs: this.retryAfterMs() }
    }
    this.resetFailures()
    return { ok: true, kek, ...opened }
  }

  /** Unwraps every keyed vault with `kek`; null (nothing kept) when the Default vault does not open. */
  private openAll(kek: Buffer): Opened | null {
    const rows = this.db
      .prepare('SELECT id, wrapped_key FROM vaults WHERE wrapped_key IS NOT NULL ORDER BY (id = ?) DESC, id')
      .all(DEFAULT_VAULT_ID) as { id: string; wrapped_key: string }[]
    const keys = new Map<string, Buffer>()
    const corrupt: string[] = []
    for (const r of rows) {
      try {
        keys.set(r.id, openSealed(kek, r.wrapped_key, wrapAad(r.id)))
      } catch {
        if (r.id !== DEFAULT_VAULT_ID) {
          corrupt.push(r.id)
          continue
        }
        zero(keys.values())
        return null
      }
    }
    return { keys, corrupt }
  }

  /** Touch ID mode also needs the keychain: that is where its cache lives. */
  private modeAvailable(mode: Exclude<QuickUnlockMode, 'off'>): boolean {
    if (!this.quick?.keychain.available()) return false
    return mode === 'login' || this.quick.touchId.available()
  }

  /** The keychain-encrypted KEK as stored in quick_unlock_blob. Never log or audit it. */
  private cacheBlob(kek: Buffer): string {
    return this.quick!.keychain.encrypt(kek.toString('base64')).toString('base64')
  }

  private discardQuickUnlock(): void {
    this.db.prepare("UPDATE vault_state SET quick_unlock = 'off', quick_unlock_blob = NULL WHERE id = 1").run()
    this.audit.append({ action: 'vault.quickunlock', outcome: 'info', details: { mode: 'off', reason: 'discarded' } })
  }

  private install(kek: Buffer, keys: Map<string, Buffer>, corrupt: string[]): void {
    if (this.kek) zero(this.kek, this.keys.values())
    else this.unlockedPending = true
    this.keys.clear()
    this.kek = kek
    this.corrupt = corrupt
    for (const [id, key] of keys) this.keys.set(id, key)
  }

  private tx(fn: () => void): void {
    inTransaction(this.db, fn)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn).finally(() => this.fireUnlocked())
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Once per transition, and only if no lock() came first. */
  private fireUnlocked(): void {
    if (!this.unlockedPending) return
    this.unlockedPending = false
    for (const fn of [...this.unlockListeners]) {
      this.runListener('unlock', fn)
    }
  }

  /** A listener that throws or rejects is logged redacted and never stops the others. */
  private runListener(what: 'lock' | 'unlock' | 'reset', fn: () => unknown): void {
    const fail = (err: unknown): void => {
      console.error(`vault ${what} listener failed:`, redact(err instanceof Error ? err.message : String(err), this.knownValues()))
    }
    try {
      const out = fn()
      if (out instanceof Promise) out.catch(fail)
    } catch (err) {
      fail(err)
    }
  }
}

function checkColor(color: string): string {
  return checkHexColor(color, 'vault', VAULT_COLOR)
}
