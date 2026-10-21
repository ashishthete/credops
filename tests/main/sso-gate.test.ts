import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { SsoGate, type SsoHub } from '../../src/main/auth/sso-gate'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { HubError } from '../../src/main/hub/client'
import type { HubStatus, HubUser } from '../../src/shared/hub'
import { CLOCK_BACK_TOLERANCE_MS, SSO_RECHECK_MS, SSO_WATCH_MS, type SessionCheck } from '../../src/shared/sso'

const H = 3_600_000
const MIN = 60_000
const T0 = Date.parse('2026-10-21T08:00:00.000Z')
const iso = (t: number): string => new Date(t).toISOString()

const user = (oid: string, upn: string): HubUser => ({
  oid,
  upn,
  name: upn,
  role: 'maintainer',
  status: 'active',
  groupIds: [],
  createdAt: iso(T0),
  lastSeenAt: null,
})
const ALICE = user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alice@example.com')
const BOB = user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bob@example.com')
const TOKEN = 'hub-session-token-do-not-log'

type Linked = Extract<HubStatus, { linked: true }>

class FakeHub implements SsoHub {
  checks: SessionCheck[] = []
  calls = 0
  signInResult: (() => HubStatus) | null = null
  st: HubStatus = { linked: false }

  link(over: Partial<Linked> = {}): void {
    this.st = {
      linked: true,
      url: 'https://hub.example.com',
      hubId: 'hub-1',
      hubName: 'Team Hub',
      signedIn: true,
      signingIn: false,
      online: true,
      user: ALICE,
      sessionExpiresAt: null,
      ...over,
    }
  }
  status(): HubStatus {
    return this.st
  }
  async checkSession(): Promise<SessionCheck> {
    this.calls++
    const next = this.checks.shift()
    if (!next) throw new Error('no check queued')
    if (next.kind === 'ok' && this.st.linked) this.st = { ...this.st, signedIn: true, user: next.user }
    return next
  }
  async signIn(): Promise<HubStatus> {
    if (!this.signInResult) throw new Error('no sign-in queued')
    this.st = this.signInResult()
    return this.st
  }
  async signOut(): Promise<HubStatus> {
    if (this.st.linked) this.st = { ...this.st, signedIn: false, user: null }
    return this.st
  }
}

let db: Db
let audit: AuditLog
let hub: FakeHub
let now: { t: number }

const gate = (): SsoGate => new SsoGate({ db, audit, hub, now: () => now.t })
const row = () =>
  db.prepare('SELECT * FROM sso_binding WHERE id = 1').get() as
    | { hub_id: string; user_oid: string; user_upn: string; last_verified_at: string | null; high_water_at: string | null }
    | undefined
const bindRow = (over: Partial<{ hub_id: string; user_oid: string; last_verified_at: string | null; high_water_at: string | null }> = {}) =>
  db
    .prepare(
      'INSERT INTO sso_binding(id, hub_id, user_oid, user_upn, bound_at, last_verified_at, high_water_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      over.hub_id ?? 'hub-1',
      over.user_oid ?? ALICE.oid,
      ALICE.upn,
      iso(T0),
      over.last_verified_at === undefined ? null : over.last_verified_at,
      over.high_water_at === undefined ? null : over.high_water_at,
    )
const oldestFirst = () => audit.list({}).sort((a, b) => a.id - b.id)
const actions = (a: string) => oldestFirst().filter((e) => e.action === a)

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditLog(db)
  hub = new FakeHub()
  now = { t: T0 }
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
})

