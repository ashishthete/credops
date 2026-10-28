import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_VAULT_ID,
  MAX_MASTER_PASSWORD,
  MAX_VAULT_NAME,
  MIN_MASTER_PASSWORD,
  PIN_ATTEMPTS,
  PIN_WIPED,
  VAULT_COLOR,
  VAULT_RESET_CONFIRM,
  vaultLockedError,
  type LockReason,
  type QuickUnlockMode,
  type SetupOptions,
  type UnlockMethod,
  type UnlockResult,
  type VaultInput,
  type VaultMeta,
  type VaultStatus,
} from '../../shared/vault'
import { parseEnvTemplate, stripEnvSecretRefs } from '../../shared/deploy'
import { SETTINGS } from '../../shared/settings'
import type { ReverifyProof, SsoState } from '../../shared/sso'
import type { SignInGate } from '../auth/sso-gate'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { redact } from '../security/redact'
import { checkHexColor } from '../util/checks'
import { DEFAULT_KDF, deriveKek, newKdfParams, openSealed, randomKey, seal, type KdfParams } from './crypto'
import { checkPin, checkPinFormat, derivePinKey } from './pin'

/** Electron-backed unlock helpers, injected so tests can fake them (used by quick unlock). */
export interface QuickUnlockDeps {
  keychain: { available(): boolean; encrypt(plain: string): Buffer; decrypt(blob: Buffer): string } // safeStorage
  touchId: { available(): boolean; prompt(reason: string): Promise<void> } // systemPreferences
}

const MAX_UNLOCK_DELAY_MS = 300_000
const TOUCH_ID_REASON = 'unlock your CredOps vaults'
const REVERIFY_REASON = 'confirm it is you in CredOps'
const KEK_BYTES = 32
/** AAD of the KEK sealed under the master password's key (`vault_state.password_wrap`). */
const PW_AAD = 'pw:kek'
/** AAD of the KEK sealed under the PIN's key (`vault_state.pin_wrap`). */
const PIN_AAD = 'pin:kek'
/** Spec §3: every factor change leaves Touch ID or a PIN (a master password alone is not enough). */
const NEED_FACTOR = 'add Touch ID or a PIN first'
/** Preflight F4: a PIN without the Keychain pepper would be a 6-digit guess against a db copy. */
const PIN_NEEDS_KEYCHAIN = 'a PIN needs the Keychain'
/** Setup refused by the sign-in gate; the unlocks return SIGNIN_REQUIRED instead. */
const SIGN_IN_FIRST = 'sign in with Microsoft first'

/** Wait required after `failures` consecutive wrong passwords. */
export function unlockDelayMs(failures: number): number {
  if (failures < 3) return 0
  return Math.min(1000 * 2 ** (failures - 3), MAX_UNLOCK_DELAY_MS)
}

type Failure = Extract<UnlockResult, { ok: false }>
type Verified = { ok: true; kek: Buffer; keys: Map<string, Buffer>; corrupt: string[] }

type Opened = { keys: Map<string, Buffer>; corrupt: string[] }
/** The KEK sealed under a password key, with that key's scrypt params. Neither is secret alone. */
type PasswordWrap = { params: KdfParams; sealed: string }
/** The KEK sealed under the PIN key, its scrypt params, and the Keychain-encrypted pepper. */
type PinWrap = PasswordWrap & { pepperBlob: string; length: number }
/** What the spec §3 rule counts; 'touchId' is only ever removed by setQuickUnlock('off'). */
type Factor = 'password' | 'touchId' | 'pin'

const CANCELLED: Failure = { ok: false, reason: 'cancelled', retryAfterMs: 0 }
const UNAVAILABLE: Failure = { ok: false, reason: 'unavailable', retryAfterMs: 0 }
const WRONG_PIN: Failure = { ok: false, reason: 'wrong-pin', retryAfterMs: 0 }
const WIPED_PIN: Failure = { ok: false, reason: 'pin-wiped', retryAfterMs: 0 }
const SIGNIN_REQUIRED: Failure = { ok: false, reason: 'signin-required', retryAfterMs: 0 }

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
  pin_wrap: string | null
  pin_salt: string | null
  pin_pepper_blob: string | null
  pin_failed: number
  pin_length: number | null
  last_method: UnlockMethod | null
  password_wrap: string | null
  password_kdf: string | null
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

const TOUCH_ID_UNREADABLE_KEY = 'vault.touchIdUnreadable'

