import { afterEach, describe, expect, it, vi } from 'vitest'
import { SsoGate, type SignInGate, type SsoHub } from '../../src/main/auth/sso-gate'
import { deriveKek } from '../../src/main/vault/crypto'
import type { HubStatus, HubUser } from '../../src/shared/hub'
import { SSO_WATCH_MS, type SessionCheck, type SsoState, type SsoVerdict } from '../../src/shared/sso'
import type { LockReason } from '../../src/shared/vault'
import { auditRows, fakeQuick, makeVault, type FakeQuick, type VaultFixture } from './vault-helpers'

vi.mock('../../src/main/vault/crypto', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/vault/crypto')>()
  return { ...mod, deriveKek: vi.fn(mod.deriveKek) }
})

const PW = 'correct horse'
const PIN = '204816'
const T0 = Date.UTC(2026, 9, 21, 8)
const SIGNIN = { ok: false, reason: 'signin-required', retryAfterMs: 0 }

const ALICE: HubUser = {
  oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  upn: 'alice@example.com',
  name: 'Alice',
  role: 'maintainer',
  status: 'active',
  groupIds: [],
  createdAt: new Date(T0).toISOString(),
  lastSeenAt: null,
}

/** A gate whose verdict the test sets. */
class FakeGate implements SignInGate {
  v: SsoVerdict = 'not-required'
  noted = 0
  verdict(): SsoVerdict {
    return this.v
  }
  state(): SsoState {
    if (this.v === 'not-required') return { required: false }
    return { required: true, verdict: this.v, checking: false, upn: 'alice@example.com', hubName: 'Team Hub', lastVerifiedAt: null, graceEndsAt: null }
  }
  noteUnlocked(): void {
    this.noted++
  }
}

type Ready = VaultFixture & { quick: FakeQuick; gate: FakeGate }

/** Set up with a password, a PIN and Touch ID, then locked, with the gate fitted. */
async function ready(): Promise<Ready> {
  const quick = fakeQuick()
  const f = makeVault({ quick, now: { t: T0 } })
  await f.vault.setup({ password: PW, pin: PIN, touchId: true })
  f.vault.lock('manual')
  quick.touchId.prompt.mockClear()
  quick.keychain.decrypt.mockClear()
  const gate = new FakeGate()
  f.vault.setSignInGate(gate)
  return { ...f, quick, gate }
}

const counters = (f: VaultFixture) =>
  f.db.prepare('SELECT failed_attempts, last_failed_at, pin_failed FROM vault_state WHERE id = 1').get()

const bindRow = (f: VaultFixture): void =>
  void f.db
    .prepare('INSERT INTO sso_binding(id, hub_id, user_oid, user_upn, bound_at) VALUES (1, ?, ?, ?, ?)')
    .run('hub-1', ALICE.oid, ALICE.upn, new Date(T0).toISOString())

const unlockEvents = (f: VaultFixture) =>
  f.audit
    .list({ limit: 1000 })
    .filter((e) => e.action === 'vault.unlock')
    .map((e) => ({ outcome: e.outcome, details: e.details }))