describe('SsoGate', () => {
  it('not-required with no Hub and no binding', async () => {
    const g = gate()
    expect(g.required()).toBe(false)
    expect(g.verdict()).toBe('not-required')
    expect(await g.check()).toBe('not-required')
    expect(g.state()).toEqual({ required: false })
    expect(hub.calls).toBe(0)
  })

  it('a binding alone makes it required, and fails closed', async () => {
    bindRow({ last_verified_at: iso(T0) })
    const g = gate()
    expect(g.required()).toBe(true)
    expect(g.verdict()).toBe('needs-signin')
    hub.checks.push({ kind: 'expired' })
    expect(await g.check()).toBe('needs-signin')
  })

  it('verified, then skips the network within an hour', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    expect(await g.check()).toBe('verified')
    expect(row()?.last_verified_at).toBe(iso(T0))
    now.t = T0 + 59 * MIN
    expect(await g.check()).toBe('verified')
    expect(hub.calls).toBe(1)
    expect(g.verdict()).toBe('verified')
  })

  it('verified expires with the recheck window', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    await g.check()
    now.t = T0 + SSO_RECHECK_MS
    expect(g.verdict()).toBe('needs-signin')
  })

  it('before any check: verified only within the hour and with a stored session', () => {
    hub.link({ user: null })
    bindRow({ last_verified_at: iso(T0 - 30 * MIN) })
    expect(gate().verdict()).toBe('verified')
    now.t = T0 + 31 * MIN
    expect(gate().verdict()).toBe('needs-signin')
  })

  it('grace when offline within 72 h, needs-signin after', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    await g.check()
    now.t = T0 + 71 * H
    hub.checks.push({ kind: 'offline' })
    expect(await g.check()).toBe('grace')
    const s = g.state()
    expect(s.required && s.graceEndsAt).toBe(iso(T0 + 72 * H))
    expect(s.required && s.lastVerifiedAt).toBe(iso(T0))
    expect(actions('auth.check').at(-1)?.details).toEqual({ verdict: 'grace', offlineHours: 71 })
    now.t = T0 + 73 * H
    expect(g.verdict()).toBe('needs-signin')
    hub.checks.push({ kind: 'offline' })
    expect(await g.check()).toBe('needs-signin')
  })

  it('clock turned back ends grace', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    await g.check()
    const T = T0 + 3 * H
    now.t = T
    g.noteUnlocked()
    expect(row()?.high_water_at).toBe(iso(T))
    now.t = T - 10 * MIN
    hub.checks.push({ kind: 'offline' })
    expect(await g.check()).toBe('needs-signin')
    // Turning the clock back never lowers the high-water mark.
    expect(row()?.high_water_at).toBe(iso(T))
  })

  it('401 never starts grace', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    await g.check()
    now.t = T0 + 2 * H
    hub.checks.push({ kind: 'expired' })
    expect(await g.check()).toBe('needs-signin')
    hub.checks.push({ kind: 'offline' })
    expect(await g.check({ force: true })).toBe('needs-signin')
  })

  it('disabled is blocked and fires onBlocked', async () => {
    hub.link()
    bindRow()
    const g = gate()
    const fired = vi.fn()
    const off = g.onBlocked(fired)
    hub.checks.push({ kind: 'disabled' })
    expect(await g.check()).toBe('blocked')
    expect(fired).toHaveBeenCalledTimes(1)
    expect(g.verdict()).toBe('blocked')
    off()
    hub.checks.push({ kind: 'disabled' })
    await g.check()
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('a 403 at sign-in is blocked; other sign-in errors propagate', async () => {
    hub.link({ signedIn: false, user: null })
    bindRow()
    const g = gate()
    const fired = vi.fn()
    g.onBlocked(fired)
    hub.signInResult = () => {
      throw new HubError('forbidden', 'Your Hub account is disabled', 403)
    }
    expect(await g.signIn()).toBe('blocked')
    expect(fired).toHaveBeenCalledTimes(1)
    hub.signInResult = () => {
      throw new HubError('network', "Can't reach the Hub")
    }
    await expect(g.signIn()).rejects.toThrow("Can't reach the Hub")
  })

  it('signIn verifies the bound user', async () => {
    hub.link({ signedIn: false, user: null })
    bindRow()
    const g = gate()
    hub.signInResult = () => ({ ...(hub.st as Linked), signedIn: true, user: ALICE })
    expect(await g.signIn()).toBe('verified')
    expect(row()?.last_verified_at).toBe(iso(T0))
    expect(g.verdict()).toBe('verified')
  })

  it('mismatch for another oid or another hub_id', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: BOB })
    expect(await g.check()).toBe('mismatch')
    expect(row()?.last_verified_at).toBeNull()
    expect(g.verdict()).toBe('mismatch')

    hub.signInResult = () => ({ ...(hub.st as Linked), user: BOB })
    expect(await g.signIn()).toBe('mismatch')

    hub.link({ hubId: 'hub-2' })
    hub.checks.push({ kind: 'ok', user: ALICE })
    expect(await g.check()).toBe('mismatch')
    expect(row()?.last_verified_at).toBeNull()
  })

  it('noteUnlocked binds the first signed-in user', async () => {
    hub.link()
    const g = gate()
    expect(g.required()).toBe(true)
    expect(g.isBound()).toBe(false)
    hub.checks.push({ kind: 'ok', user: ALICE })
    expect(await g.check()).toBe('verified')
    g.noteUnlocked()
    expect(g.isBound()).toBe(true)
    expect(row()).toMatchObject({ hub_id: 'hub-1', user_oid: ALICE.oid, user_upn: ALICE.upn })
    const bind = actions('auth.bind')
    expect(bind).toHaveLength(1)
    expect(bind[0]).toMatchObject({ targetType: 'hub', targetId: 'hub-1' })
  })

  it('bind needs a signed-in user', () => {
    hub.link({ signedIn: false, user: null })
    expect(() => gate().bind()).toThrow('sign in first')
  })

  it('rebind rewrites the binding to the newly signed-in account', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.signInResult = () => ({ ...(hub.st as Linked), user: BOB })
    await g.rebind()
    expect(row()).toMatchObject({ hub_id: 'hub-1', user_oid: BOB.oid, user_upn: BOB.upn, last_verified_at: iso(T0) })
    expect(g.verdict()).toBe('verified')
    const rb = actions('auth.rebind')
    expect(rb).toHaveLength(1)
    expect(rb[0]).toMatchObject({ targetType: 'hub', targetId: 'hub-1', details: { oidChanged: true } })
  })

  it('unbind removes the binding and audits', () => {
    hub.link()
    bindRow()
    const g = gate()
    g.unbind()
    expect(row()).toBeUndefined()
    expect(actions('auth.unbind')[0]).toMatchObject({ targetType: 'hub', targetId: 'hub-1' })
  })

  it('state() is checking while check() is in flight', async () => {
    hub.link()
    bindRow()
    const g = gate()
    let release!: (c: SessionCheck) => void
    hub.checkSession = () => new Promise<SessionCheck>((r) => (release = r))
    const p = g.check()
    expect(g.state()).toMatchObject({ required: true, checking: true, upn: ALICE.upn, hubName: 'Team Hub' })
    release({ kind: 'ok', user: ALICE })
    expect(await p).toBe('verified')
    expect(g.state()).toMatchObject({ checking: false, verdict: 'verified' })
  })

  it('an unexpected check error fails closed', async () => {
    hub.link()
    bindRow({ last_verified_at: iso(T0 - 2 * H) })
    const g = gate()
    hub.checkSession = async () => {
      throw new Error('boom')
    }
    expect(await g.check()).toBe('needs-signin')
  })

  it('watch rechecks while unlocked only', async () => {
    vi.useFakeTimers()
    hub.link()
    bindRow()
    const g = gate()
    let unlocked = true
    const stop = g.watch(() => unlocked)
    hub.checks.push({ kind: 'ok', user: ALICE })
    await vi.advanceTimersByTimeAsync(SSO_WATCH_MS)
    expect(hub.calls).toBe(1)
    unlocked = false
    await vi.advanceTimersByTimeAsync(SSO_WATCH_MS)
    expect(hub.calls).toBe(1)
    stop()
    unlocked = true
    await vi.advanceTimersByTimeAsync(SSO_WATCH_MS)
    expect(hub.calls).toBe(1)
  })

  it('audit carries no token or upn in details', async () => {
    hub.link()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE })
    await g.check()
    g.noteUnlocked()
    now.t = T0 + 5 * H
    hub.checks.push({ kind: 'offline' })
    await g.check()
    hub.signInResult = () => ({ ...(hub.st as Linked), user: BOB })
    await g.rebind()
    g.unbind()
    const evs = oldestFirst().filter((e) => e.action.startsWith('auth.'))
    expect(evs.map((e) => e.action)).toEqual(['auth.check', 'auth.bind', 'auth.check', 'auth.rebind', 'auth.check', 'auth.unbind'])
    for (const e of evs) {
      const d = JSON.stringify(e.details)
      for (const s of [TOKEN, ALICE.upn, BOB.upn, ALICE.oid, BOB.oid]) expect(d).not.toContain(s)
    }
  })

  it('audits auth.check only when the verdict changes', async () => {
    hub.link()
    bindRow()
    const g = gate()
    hub.checks.push({ kind: 'ok', user: ALICE }, { kind: 'ok', user: ALICE })
    await g.check()
    await g.check({ force: true })
    expect(actions('auth.check').map((e) => e.details)).toEqual([{ verdict: 'verified' }])
  })

  // Pre-flight F1: sign-out must not leave the gate verified.
  describe('sign-out (F1)', () => {
    it('signOut resets the verdict and clears last_verified_at', async () => {
      hub.link()
      bindRow()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      await g.check()
      await g.signOut()
      expect(g.verdict()).toBe('needs-signin')
      expect(row()?.last_verified_at).toBeNull()
      // Even if a session appeared again without a check, the next process must not start verified.
      hub.link()
      expect(gate().verdict()).toBe('needs-signin')
    })

    it('a session dropped elsewhere (hub:signOut) ends verified at once', async () => {
      hub.link()
      bindRow()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      await g.check()
      await hub.signOut()
      expect(g.verdict()).toBe('needs-signin')
      hub.checks.push({ kind: 'expired' })
      expect(await g.check()).toBe('needs-signin')
      expect(hub.calls).toBe(2)
    })

    it('a restart with no stored session is never verified', async () => {
      hub.link({ signedIn: false, user: null })
      bindRow({ last_verified_at: iso(T0 - 5 * MIN) })
      const g = gate()
      expect(g.verdict()).toBe('needs-signin')
      hub.checks.push({ kind: 'expired' })
      expect(await g.check()).toBe('needs-signin')
      expect(hub.calls).toBe(1)
    })
  })

  // Pre-flight B2: the 1 h verified window has the same clock guard as grace.
  describe('verified window clock guard (B2)', () => {
    it('rejects a last_verified_at in the future', async () => {
      hub.link()
      bindRow({ last_verified_at: iso(T0 + 2 * H) })
      const g = gate()
      expect(g.verdict()).toBe('needs-signin')
      hub.checks.push({ kind: 'offline' })
      expect(await g.check()).toBe('needs-signin')
      expect(hub.calls).toBe(1)
    })

    it('a clock turned back below high_water_at goes to the network', async () => {
      hub.link()
      bindRow()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      await g.check()
      now.t = T0 + 30 * MIN
      g.noteUnlocked()
      now.t = T0 + 10 * MIN
      expect(g.verdict()).toBe('needs-signin')
      hub.checks.push({ kind: 'offline' })
      expect(await g.check()).toBe('needs-signin')
      expect(hub.calls).toBe(2)
    })

    it('a small clock step within the tolerance keeps verified', async () => {
      hub.link()
      bindRow()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      await g.check()
      now.t = T0 + 30 * MIN
      g.noteUnlocked()
      now.t = T0 + 30 * MIN - CLOCK_BACK_TOLERANCE_MS + 1000
      expect(g.verdict()).toBe('verified')
    })

    it('check() raises high_water_at', async () => {
      hub.link()
      bindRow()
      const g = gate()
      hub.checks.push({ kind: 'offline' })
      now.t = T0 + 4 * H
      await g.check()
      expect(row()?.high_water_at).toBe(iso(T0 + 4 * H))
      now.t = T0 + 4 * H - 10 * MIN
      hub.checks.push({ kind: 'offline' })
      await g.check()
      expect(row()?.high_water_at).toBe(iso(T0 + 4 * H))
    })
  })

  // Pre-flight F9: a linked but unbound Hub keeps the verification in memory until bind().
  describe('linked but unbound (F9)', () => {
    it('keeps last_verified_at in memory and writes it on bind()', async () => {
      hub.link()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      expect(await g.check()).toBe('verified')
      expect(row()).toBeUndefined()
      expect(g.state()).toMatchObject({ verdict: 'verified', lastVerifiedAt: iso(T0) })
      now.t = T0 + 10 * MIN
      g.bind()
      expect(row()).toMatchObject({ last_verified_at: iso(T0), high_water_at: iso(T0 + 10 * MIN) })
    })

    it('never grants grace before binding', async () => {
      hub.link()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: ALICE })
      await g.check()
      now.t = T0 + 2 * H
      hub.checks.push({ kind: 'offline' })
      expect(await g.check()).toBe('needs-signin')
      expect(g.verdict()).toBe('needs-signin')
    })

    it('a verification for another user is not carried into the binding', async () => {
      hub.link()
      const g = gate()
      hub.checks.push({ kind: 'ok', user: BOB })
      await g.check()
      hub.link({ user: ALICE })
      g.bind()
      expect(row()).toMatchObject({ user_oid: ALICE.oid, last_verified_at: null })
    })
  })
})