export class VaultService {
  private readonly kdf: Omit<KdfParams, 'salt'>
  private readonly now: () => Date
  private readonly quick: QuickUnlockDeps | undefined
  /**
   * Key-encryption key; null while locked. Random and stable for every setup since the wrapped
   * scheme (the master password, if any, only wraps it); derived from the password on a legacy vault.
   */
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
  /** Asked before every unlock and setup; null until main fits it (and then a binding fails closed). */
  private gate: SignInGate | null = null
  /**
   * The Touch ID cache failed to read at the last Touch ID unlock; cleared once it reads, is rewritten
   * or is turned off. Kept in the settings table (a flag, not a secret) so it survives a restart.
   */
  private get touchIdUnreadable(): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(TOUCH_ID_UNREADABLE_KEY) !== undefined
  }

  private set touchIdUnreadable(on: boolean) {
    if (on) {
      this.db
        .prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(TOUCH_ID_UNREADABLE_KEY, '1', this.now().toISOString())
    } else {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(TOUCH_ID_UNREADABLE_KEY)
    }
  }

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
      hasPassword: this.hasPassword(),
      pin: { enabled: s.pin_wrap !== null, attemptsLeft: Math.max(0, PIN_ATTEMPTS - s.pin_failed), ...(s.pin_wrap !== null && s.pin_length !== null ? { length: s.pin_length } : {}) },
      lastMethod: s.last_method,
      resetRequired: this.isSetUp() && !this.hasPassword() && !s.pin_wrap && !s.quick_unlock_blob,
      touchIdNeedsReenable: this.touchIdUnreadable && s.quick_unlock === 'touchId',
      sso: this.ssoState(),
    }
  }

  /** Every unlock and setup asks `gate` first; see signInOk(). */
  setSignInGate(gate: SignInGate): void {
    this.gate = gate
  }

  isUnlocked(): boolean {
    return this.kek !== null
  }

  assertUnlocked(): void {
    if (!this.kek) throw vaultLockedError()
  }

  /**
   * First run. With the Keychain, Touch ID or a PIN is mandatory and the master password optional;
   * without it (no Touch ID and no PIN can work) the master password is required. Touch ID must
   * pass one prompt before anything is derived or written.
   */
  setup(opts: SetupOptions): Promise<VaultStatus> {
    return this.serial(async () => {
      if (this.isSetUp()) throw new Error('already set up')
      // Before any Touch ID prompt or scrypt.
      this.assertSignedIn()
      const { password, pin } = opts
      const touchId = opts.touchId === true
      if (password !== undefined) checkPassword(password, true)
      if (pin !== undefined) checkPin(pin)
      if (!this.keychainAvailable()) {
        if (pin !== undefined) throw new Error(PIN_NEEDS_KEYCHAIN)
        if (touchId) throw new Error('Touch ID unavailable')
        if (password === undefined) throw new Error('a master password is required without the Keychain')
      } else if (!touchId && pin === undefined) {
        throw new Error('choose Touch ID or a PIN')
      }
      const epoch = this.epoch
      if (touchId) {
        if (!this.modeAvailable('touchId')) throw new Error('Touch ID unavailable')
        try {
          await this.quick!.touchId.prompt(TOUCH_ID_REASON)
        } catch {
          throw new Error('Touch ID was cancelled')
        }
        if (epoch !== this.epoch) throw vaultLockedError()
      }
      const kek = randomKey()
      let pwWrap: PasswordWrap | null = null
      let pinWrap: PinWrap | null = null
      let blob: string | null = null
      try {
        if (password !== undefined) {
          pwWrap = await this.passwordWrap(password, kek, epoch)
          if (!pwWrap) throw vaultLockedError()
        }
        if (pin !== undefined) {
          pinWrap = await this.pinWrap(pin, kek, epoch)
          if (!pinWrap) throw vaultLockedError()
        }
        if (touchId) blob = this.cacheBlob(kek)
        // The verdict may have turned while the prompt or scrypt ran.
        this.assertSignedIn()
      } catch (err) {
        kek.fill(0)
        throw err
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
              .prepare('UPDATE vaults SET wrapped_key = ?, kdf_params = NULL, updated_at = ? WHERE id = ?')
              .run(seal(kek, key, wrapAad(id)), ts, id)
          }
          if (pwWrap) this.writePasswordWrap(pwWrap)
          if (pinWrap) this.writePinWrap(pinWrap)
          if (blob) this.db.prepare("UPDATE vault_state SET quick_unlock = 'touchId', quick_unlock_blob = ? WHERE id = 1").run(blob)
          this.resetFailures()
        })
      } catch (err) {
        zero(kek, keys.values())
        throw err
      }
      this.install(kek, keys, [])
      const methods = [pwWrap && 'password', pinWrap && 'pin', blob && 'touchId'].filter(Boolean)
      this.audit.append({ action: 'vault.setup', outcome: 'success', details: { vaults: keys.size, methods } })
      this.noteSignedInUnlock()
      return this.status()
    })
  }

  unlock(password: string): Promise<UnlockResult> {
    return this.serial(async () => {
      if (!this.isSetUp()) throw new Error('not set up')
      checkPassword(password, false)
      // Before scrypt, so a refusal neither derives nor counts.
      if (!this.signInOk()) return this.refuseUnlock('password')
      const res = await this.verify(password, this.epoch)
      if (!res.ok) {
        this.audit.append({
          action: 'vault.unlock',
          outcome: res.reason === 'throttled' ? 'denied' : 'failure',
          details: { method: 'password', reason: res.reason },
        })
        return res
      }
      if (!this.signInOk()) {
        zero(res.kek, res.keys.values())
        return this.refuseUnlock('password')
      }
      this.noteUnlock('password')
      this.install(res.kek, res.keys, res.corrupt)
      this.audit.append({
        action: 'vault.unlock',
        outcome: 'success',
        details: { method: 'password', ...(res.corrupt.length ? { corrupt: res.corrupt } : {}) },
      })
      this.noteSignedInUnlock()
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
      // Before the Touch ID prompt and the Keychain read.
      if (!this.signInOk()) return this.refuseUnlock(mode)
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
        // Nor a verdict that turned meanwhile without a lock (a sign-out): refused before the Keychain read.
        if (!this.signInOk()) return this.refuseUnlock(mode)
      }
      let kek: Buffer
      try {
        kek = Buffer.from(this.quick!.keychain.decrypt(Buffer.from(blob, 'base64')), 'base64')
      } catch {
        // Unreadable may be a locked or briefly unavailable keychain: keep the cache. Only a blob that
        // reads but no longer holds the KEK (cache-stale below) is a definitive invalidation. If it
        // stays unreadable (a re-signed app, a Keychain reset), status asks the user to re-enable it.
        this.touchIdUnreadable = mode === 'touchId'
        return fail('cache-unreadable', UNAVAILABLE)
      }
      this.touchIdUnreadable = false
      if (epoch !== this.epoch) {
        kek.fill(0)
        return fail('cancelled', CANCELLED)
      }
      const opened = kek.length === KEK_BYTES ? this.openAll(kek) : null
      if (!opened) {
        kek.fill(0)
        // The last copy of the KEK is never discarded: keep it if nothing else can unlock.
        if (this.hasPassword() || this.pinEnabled()) this.discardQuickUnlock()
        return fail('cache-stale', UNAVAILABLE)
      }
      if (!this.signInOk()) {
        zero(kek, opened.keys.values())
        return this.refuseUnlock(mode)
      }
      // The OS vouched for the user (Touch ID, or the login keychain), so the backoffs restart.
      // An old 'login' row is not a method the column knows: last_method is left as it was.
      this.noteUnlock(mode === 'touchId' ? 'touchId' : null)
      this.install(kek, opened.keys, opened.corrupt)
      this.audit.append({
        action: 'vault.unlock',
        outcome: 'success',
        details: { method: mode, ...(opened.corrupt.length ? { corrupt: opened.corrupt } : {}) },
      })
      this.noteSignedInUnlock()
      return { ok: true }
    })
  }

  /**
   * Unlocks with the PIN: scrypt(PIN ‖ Keychain pepper) opens `pin_wrap`. A bad format is refused
   * uncounted; a miss counts, and the PIN_ATTEMPTS-th wipes the PIN. No PIN, or no readable
   * pepper, is 'unavailable' and never counts: without the pepper there is nothing to guess against.
   */
  unlockPin(pin: string): Promise<UnlockResult> {
    return this.serial(async () => {
      if (!this.isSetUp()) throw new Error('not set up')
      checkPinFormat(pin)
      if (this.kek) return { ok: true }
      // Before the pepper read and scrypt, so a refusal never counts a miss.
      if (!this.signInOk()) return this.refuseUnlock('pin')
      const res = await this.pinAttempt(pin, this.epoch)
      if (!res.ok) {
        this.audit.append({ action: 'vault.unlock', outcome: 'failure', details: { method: 'pin', reason: res.reason } })
        return res
      }
      if (!this.signInOk()) {
        zero(res.kek, res.keys.values())
        return this.refuseUnlock('pin')
      }
      this.noteUnlock('pin')
      this.install(res.kek, res.keys, res.corrupt)
      this.audit.append({
        action: 'vault.unlock',
        outcome: 'success',
        details: { method: 'pin', ...(res.corrupt.length ? { corrupt: res.corrupt } : {}) },
      })
      this.noteSignedInUnlock()
      return { ok: true }
    })
  }

  /** Sets or replaces the PIN on the live KEK; the attempt count restarts. Only while unlocked. */
  setPin(pin: string): Promise<VaultStatus> {
    return this.serial(async () => {
      this.assertUnlocked()
      checkPin(pin)
      if (!this.keychainAvailable()) throw new Error(PIN_NEEDS_KEYCHAIN)
      const replacing = this.pinEnabled()
      const wrap = await this.pinWrap(pin, this.kek!, this.epoch)
      if (!wrap) throw vaultLockedError()
      this.tx(() => this.writePinWrap(wrap))
      this.audit.append({ action: 'vault.pin', outcome: 'success', details: { op: replacing ? 'changed' : 'set' } })
      return this.status()
    })
  }

  /** Drops the PIN. Refused unless the Touch ID cache holds the live KEK (spec §3). */
  clearPin(): VaultStatus {
    this.assertUnlocked()
    if (!this.pinEnabled()) return this.status()
    if (!this.keepsAWayIn('pin')) {
      this.audit.append({ action: 'vault.pin', outcome: 'failure', details: { op: 'cleared', reason: 'no-other-factor' } })
      throw new Error(NEED_FACTOR)
    }
    this.clearPinColumns(0)
    this.audit.append({ action: 'vault.pin', outcome: 'success', details: { op: 'cleared' } })
    return this.status()
  }

  /**
   * Proves the user again while unlocked, for changes that need it; the lock state is untouched. A
   * password goes through the unlock throttle and a PIN through the unlock miss path, wipe
   * included (preflight F5). Touch ID counts only when it is set up and its cache holds the KEK.
   * A method that is not set up, or a lock meanwhile, gives false. A miss that wipes the PIN throws
   * PIN_WIPED; if that left nothing stored to unlock with, the vault locks first, so whoever was
   * guessing cannot keep it open to add a factor of their own (the spec's "locked until reset").
   * `action` names the change in the Touch ID prompt; without it the prompt is a generic one.
   */
  reverify(proof: ReverifyProof, action?: string): Promise<boolean> {
    return this.serial(async () => {
      this.assertUnlocked()
      // A disabled account proves nothing: refused before any prompt or derive, so no miss counts.
      if (this.gate?.verdict() === 'blocked') return false
      const epoch = this.epoch
      if (proof.method === 'touchId') {
        if (!this.touchIdHoldsKek()) return false
        try {
          await this.quick!.touchId.prompt(action ? `${action} in CredOps` : REVERIFY_REASON)
        } catch {
          return false
        }
        return epoch === this.epoch
      }
      let res: Verified | Failure
      if (proof.method === 'password') {
        checkPassword(proof.password, false)
        res = await this.verify(proof.password, epoch)
      } else {
        checkPinFormat(proof.pin)
        res = await this.pinAttempt(proof.pin, epoch)
      }
      if (!res.ok) {
        if (res.reason !== 'pin-wiped') return false
        if (this.wipeFallback() === 'none') this.lock('manual')
        throw new Error(PIN_WIPED)
      }
      zero(res.kek, res.keys.values())
      return epoch === this.epoch
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
      // Spec §3 counts Touch ID only; an old 'login' row just must not be the last copy of the KEK.
      const cur = this.state().quick_unlock
      const ok =
        cur === 'touchId' ? this.keepsAWayIn('touchId') : cur === 'off' || this.hasPassword() || this.pinUsable()
      if (!ok) {
        this.audit.append({ action: 'vault.quickunlock', outcome: 'failure', details: { mode: 'off', reason: 'no-other-factor' } })
        throw new Error(NEED_FACTOR)
      }
      this.db.prepare("UPDATE vault_state SET quick_unlock = 'off', quick_unlock_blob = NULL WHERE id = 1").run()
      this.touchIdUnreadable = false
    } else {
      if (!this.modeAvailable(mode)) throw new Error('quick unlock unavailable')
      this.db
        .prepare('UPDATE vault_state SET quick_unlock = ?, quick_unlock_blob = ? WHERE id = 1')
        .run(mode, this.cacheBlob(this.kek!))
      this.touchIdUnreadable = false
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

  /**
   * Rewraps the live KEK under `next`. The KEK itself is kept, so the vault rows, the Touch ID cache
   * and any PIN wrap stay valid. A legacy vault moves to the wrapped scheme in the same transaction.
   */
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
      // Only a password check: the live KEK is what gets wrapped.
      zero(res.kek, res.keys.values())
      const legacy = this.kekScheme() === 'legacy'
      const wrap = await this.passwordWrap(next, this.kek!, epoch)
      if (!wrap) {
        this.audit.append({ action: 'vault.rekey', outcome: 'failure', details: { reason: 'cancelled' } })
        return CANCELLED
      }
      try {
        this.tx(() => {
          this.writePasswordWrap(wrap)
          if (legacy) this.convertLegacy()
        })
      } catch (err) {
        this.audit.append({ action: 'vault.rekey', outcome: 'failure', details: { reason: 'write-failed' } })
        throw err
      }
      this.audit.append({
        action: 'vault.rekey',
        outcome: 'success',
        details: { vaults: this.keys.size, ...(legacy ? { converted: true } : {}) },
      })
      return { ok: true }
    })
  }

  /** Adds a master password to a vault that has none. Only while unlocked. */
  setPassword(next: string): Promise<VaultStatus> {
    return this.serial(async () => {
      this.assertUnlocked()
      if (this.hasPassword()) throw new Error('a master password is already set')
      checkPassword(next, true)
      const wrap = await this.passwordWrap(next, this.kek!, this.epoch)
      if (!wrap) throw vaultLockedError()
      this.tx(() => this.writePasswordWrap(wrap))
      this.audit.append({ action: 'vault.password', outcome: 'success', details: { op: 'set' } })
      return this.status()
    })
  }

  /**
   * Drops the master password after checking it, leaving the KEK only in the Touch ID cache or the
   * PIN wrap. Refused when neither exists: that would discard the last way in.
   */
  removePassword(current: string): Promise<UnlockResult> {
    return this.serial(async () => {
      this.assertUnlocked()
      checkPassword(current, false)
      // Refused up front: no scrypt, and nothing counted against the password backoff.
      if (!this.hasPassword()) throw new Error('no master password is set')
      this.assertOtherWayIn()
      const epoch = this.epoch
      const res = await this.verify(current, epoch)
      if (!res.ok) {
        this.audit.append({ action: 'vault.password', outcome: 'failure', details: { op: 'removed', reason: res.reason } })
        return res
      }
      zero(res.kek, res.keys.values())
      // Checked again after the await: the other factor may have gone meanwhile.
      this.assertOtherWayIn()
      const legacy = this.kekScheme() === 'legacy'
      this.tx(() => {
        this.db.prepare('UPDATE vault_state SET password_wrap = NULL, password_kdf = NULL WHERE id = 1').run()
        if (legacy) this.convertLegacy()
      })
      this.audit.append({ action: 'vault.password', outcome: 'success', details: { op: 'removed' } })
      return { ok: true }
    })
  }

  /** True when a master password can unlock: a password wrap, or a legacy password-derived KEK. */
  hasPassword(): boolean {
    return this.state().password_wrap !== null || this.kekScheme() === 'legacy'
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
      let unbound = false
      this.touchIdUnreadable = false
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
        // The binding guarded these vaults; the next setup binds whoever signs in then.
        unbound = changed('DELETE FROM sso_binding') > 0
        this.db
          .prepare(
            "UPDATE vault_state SET quick_unlock = 'off', quick_unlock_blob = NULL, failed_attempts = 0, last_failed_at = NULL, password_wrap = NULL, password_kdf = NULL, pin_wrap = NULL, pin_salt = NULL, pin_pepper_blob = NULL, pin_failed = 0, pin_length = NULL, last_method = NULL WHERE id = 1",
          )
          .run()
        // In the same transaction: an erase is never left unaudited, nor an audit row unerased.
        this.audit.appendInTx({ action: 'vault.reset', outcome: 'success', details: { ...counts, ...(unbound ? { ssoUnbound: true } : {}) } })
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
    // A legacy vault shares the Default vault's KDF params until it converts; the wrapped scheme has none.
    const master = this.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as {
      kdf_params: string | null
    }
    const kdfParams = this.kekScheme() === 'legacy' ? master.kdf_params : null
    const id = randomUUID()
    const key = randomKey()
    const ts = this.now().toISOString()
    this.db
      .prepare('INSERT INTO vaults(id, name, color, wrapped_key, kdf_params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, color, seal(this.kek!, key, wrapAad(id)), kdfParams, ts, ts)
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
      .prepare(
        'SELECT failed_attempts, last_failed_at, quick_unlock, quick_unlock_blob, auto_lock_minutes, pin_wrap, pin_salt, pin_pepper_blob, pin_failed, pin_length, last_method, password_wrap, password_kdf FROM vault_state WHERE id = 1',
      )
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
   * The throttled password check shared by unlock, reverify and the password changes. On success the caller owns
   * the returned buffers. Only the Default vault's unwrap decides a wrong password; another vault
   * that fails to open is reported as corrupt. A lock() since `epoch` abandons the attempt uncounted.
   */
  private async verify(password: string, epoch: number): Promise<Verified | Failure> {
    // Preflight F19: no master password means nothing to try, so nothing to count or throttle.
    if (!this.hasPassword()) return UNAVAILABLE
    const wait = this.retryAfterMs()
    if (wait > 0) return { ok: false, reason: 'throttled', retryAfterMs: wait }
    const kek = this.kekScheme() === 'legacy' ? await this.legacyKek(password) : await this.unwrapKek(password)
    if (epoch !== this.epoch) {
      kek?.fill(0)
      return CANCELLED
    }
    // Read after the await: a vault created during derivation must be included.
    const opened = kek && kek.length === KEK_BYTES ? this.openAll(kek) : null
    if (!kek || !opened) {
      kek?.fill(0)
      this.db
        .prepare('UPDATE vault_state SET failed_attempts = failed_attempts + 1, last_failed_at = ? WHERE id = 1')
        .run(this.now().toISOString())
      return { ok: false, reason: 'wrong-password', retryAfterMs: this.retryAfterMs() }
    }
    this.resetFailures()
    return { ok: true, kek, ...opened }
  }

  /** Legacy scheme: the KEK is the password's scrypt output under the Default vault's params. */
  private legacyKek(password: string): Promise<Buffer> {
    const master = this.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as {
      kdf_params: string
    }
    return deriveKek(password, JSON.parse(master.kdf_params) as KdfParams)
  }

  /** Wrapped scheme: the KEK sealed under the password's key; null for a wrong (or no) password. */
  private async unwrapKek(password: string): Promise<Buffer | null> {
    const s = this.state()
    if (!s.password_wrap || !s.password_kdf) return null
    const pwKey = await deriveKek(password, JSON.parse(s.password_kdf) as KdfParams)
    try {
      return openSealed(pwKey, s.password_wrap, PW_AAD)
    } catch {
      return null
    } finally {
      pwKey.fill(0)
    }
  }

  /** Seals `kek` under a key derived from `password` with fresh params; null if a lock() since `epoch`. */
  private async passwordWrap(password: string, kek: Buffer, epoch: number): Promise<PasswordWrap | null> {
    const params = newKdfParams(this.kdf)
    const pwKey = await deriveKek(password, params)
    try {
      if (epoch !== this.epoch) return null
      return { params, sealed: seal(pwKey, kek, PW_AAD) }
    } finally {
      pwKey.fill(0)
    }
  }

  private writePasswordWrap(wrap: PasswordWrap): void {
    this.db
      .prepare('UPDATE vault_state SET password_wrap = ?, password_kdf = ? WHERE id = 1')
      .run(wrap.sealed, JSON.stringify(wrap.params))
  }

  /** Inside a tx: leaves the legacy scheme for good, so the password no longer derives the KEK. */
  private convertLegacy(): void {
    this.db.prepare('UPDATE vaults SET kdf_params = NULL, updated_at = ?').run(this.now().toISOString())
  }

  /** Legacy while the Default vault keeps its KDF params (the KEK is derived from the password). */
  private kekScheme(): 'legacy' | 'wrapped' {
    const row = this.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as
      | { kdf_params: string | null }
      | undefined
    return row?.kdf_params != null ? 'legacy' : 'wrapped'
  }

  private pinEnabled(): boolean {
    return this.state().pin_wrap !== null
  }

  /** removePassword's refusal, audited like its other failures. */
  private assertOtherWayIn(): void {
    if (this.keepsAWayIn('password')) return
    this.audit.append({ action: 'vault.password', outcome: 'failure', details: { op: 'removed', reason: 'no-other-factor' } })
    throw new Error(NEED_FACTOR)
  }

  /**
   * The one guard behind every factor removal (spec §3): once `removing` is gone, Touch ID or a
   * PIN must still open the vaults, so the last copy of the KEK is never dropped. Each counts only
   * when it works right now: Touch ID when its cache opens to the live KEK, the PIN when its
   * pepper decrypts. Without the Keychain neither can work, and a master password is the
   * documented fallback for a factor that is already dead.
   */
  private keepsAWayIn(removing: Factor): boolean {
    if (removing !== 'pin' && this.pinUsable()) return true
    if (removing !== 'touchId' && this.touchIdHoldsKek()) return true
    return removing !== 'password' && !this.keychainAvailable() && this.hasPassword()
  }

  /** True when a PIN is set and its Keychain pepper decrypts without a prompt. Says nothing about the PIN. */
  private pinUsable(): boolean {
    const s = this.state()
    if (!s.pin_wrap || !s.pin_pepper_blob || !this.keychainAvailable()) return false
    let pepper: Buffer | null = null
    try {
      pepper = this.pepper(s.pin_pepper_blob)
      return pepper.length === KEK_BYTES
    } catch {
      return false
    } finally {
      pepper?.fill(0)
    }
  }

  /**
   * True when the Touch ID cache decrypts, without a prompt, to the live KEK. The row alone proves
   * nothing: after a re-signed app or a Keychain reset the blob is still there but unreadable.
   */
  private touchIdHoldsKek(): boolean {
    const s = this.state()
    if (s.quick_unlock !== 'touchId' || !s.quick_unlock_blob || !this.kek) return false
    if (!this.modeAvailable('touchId')) return false
    let cached: Buffer | null = null
    try {
      cached = Buffer.from(this.quick!.keychain.decrypt(Buffer.from(s.quick_unlock_blob, 'base64')), 'base64')
      return cached.length === this.kek.length && timingSafeEqual(cached, this.kek)
    } catch {
      return false
    } finally {
      cached?.fill(0)
    }
  }

  private keychainAvailable(): boolean {
    return this.quick?.keychain.available() === true
  }

  private pepper(blob: string): Buffer {
    return Buffer.from(this.quick!.keychain.decrypt(Buffer.from(blob, 'base64')), 'base64')
  }

  /** Seals `kek` under a fresh pepper and PIN key; null if a lock() since `epoch`. Never log the result's blob. */
  private async pinWrap(pin: string, kek: Buffer, epoch: number): Promise<PinWrap | null> {
    const params = newKdfParams(this.kdf)
    const pepper = randomKey()
    try {
      const pepperBlob = this.quick!.keychain.encrypt(pepper.toString('base64')).toString('base64')
      const pinKey = await derivePinKey(pin, pepper, params)
      try {
        if (epoch !== this.epoch) return null
        return { params, sealed: seal(pinKey, kek, PIN_AAD), pepperBlob, length: pin.length }
      } finally {
        pinKey.fill(0)
      }
    } finally {
      pepper.fill(0)
    }
  }

  private writePinWrap(wrap: PinWrap): void {
    this.db
      .prepare('UPDATE vault_state SET pin_wrap = ?, pin_salt = ?, pin_pepper_blob = ?, pin_failed = 0, pin_length = ? WHERE id = 1')
      .run(wrap.sealed, JSON.stringify(wrap.params), wrap.pepperBlob, wrap.length)
  }

  private clearPinColumns(failed: number): void {
    this.db
      .prepare('UPDATE vault_state SET pin_wrap = NULL, pin_salt = NULL, pin_pepper_blob = NULL, pin_failed = ?, pin_length = NULL WHERE id = 1')
      .run(failed)
  }

  /**
   * One PIN try, shared by unlockPin and reverify. On success the caller owns the buffers and the
   * count restarts. A lock() since `epoch` abandons it uncounted; so does a missing PIN or pepper.
   */
  private async pinAttempt(pin: string, epoch: number): Promise<Verified | Failure> {
    const s = this.state()
    if (!s.pin_wrap || !s.pin_salt || !s.pin_pepper_blob || !this.keychainAvailable()) return UNAVAILABLE
    let pepper: Buffer
    try {
      pepper = this.pepper(s.pin_pepper_blob)
    } catch {
      return UNAVAILABLE
    }
    let pinKey: Buffer
    try {
      if (pepper.length !== KEK_BYTES) return UNAVAILABLE
      pinKey = await derivePinKey(pin, pepper, JSON.parse(s.pin_salt) as KdfParams)
    } finally {
      pepper.fill(0)
    }
    if (epoch !== this.epoch) {
      pinKey.fill(0)
      return CANCELLED
    }
    let kek: Buffer | null = null
    try {
      kek = openSealed(pinKey, s.pin_wrap, PIN_AAD)
    } catch {
      kek = null
    } finally {
      pinKey.fill(0)
    }
    if (!kek) return this.pinMiss(s.pin_wrap)
    // A setPin or clearPin during the derive replaced this wrap: the old PIN no longer counts.
    if (this.state().pin_wrap !== s.pin_wrap) {
      kek.fill(0)
      return UNAVAILABLE
    }
    // Read after the await: a vault created meanwhile must be included.
    const opened = kek.length === KEK_BYTES ? this.openAll(kek) : null
    if (!opened) {
      // The PIN was right but its wrap no longer opens the Default vault: not the user's miss.
      kek.fill(0)
      return UNAVAILABLE
    }
    // A PIN set before pin_length existed has its length learned here.
    this.db.prepare('UPDATE vault_state SET pin_failed = 0, pin_length = ? WHERE id = 1').run(pin.length)
    return { ok: true, kek, ...opened }
  }

  /**
   * Counts a miss against the wrap that was tried. The PIN_ATTEMPTS-th wipes the PIN in the same
   * transaction as its audit row, naming what is left: the password, else Touch ID, else nothing.
   */
  private pinMiss(tried: string): Failure {
    let wiped = false
    this.tx(() => {
      const counted = this.db
        .prepare('UPDATE vault_state SET pin_failed = pin_failed + 1 WHERE id = 1 AND pin_wrap = ?')
        .run(tried).changes
      const s = this.state()
      if (!counted || s.pin_failed < PIN_ATTEMPTS) return
      const fallback = this.wipeFallback()
      this.clearPinColumns(PIN_ATTEMPTS)
      this.audit.appendInTx({ action: 'vault.pin', outcome: 'failure', details: { op: 'wiped', reason: 'attempts', fallback } })
      wiped = true
    })
    return wiped ? WIPED_PIN : WRONG_PIN
  }

  /**
   * What still opens the vaults besides the PIN: the password, else Touch ID (while unlocked, only
   * if its cache holds the live KEK; at the lock screen, if it is set up and available), else nothing.
   */
  private wipeFallback(): 'password' | 'touchId' | 'none' {
    if (this.hasPassword()) return 'password'
    const s = this.state()
    const touchId = this.kek
      ? this.touchIdHoldsKek()
      : s.quick_unlock === 'touchId' && !!s.quick_unlock_blob && this.modeAvailable('touchId')
    return touchId ? 'touchId' : 'none'
  }

  private isBound(): boolean {
    return this.db.prepare('SELECT 1 FROM sso_binding WHERE id = 1').get() !== undefined
  }

  /**
   * The gate lets an unlock through: not required, verified, or in grace. With no gate fitted a
   * binding fails closed, so a vault bound to a Microsoft account never opens on a code path that
   * forgot the gate.
   */
  private signInOk(): boolean {
    if (!this.gate) return !this.isBound()
    const v = this.gate.verdict()
    return v === 'not-required' || v === 'verified' || v === 'grace'
  }

  private assertSignedIn(): void {
    if (this.signInOk()) return
    this.audit.append({ action: 'vault.setup', outcome: 'failure', details: { reason: 'signin-required' } })
    throw new Error(SIGN_IN_FIRST)
  }

  /** An unlock the gate refused: nothing derived, prompted or counted. */
  private refuseUnlock(method: string): Failure {
    this.audit.append({ action: 'vault.unlock', outcome: 'failure', details: { method, reason: 'signin-required' } })
    return SIGNIN_REQUIRED
  }

  /** Lets the gate bind or move its clock mark. The vault is open by now: a failure here must not undo that. */
  private noteSignedInUnlock(): void {
    try {
      this.gate?.noteUnlocked()
    } catch {
      console.warn('SSO gate: noting the unlock failed')
    }
  }

  /** The gate's state; with a binding and no gate, what the fail-closed rule enforces (preflight F28). */
  private ssoState(): SsoState {
    if (this.gate) return this.gate.state()
    const b = this.db.prepare('SELECT user_upn FROM sso_binding WHERE id = 1').get() as { user_upn: string } | undefined
    if (!b) return { required: false }
    return { required: true, verdict: 'needs-signin', checking: false, upn: b.user_upn, hubName: '', lastVerifiedAt: null, graceEndsAt: null }
  }

  /** After any successful unlock: both failure counts restart, and the method is remembered. */
  private noteUnlock(method: UnlockMethod | null): void {
    this.db
      .prepare(
        'UPDATE vault_state SET failed_attempts = 0, last_failed_at = NULL, pin_failed = 0, last_method = COALESCE(?, last_method) WHERE id = 1',
      )
      .run(method)
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
    this.touchIdUnreadable = false
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