describe('vault sign-in gate', () => {
  it.each(['needs-signin', 'blocked', 'mismatch'] as const)('%s refuses every unlock path', async (v) => {
    const f = await ready()
    // One miss of each kind first, so "unchanged" means more than zero.
    expect((await f.vault.unlock('wrong password')).ok).toBe(false)
    expect(await f.vault.unlockPin('999999')).toMatchObject({ reason: 'wrong-pin' })
    const before = counters(f)
    f.quick.keychain.decrypt.mockClear()
    f.now.t += 600_000
    f.gate.v = v
    expect(await f.vault.unlock(PW)).toEqual(SIGNIN)
    expect(await f.vault.unlock('wrong password')).toEqual(SIGNIN)
    expect(await f.vault.unlockPin(PIN)).toEqual(SIGNIN)
    expect(await f.vault.unlockPin('999999')).toEqual(SIGNIN)
    expect(await f.vault.unlockQuick()).toEqual(SIGNIN)
    expect(f.vault.isUnlocked()).toBe(false)
    expect(counters(f)).toEqual(before)
    // The gate is asked before any Touch ID prompt or Keychain read.
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(f.quick.keychain.decrypt).not.toHaveBeenCalled()
    expect(f.gate.noted).toBe(0)
    const refused = unlockEvents(f).filter((e) => (e.details as { reason?: string }).reason === 'signin-required')
    expect(refused.map((e) => e.outcome)).toEqual(['failure', 'failure', 'failure', 'failure', 'failure'])
    expect(refused.map((e) => (e.details as { method: string }).method).sort()).toEqual(['password', 'password', 'pin', 'pin', 'touchId'])
    expect(auditRows(f.db)).not.toContain(PW)
    expect(auditRows(f.db)).not.toContain(PIN)
  })

  it.each(['not-required', 'verified', 'grace'] as const)('%s allows unlock', async (v) => {
    const f = await ready()
    f.gate.v = v
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.vault.isUnlocked()).toBe(true)
  })

  it.each([false, true])('a verdict that turns during the Touch ID prompt refuses before the Keychain read (stale cache: %s)', async (stale) => {
    const f = await ready()
    f.gate.v = 'verified'
    // A cache that would read but no longer hold the KEK: the refusal must not discard it either.
    if (stale) f.db.prepare('UPDATE vault_state SET quick_unlock_blob = ? WHERE id = 1').run(Buffer.from(`kc:${'A'.repeat(44)}`).toString('base64'))
    const blob = f.db.prepare('SELECT quick_unlock_blob FROM vault_state').get()
    let release!: () => void
    f.quick.touchId.prompt.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const pending = f.vault.unlockQuick()
    await vi.waitFor(() => expect(f.quick.touchId.prompt).toHaveBeenCalled())
    f.gate.v = 'needs-signin'
    release()
    expect(await pending).toEqual(SIGNIN)
    expect(f.quick.keychain.decrypt).not.toHaveBeenCalled()
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.gate.noted).toBe(0)
    expect(f.vault.status().quickUnlock).toBe('touchId')
    expect(f.db.prepare('SELECT quick_unlock_blob FROM vault_state').get()).toEqual(blob)
  })

  it.each(['password', 'pin', 'setup'] as const)('a verdict that turns during the %s scrypt refuses', async (path) => {
    const quick = fakeQuick()
    const f = makeVault({ quick, now: { t: T0 } })
    const gate = new FakeGate()
    f.vault.setSignInGate(gate)
    gate.v = 'verified'
    if (path !== 'setup') {
      await f.vault.setup({ password: PW, pin: PIN })
      f.vault.lock('manual')
    }
    vi.mocked(deriveKek).mockClear()
    const real = (await vi.importActual<typeof import('../../src/main/vault/crypto')>('../../src/main/vault/crypto')).deriveKek
    let release!: () => void
    let held: Buffer | null = null
    vi.mocked(deriveKek).mockImplementationOnce(async (secret, params) => {
      await new Promise<void>((r) => (release = r))
      held = await real(secret, params)
      return held
    })
    const pending =
      path === 'password' ? f.vault.unlock(PW) : path === 'pin' ? f.vault.unlockPin(PIN) : f.vault.setup({ password: PW, pin: PIN })
    await vi.waitFor(() => expect(deriveKek).toHaveBeenCalled())
    gate.v = 'needs-signin'
    release()
    if (path === 'setup') {
      await expect(pending).rejects.toThrow('sign in with Microsoft first')
      expect(f.vault.status().setUp).toBe(false)
    } else {
      expect(await pending).toEqual(SIGNIN)
    }
    expect(f.vault.isUnlocked()).toBe(false)
    expect(gate.noted).toBe(path === 'setup' ? 0 : 1)
    expect(counters(f)).toEqual({ failed_attempts: 0, last_failed_at: null, pin_failed: 0 })
    // The derived key itself is zeroed once used (it is the only buffer a test can reach).
    expect(held!.every((b: number) => b === 0)).toBe(true)
  })

  it('fails closed when bound and no gate is set', async () => {
    const quick = fakeQuick()
    const f = makeVault({ quick, now: { t: T0 } })
    await f.vault.setup({ password: PW, pin: PIN, touchId: true })
    f.vault.lock('manual')
    bindRow(f)
    quick.touchId.prompt.mockClear()
    expect(await f.vault.unlock(PW)).toEqual(SIGNIN)
    expect(await f.vault.unlockPin(PIN)).toEqual(SIGNIN)
    expect(await f.vault.unlockQuick()).toEqual(SIGNIN)
    expect(quick.touchId.prompt).not.toHaveBeenCalled()
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.vault.status().sso).toEqual({
      required: true,
      verdict: 'needs-signin',
      checking: false,
      upn: ALICE.upn,
      hubName: '',
      lastVerifiedAt: null,
      graceEndsAt: null,
    })
  })

  it('unbound with no gate unlocks as before', async () => {
    const f = makeVault({ now: { t: T0 } })
    await f.vault.setup({ password: PW, pin: PIN })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.status().sso).toEqual({ required: false })
  })

  it('setup refuses until signed in', async () => {
    const quick = fakeQuick()
    const f = makeVault({ quick, now: { t: T0 } })
    const gate = new FakeGate()
    f.vault.setSignInGate(gate)
    for (const v of ['needs-signin', 'blocked', 'mismatch'] as const) {
      gate.v = v
      await expect(f.vault.setup({ password: PW, pin: PIN, touchId: true })).rejects.toThrow('sign in with Microsoft first')
    }
    expect(quick.touchId.prompt).not.toHaveBeenCalled()
    expect(f.vault.status().setUp).toBe(false)
    expect(gate.noted).toBe(0)
    expect(f.audit.list({ limit: 100 }).filter((e) => e.action === 'vault.setup').map((e) => [e.outcome, e.details])).toEqual([
      ['failure', { reason: 'signin-required' }],
      ['failure', { reason: 'signin-required' }],
      ['failure', { reason: 'signin-required' }],
    ])
    gate.v = 'verified'
    expect((await f.vault.setup({ password: PW, pin: PIN, touchId: true })).unlocked).toBe(true)
    expect(gate.noted).toBe(1)
  })

  it('setup with a binding and no gate fails closed', async () => {
    const f = makeVault({ now: { t: T0 } })
    bindRow(f)
    await expect(f.vault.setup({ password: PW, pin: PIN })).rejects.toThrow('sign in with Microsoft first')
  })

  it('successful unlock calls noteUnlocked once', async () => {
    const f = await ready()
    f.gate.v = 'verified'
    await f.vault.unlock(PW)
    expect(f.gate.noted).toBe(1)
    // Already unlocked: nothing new was unlocked, so nothing is noted.
    await f.vault.unlockPin(PIN)
    await f.vault.unlockQuick()
    expect(f.gate.noted).toBe(1)
    f.vault.lock('manual')
    await f.vault.unlockPin(PIN)
    expect(f.gate.noted).toBe(2)
    f.vault.lock('manual')
    await f.vault.unlockQuick()
    expect(f.gate.noted).toBe(3)
    // A failed unlock notes nothing.
    f.vault.lock('manual')
    await f.vault.unlock('wrong password')
    expect(f.gate.noted).toBe(3)
  })

  it('a gate that throws in noteUnlocked does not undo the unlock', async () => {
    const f = await ready()
    f.gate.v = 'verified'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    f.gate.noteUnlocked = () => {
      throw new Error('db busy')
    }
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.isUnlocked()).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reverify while blocked refuses without counting', async () => {
    const f = await ready()
    f.gate.v = 'verified'
    await f.vault.unlock(PW)
    f.gate.v = 'blocked'
    const before = counters(f)
    expect(await f.vault.reverify({ method: 'pin', pin: '999999' })).toBe(false)
    expect(await f.vault.reverify({ method: 'password', password: 'wrong password' })).toBe(false)
    expect(await f.vault.reverify({ method: 'touchId' })).toBe(false)
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(counters(f)).toEqual(before)
    f.gate.v = 'verified'
    expect(await f.vault.reverify({ method: 'pin', pin: PIN })).toBe(true)
  })

  it('reset deletes the binding', async () => {
    const f = await ready()
    bindRow(f)
    await f.vault.reset('RESET')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sso_binding').get()).toEqual({ n: 0 })
    const row = f.audit.list({ limit: 100 }).find((e) => e.action === 'vault.reset')
    expect(row?.details).toMatchObject({ ssoUnbound: true })
  })

  it('status carries the gate state', async () => {
    const f = await ready()
    expect(f.vault.status().sso).toEqual({ required: false })
    f.gate.v = 'grace'
    expect(f.vault.status().sso).toEqual(f.gate.state())
    expect(f.vault.status().sso).toMatchObject({ required: true, verdict: 'grace' })
  })
})

