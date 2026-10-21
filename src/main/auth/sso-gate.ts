import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { HubError } from '../hub/client'
import type { HubStatus, HubUser } from '../../shared/hub'
import {
  CLOCK_BACK_TOLERANCE_MS,
  OFFLINE_GRACE_HOURS,
  SSO_RECHECK_MS,
  SSO_WATCH_MS,
  type SessionCheck,
  type SsoState,
  type SsoVerdict,
} from '../../shared/sso'

/** What `VaultService` asks before any unlock. */
export interface SignInGate {
  verdict(): SsoVerdict
  state(): SsoState
  noteUnlocked(): void
}

/** The part of `HubConnection` the gate uses. */
export interface SsoHub {
  status(): HubStatus
  checkSession(): Promise<SessionCheck>
  signIn(): Promise<HubStatus>
  signOut(): Promise<HubStatus>
}

export interface SsoGateDeps {
  db: Db
  audit: Pick<AuditLog, 'append'>
  hub: SsoHub
  now: () => number
}

interface BindingRow {
  hub_id: string
  user_oid: string
  user_upn: string
  bound_at: string
  last_verified_at: string | null
  high_water_at: string | null
}

const GRACE_MS = OFFLINE_GRACE_HOURS * 3_600_000

const ms = (s: string | null): number | null => (s === null ? null : Date.parse(s))

/**
 * Decides whether the vaults may unlock while a Hub is bound or linked. Every path fails closed: a verdict reached
 * without the network needs a stored session and a clock that was not turned back, and grace needs a binding.
 */
export class SsoGate implements SignInGate {
  // The last verdict this process reached; null before any check.
  private result: SsoVerdict | null = null
  // A verification while linked but not yet bound, written to the binding on bind().
  private pending: { at: number; oid: string; hubId: string } | null = null
  private inflight: Promise<SsoVerdict> | null = null
  private audited: SsoVerdict | null = null
  // Bumped by a sign-out or an interactive sign-in, so a check already in flight can't settle over it.
  private generation = 0
  private readonly blocked = new Set<() => void>()

  constructor(private readonly d: SsoGateDeps) {}

  private binding(): BindingRow | undefined {
    return this.d.db.prepare('SELECT * FROM sso_binding WHERE id = 1').get() as BindingRow | undefined
  }

  private iso(t = this.d.now()): string {
    return new Date(t).toISOString()
  }

  isBound(): boolean {
    return this.binding() !== undefined
  }

  required(): boolean {
    return this.isBound() || this.d.hub.status().linked
  }

  private lastVerified(b = this.binding()): number | null {
    return b ? ms(b.last_verified_at) : (this.pending?.at ?? null)
  }

  /** The clock was not turned back: neither below the high-water mark nor before the last verification. */
  private clockOk(now: number, lv: number, b = this.binding()): boolean {
    const hw = b ? ms(b.high_water_at) : null
    return lv <= now + CLOCK_BACK_TOLERANCE_MS && (hw === null || now >= hw - CLOCK_BACK_TOLERANCE_MS)
  }

  /** Verified within the hour, for the bound account, with a session still stored. Never touches the network. */
  private fresh(): boolean {
    const s = this.d.hub.status()
    if (!s.linked || !s.signedIn) return false
    const b = this.binding()
    const lv = this.lastVerified(b)
    const now = this.d.now()
    if (lv === null || now - lv >= SSO_RECHECK_MS || !this.clockOk(now, lv, b)) return false
    return this.owns(s, b ? { oid: b.user_oid, hubId: b.hub_id } : this.pending)
  }

  /**
   * The stored session belongs to `who`. After a restart the user is not in memory until `me()`, so the oid the
   * Hub link stored with the session stands in; with neither, the owner is unknown and this fails closed.
   */
  private owns(s: HubStatus, who: { oid: string; hubId: string } | null): boolean {
    if (!who || !s.linked || !s.signedIn || s.hubId !== who.hubId) return false
    const stored = this.d.db.prepare('SELECT user_oid FROM hub_link WHERE id = 1 AND session_enc IS NOT NULL').get() as
      | { user_oid: string | null }
      | undefined
    const owner = s.user?.oid ?? stored?.user_oid ?? null
    return owner !== null && owner === who.oid
  }

