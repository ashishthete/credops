import { describe, expect, it, vi } from 'vitest'
import { SsoGate, type SsoHub } from '../../src/main/auth/sso-gate'
import { createAuthHandlers } from '../../src/main/ipc/handlers/auth'
import type { HubStatus, HubUser } from '../../src/shared/hub'
import type { SessionCheck } from '../../src/shared/sso'
import { verificationFailedError } from '../../src/shared/vault'
import { fakeQuick, makeVault } from './vault-helpers'

const PW = 'correct horse'
const PIN = '204816'
const T0 = Date.parse('2026-10-21T08:00:00.000Z')

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

const LINKED: HubStatus = {
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

/** The Hub as the gate and the handlers see it; no network. */
class FakeHub implements SsoHub {
  st: HubStatus = LINKED
  checks: SessionCheck[] = []
  status(): HubStatus {
    return this.st
  }
  checkSession = vi.fn(async (): Promise<SessionCheck> => this.checks.shift() ?? { kind: 'offline' })
  signIn = vi.fn(async (): Promise<HubStatus> => (this.st = LINKED))
  signOut = vi.fn(async (): Promise<HubStatus> => {
    if (this.st.linked) this.st = { ...this.st, signedIn: false, user: null }
    return this.st
  })
  unlink = vi.fn(async (): Promise<HubStatus> => (this.st = { linked: false }))
}

/** Set up with a password and a PIN, unlocked, bound to Alice on hub-1. */
async function ready(quick = fakeQuick()) {
  const now = { t: T0 }
  const f = makeVault({ now, quick })
  await f.vault.setup({ password: PW, pin: PIN, touchId: true })
  const hub = new FakeHub()
  const gate = new SsoGate({ db: f.db, audit: f.audit, hub, now: () => now.t })
  f.vault.setSignInGate(gate)
  f.db
    .prepare('INSERT INTO sso_binding(id, hub_id, user_oid, user_upn, bound_at, last_verified_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('hub-1', ALICE.oid, ALICE.upn, new Date(T0).toISOString(), new Date(T0).toISOString())
  const h = createAuthHandlers({ vault: f.vault, gate, hub })
  const binding = () => f.db.prepare('SELECT * FROM sso_binding WHERE id = 1').get()
  return { ...f, hub, gate, h, binding }
}

describe('createAuthHandlers', () => {
  it('auth:check forces a check and returns the status', async () => {
    const r = await ready()
    r.hub.checks.push({ kind: 'ok', user: ALICE })
    const status = await r.h['auth:check']()
    expect(r.hub.checkSession).toHaveBeenCalledTimes(1)
    expect(status.sso).toMatchObject({ required: true, verdict: 'verified' })
    expect(status.unlocked).toBe(true)
  })

  it('auth:signIn signs in interactively and returns the status', async () => {
    const r = await ready()
    const status = await r.h['auth:signIn']()
    expect(r.hub.signIn).toHaveBeenCalledTimes(1)
    expect(status.sso).toMatchObject({ verdict: 'verified' })
  })

  it('auth:changeAccount with a wrong PIN fails verification and never rebinds', async () => {
    const r = await ready()
    const rebind = vi.spyOn(r.gate, 'rebind')
    await expect(r.h['auth:changeAccount']({ method: 'pin', pin: '999999' })).rejects.toThrow(verificationFailedError())
    expect(rebind).not.toHaveBeenCalled()
    expect(r.hub.signIn).not.toHaveBeenCalled()
  })

  it('auth:changeAccount rebinds after a reverify', async () => {
    const r = await ready()
    const res = await r.h['auth:changeAccount']({ method: 'password', password: PW })
    expect(res).toMatchObject({ ok: true, status: { sso: { verdict: 'verified' } } })
    expect(r.hub.signIn).toHaveBeenCalledTimes(1)
  })

  it('auth:disconnect deletes the binding and unlinks', async () => {
    const r = await ready()
    const res = await r.h['auth:disconnect']({ method: 'pin', pin: PIN })
    expect(res).toMatchObject({ ok: true, status: { sso: { required: false } } })
    expect(r.binding()).toBeUndefined()
    expect(r.hub.unlink).toHaveBeenCalledTimes(1)
  })

  it('auth:disconnect with a wrong password keeps the binding and the link', async () => {
    const r = await ready()
    await expect(r.h['auth:disconnect']({ method: 'password', password: 'wrong horse' })).rejects.toThrow(
      verificationFailedError(),
    )
    expect(r.binding()).toBeDefined()
    expect(r.hub.unlink).not.toHaveBeenCalled()
  })

  it('auth:disconnect that fails to unlink fails closed: unbound, still linked, still gated', async () => {
    // Unbind runs first; a linked Hub keeps sign-in required (and rebinds at the next unlock), so the
    // half-done state gates exactly as before and the user retries.
    const r = await ready()
    r.hub.unlink.mockRejectedValueOnce(new Error('hub down'))
    await expect(r.h['auth:disconnect']({ method: 'pin', pin: PIN })).rejects.toThrow('hub down')
    expect(r.binding()).toBeUndefined()
    expect(r.hub.status()).toMatchObject({ linked: true, signedIn: true })
    expect(r.vault.status()).toMatchObject({ unlocked: true, sso: { required: true } })
  })

  it('the Touch ID prompt names the account change', async () => {
    const quick = fakeQuick()
    const r = await ready(quick)
    await r.h['auth:changeAccount']({ method: 'touchId' })
    expect(quick.touchId.prompt).toHaveBeenLastCalledWith('change the Microsoft account in CredOps')
  })

  it("auth:signOut signs out, forgets the verification and locks with reason 'manual'", async () => {
    const r = await ready()
    const lock = vi.spyOn(r.vault, 'lock')
    const status = await r.h['auth:signOut']()
    expect(r.hub.signOut).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenCalledWith('manual')
    expect(status.unlocked).toBe(false)
    expect(status.sso).toMatchObject({ verdict: 'needs-signin', lastVerifiedAt: null })
  })

  it('auth:signOut still locks when the Hub sign-out throws', async () => {
    const r = await ready()
    r.hub.signOut.mockRejectedValueOnce(new Error('db gone'))
    await expect(r.h['auth:signOut']()).rejects.toThrow('db gone')
    expect(r.vault.isUnlocked()).toBe(false)
    expect(r.gate.verdict()).toBe('needs-signin')
  })

  it('hub:signOut goes through the gate: the verification is forgotten', async () => {
    const r = await ready()
    r.hub.checks.push({ kind: 'ok', user: ALICE })
    await r.gate.check({ force: true })
    const res = await r.h['hub:signOut']()
    expect(res).toMatchObject({ linked: true, signedIn: false })
    expect(r.gate.state()).toMatchObject({ verdict: 'needs-signin', lastVerifiedAt: null })
    // The Hub's own button keeps its rule: only while unlocked.
    r.vault.lock('manual')
    await expect(r.h['hub:signOut']()).rejects.toThrow('vault locked')
  })
})