class FakeHub implements SsoHub {
  checks: SessionCheck[] = []
  st: HubStatus = {
    linked: true,
    url: 'https://hub.example.com',
    hubId: 'hub-1',
    hubName: 'Team Hub',
    signedIn: true,
    signingIn: false,
    online: true,
    user: ALICE,
    sessionExpiresAt: null,
  }
  status(): HubStatus {
    return this.st
  }
  async checkSession(): Promise<SessionCheck> {
    const next = this.checks.shift()
    if (!next) throw new Error('no check queued')
    return next
  }
  async signIn(): Promise<HubStatus> {
    return this.st
  }
  async signOut(): Promise<HubStatus> {
    return this.st
  }
}

describe('vault with the real SsoGate', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a 403 during watch locks the vault with reason signin', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = makeVault({ now: { t: T0 } })
    const hub = new FakeHub()
    const gate = new SsoGate({ db: f.db, audit: f.audit, hub, now: () => f.now.t })
    f.vault.setSignInGate(gate)
    gate.onBlocked(() => f.vault.lock('signin'))
    hub.checks.push({ kind: 'ok', user: ALICE })
    expect(await gate.check()).toBe('verified')
    await f.vault.setup({ password: PW, pin: PIN })
    // Setup bound the account through noteUnlocked.
    expect(gate.isBound()).toBe(true)
    const reasons: LockReason[] = []
    f.vault.onLock((r) => void reasons.push(r))
    const stop = gate.watch(() => f.vault.isUnlocked())
    // The Hub answers 403 on /me: HubConnection reports that as disabled.
    hub.checks.push({ kind: 'disabled' })
    await vi.advanceTimersByTimeAsync(SSO_WATCH_MS)
    stop()
    expect(reasons).toEqual(['signin'])
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.vault.status().sso).toMatchObject({ required: true, verdict: 'blocked' })
    expect(await f.vault.unlock(PW)).toEqual(SIGNIN)
    // A second blocked verdict while locked is a no-op lock.
    f.vault.lock('signin')
    expect(reasons).toEqual(['signin'])
  })

  it('a check in flight at close() settles without touching the db', async () => {
    const f = makeVault({ now: { t: T0 } })
    const hub = new FakeHub()
    let answer!: (c: SessionCheck) => void
    hub.checkSession = () => new Promise<SessionCheck>((r) => (answer = r))
    const gate = new SsoGate({ db: f.db, audit: f.audit, hub, now: () => f.now.t })
    const pending = gate.check()
    gate.close()
    f.db.close()
    answer({ kind: 'disabled' })
    expect(await pending).toBe('needs-signin')
    expect(await gate.check()).toBe('needs-signin')
  })

  it('refuses another Hub while bound, and unlinking', async () => {
    const f = makeVault({ now: { t: T0 } })
    const gate = new SsoGate({ db: f.db, audit: f.audit, hub: new FakeHub(), now: () => f.now.t })
    expect(() => gate.assertMayLink('hub-2')).not.toThrow()
    expect(() => gate.assertMayUnlink()).not.toThrow()
    bindRow(f)
    expect(() => gate.assertMayLink('hub-1')).not.toThrow()
    expect(() => gate.assertMayLink('hub-2')).toThrow('Use Change Microsoft account to move to another Hub')
    expect(() => gate.assertMayUnlink()).toThrow('Disconnect from the vault settings')
  })
})