  private inGrace(): boolean {
    const b = this.binding()
    const s = this.d.hub.status()
    if (!b || !this.owns(s, { oid: b.user_oid, hubId: b.hub_id })) return false
    const lv = ms(b.last_verified_at)
    const now = this.d.now()
    return lv !== null && now < lv + GRACE_MS && this.clockOk(now, lv, b)
  }

  verdict(): SsoVerdict {
    if (!this.required()) return 'not-required'
    const r = this.result
    if (r === null || r === 'verified') return this.fresh() ? 'verified' : 'needs-signin'
    if (r === 'grace') return this.inGrace() ? 'grace' : 'needs-signin'
    return r
  }

  state(): SsoState {
    if (!this.required()) return { required: false }
    const b = this.binding()
    const s = this.d.hub.status()
    const v = this.verdict()
    const lv = this.lastVerified(b)
    return {
      required: true,
      verdict: v,
      checking: this.inflight !== null,
      upn: b?.user_upn ?? (s.linked ? (s.user?.upn ?? null) : null),
      hubName: s.linked ? s.hubName : '',
      lastVerifiedAt: lv === null ? null : this.iso(lv),
      graceEndsAt: v === 'grace' && lv !== null ? this.iso(lv + GRACE_MS) : null,
    }
  }

  check(opts: { force?: boolean } = {}): Promise<SsoVerdict> {
    if (!this.required()) return Promise.resolve('not-required')
    if (this.inflight) return this.inflight
    if (!opts.force && (this.result === null || this.result === 'verified') && this.fresh()) {
      this.raiseHighWater()
      return Promise.resolve(this.settle('verified'))
    }
    this.inflight = this.run().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async run(): Promise<SsoVerdict> {
    const gen = this.generation
    let r: SessionCheck
    try {
      r = await this.d.hub.checkSession()
    } catch {
      // Unknown failures fail closed, and never start grace.
      r = { kind: 'expired' }
    }
    if (gen !== this.generation) return this.verdict()
    this.raiseHighWater()
    switch (r.kind) {
      case 'ok':
        return this.settle(this.accept(r.user))
      case 'offline':
        return this.settle(this.inGrace() ? 'grace' : 'needs-signin')
      case 'expired':
        this.forget()
        return this.settle('needs-signin')
      case 'disabled':
        this.forget()
        return this.settle('blocked')
    }
  }

  /** Interactive sign-in. A 403 from the Hub means the account is disabled. */
  async signIn(): Promise<SsoVerdict> {
    let s: HubStatus
    try {
      s = await this.d.hub.signIn()
    } catch (err) {
      if (err instanceof HubError && err.status === 403) {
        this.forget()
        return this.settle('blocked')
      }
      throw err
    } finally {
      // Any session may have changed: a check started before this sign-in must not settle on it.
      this.generation++
    }
    this.raiseHighWater()
    return this.settle(s.linked && s.user ? this.accept(s.user) : 'needs-signin')
  }

  /** Signs out of the Hub; the gate needs a new Microsoft sign-in, in this process and the next. */
  async signOut(): Promise<HubStatus> {
    const s = await this.d.hub.signOut()
    this.sessionDropped()
    return s
  }

  /** For a Hub sign-out that bypasses `signOut()`: forget every verification. */
  sessionDropped(): void {
    this.generation++
    this.forget()
    if (this.required()) this.settle('needs-signin')
  }

  /** A session the Hub accepted: verified for the bound (or, unbound, the first) account, else a mismatch. */
  private accept(user: HubUser): SsoVerdict {
    const s = this.d.hub.status()
    if (!s.linked) return 'needs-signin'
    const b = this.binding()
    const now = this.d.now()
    if (!b) {
      this.pending = { at: now, oid: user.oid, hubId: s.hubId }
      return 'verified'
    }
    if (b.user_oid !== user.oid || b.hub_id !== s.hubId) {
      // No earlier verification may be reused while another account's session is stored.
      this.forget()
      return 'mismatch'
    }
    this.d.db.prepare('UPDATE sso_binding SET last_verified_at = ? WHERE id = 1').run(this.iso(now))
    return 'verified'
  }

  private forget(): void {
    this.pending = null
    this.d.db.prepare('UPDATE sso_binding SET last_verified_at = NULL WHERE id = 1').run()
  }

  /** Never lowers it, so a clock turned back can't reset the mark. */
  private raiseHighWater(): void {
    const b = this.binding()
    if (!b) return
    const now = this.d.now()
    const hw = ms(b.high_water_at)
    if (hw === null || now > hw) this.d.db.prepare('UPDATE sso_binding SET high_water_at = ? WHERE id = 1').run(this.iso(now))
  }

  private settle(v: SsoVerdict): SsoVerdict {
    this.result = v
    if (v !== this.audited) {
      this.audited = v
      const details: Record<string, unknown> = { verdict: v }
      const lv = this.lastVerified()
      if (v === 'grace' && lv !== null) details.offlineHours = Math.floor((this.d.now() - lv) / 3_600_000)
      this.d.audit.append({ action: 'auth.check', outcome: 'info', details })
    }
    if (v === 'blocked') for (const fn of this.blocked) fn()
    return v
  }

  noteUnlocked(): void {
    this.raiseHighWater()
    if (this.required() && !this.isBound()) {
      const s = this.d.hub.status()
      if (s.linked && s.signedIn && s.user) this.bind()
    }
  }

  bind(): void {
    const s = this.d.hub.status()
    if (!s.linked || !s.signedIn || !s.user) throw new Error('sign in first')
    if (this.isBound()) throw new Error('already bound')
    const p = this.pending
    const lv = p && p.oid === s.user.oid && p.hubId === s.hubId ? this.iso(p.at) : null
    const now = this.iso()
    this.d.db
      .prepare(
        'INSERT INTO sso_binding(id, hub_id, user_oid, user_upn, bound_at, last_verified_at, high_water_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
      )
      .run(s.hubId, s.user.oid, s.user.upn, now, lv, now)
    this.pending = null
    this.d.audit.append({ action: 'auth.bind', outcome: 'success', targetType: 'hub', targetId: s.hubId, targetLabel: s.hubName })
  }

  /** Interactive sign-in, then the binding moves to whoever signed in. The caller re-verifies first. */
  async rebind(): Promise<void> {
    const prev = this.binding()
    if (!prev) throw new Error('not bound')
    let s: HubStatus
    try {
      s = await this.d.hub.signIn()
    } catch (err) {
      if (err instanceof HubError && err.status === 403) {
        this.forget()
        this.settle('blocked')
      }
      throw err
    } finally {
      // Any session may have changed: a check started before this sign-in must not settle on it.
      this.generation++
    }
    if (!s.linked || !s.signedIn || !s.user) throw new Error('sign in first')
    const now = this.iso()
    this.d.db
      .prepare('UPDATE sso_binding SET hub_id = ?, user_oid = ?, user_upn = ?, last_verified_at = ? WHERE id = 1')
      .run(s.hubId, s.user.oid, s.user.upn, now)
    this.raiseHighWater()
    this.pending = null
    this.d.audit.append({
      action: 'auth.rebind',
      outcome: 'success',
      targetType: 'hub',
      targetId: s.hubId,
      targetLabel: s.hubName,
      details: { oidChanged: prev.user_oid !== s.user.oid },
    })
    this.settle('verified')
  }

  unbind(): void {
    const prev = this.binding()
    if (!prev) return
    this.d.db.prepare('DELETE FROM sso_binding WHERE id = 1').run()
    this.pending = null
    this.result = null
    const s = this.d.hub.status()
    this.d.audit.append({
      action: 'auth.unbind',
      outcome: 'success',
      targetType: 'hub',
      targetId: prev.hub_id,
      ...(s.linked && s.hubId === prev.hub_id ? { targetLabel: s.hubName } : {}),
    })
  }

  onBlocked(fn: () => void): () => void {
    this.blocked.add(fn)
    return () => this.blocked.delete(fn)
  }

  watch(isUnlocked: () => boolean): () => void {
    const timer = setInterval(() => {
      // A failing tick must not become an unhandled rejection; the next tick checks again.
      if (isUnlocked()) this.check({ force: true }).catch(() => console.warn('SSO recheck failed'))
    }, SSO_WATCH_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
