import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_ID } from '../../src/shared/hub'
import { firstAdminWarning } from '../src/config'
import { testHub, type TestHub } from './helpers'

let hub: TestHub
afterEach(async () => hub.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'Admin@Example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }

const me = (token: string) =>
  hub.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })

describe('sessions and users', () => {
  it('first admin is bootstrapped into Default', async () => {
    hub = await testHub()
    const r = await hub.signIn(ADMIN)
    expect(r.status).toBe(201)
    expect(r.body.user).toMatchObject({ oid: ADMIN.oid, role: 'admin', status: 'active', groupIds: [DEFAULT_GROUP_ID] })
    expect(r.token).toMatch(/^ohs_/)
    expect((await me(r.token)).json().role).toBe('admin')
  })

  it('anyone else starts pending', async () => {
    hub = await testHub()
    const r = await hub.signIn(BOB)
    expect(r.status).toBe(201)
    expect(r.body.user).toMatchObject({ role: 'maintainer', status: 'pending', groupIds: [] })
  })

  it('bootstrap does not re-promote once an admin exists', async () => {
    hub = await testHub()
    await hub.signIn(ADMIN)
    const r = await hub.signIn({ ...ADMIN, oid: BOB.oid })
    expect(r.body.user).toMatchObject({ role: 'maintainer', status: 'pending' })
  })

  it('refreshes name and upn on every sign-in', async () => {
    hub = await testHub()
    await hub.signIn(BOB)
    const r = await hub.signIn({ ...BOB, name: 'Robert', upn: 'robert@example.com' })
    expect(r.body.user).toMatchObject({ name: 'Robert', upn: 'robert@example.com' })
  })

  it('session token is stored only as a hash', async () => {
    hub = await testHub()
    const { token } = await hub.signIn(ADMIN)
    const rows = hub.db.prepare('SELECT * FROM sessions').all() as Record<string, string>[]
    expect(rows).toHaveLength(1)
    expect(Object.values(rows[0])).not.toContain(token)
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hub.logs.join('')).not.toContain(token)
  })

  it('expired session is 401 session_expired and the row is gone', async () => {
    hub = await testHub()
    const { token } = await hub.signIn(ADMIN)
    hub.clock.now = new Date(hub.clock.now.getTime() + 13 * 3600_000)
    const res = await me(token)
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('session_expired')
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0)
  })

  it('missing or malformed bearer is 401 unauthenticated', async () => {
    hub = await testHub()
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/me' })).json().error).toBe('unauthenticated')
    expect((await me('nope')).json().error).toBe('unauthenticated')
  })

  it('revoked session is rejected', async () => {
    hub = await testHub()
    const { token } = await hub.signIn(ADMIN)
    const del = await hub.app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { authorization: `Bearer ${token}` } })
    expect(del.statusCode).toBe(204)
    expect((await me(token)).json().error).toBe('session_expired')
    expect(hub.audit.list({ actions: ['session.revoke'] })).toHaveLength(1)
  })

  it('a disabled user cannot create a session', async () => {
    hub = await testHub()
    const { token } = await hub.signIn(ADMIN)
    hub.db.prepare('UPDATE users SET disabled = 1 WHERE oid = ?').run(ADMIN.oid)
    expect((await me(token)).statusCode).toBe(403)
    const r = await hub.signIn(ADMIN)
    expect(r.status).toBe(403)
    expect(r.body.message).toBe('Your Hub account is disabled')
    const denied = hub.audit.list({ actions: ['session.denied'] })
    expect(denied).toHaveLength(1)
    expect(denied[0].details).toMatchObject({ reason: 'disabled' })
  })

  it('bad entra token is 401 and audited session.denied without the token', async () => {
    hub = await testHub()
    const bad = hub.entra.mintAccessToken({}, { key: 'rogue' })
    const res = await hub.app.inject({ method: 'POST', url: '/api/v1/session', headers: { authorization: `Bearer ${bad}` } })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain(bad)
    const ev = hub.audit.list({ actions: ['session.denied'] })
    expect(ev).toHaveLength(1)
    expect(ev[0].details).toEqual({ reason: 'signature', ip: '127.0.0.1' })
    expect(JSON.stringify(ev)).not.toContain(bad)
    expect(hub.logs.join('')).not.toContain(bad)
  })

  it('audits session.create with created, bootstrapped and pending', async () => {
    hub = await testHub()
    await hub.signIn(BOB)
    const ev = hub.audit.list({ actions: ['session.create'] })[0]
    expect(ev.details).toEqual({ created: true, bootstrapped: false, recovery: false, pending: true })
  })
})

describe('bootstrap recovery', () => {
  it('is flagged recovery after a previous bootstrap and never while an admin is enabled', async () => {
    hub = await testHub()
    await hub.signIn(ADMIN)
    hub.db.prepare("UPDATE users SET role = 'maintainer' WHERE oid = ?").run(ADMIN.oid)
    const r = await hub.signIn(ADMIN)
    expect(r.body.user.role).toBe('admin')
    const evs = hub.audit.list({ actions: ['session.create'] })
    expect(evs[0].details).toMatchObject({ bootstrapped: true, recovery: true })
    expect(evs[1].details).toMatchObject({ bootstrapped: true, recovery: false })
    await hub.signIn(ADMIN)
    expect(hub.audit.list({ actions: ['session.create'] })[0].details).toMatchObject({ bootstrapped: false, recovery: false })
  })
})

describe('bootstrap re-promotion', () => {
  it('promotes an existing firstAdmin match only once no enabled admin exists, and audits it', async () => {
    hub = await testHub({ firstAdmin: { oid: BOB.oid } })
    // An unrelated enabled admin exists first.
    hub.db.prepare("INSERT INTO users(oid, tid, upn, name, role, disabled, created_at) VALUES (?,?,?,?, 'admin', 0, 't')").run('dddddddd-dddd-4ddd-8ddd-dddddddddddd', hub.config.entra.tenantId, 'd@x.com', 'D')
    const first = await hub.signIn(BOB)
    expect(first.body.user).toMatchObject({ role: 'maintainer', status: 'pending' })
    expect(hub.audit.list({ actions: ['user.update'] })).toHaveLength(0)

    hub.db.prepare('UPDATE users SET disabled = 1 WHERE oid = ?').run('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const second = await hub.signIn(BOB)
    expect(second.body.user).toMatchObject({ role: 'admin', status: 'active' })
    const ev = hub.audit.list({ actions: ['user.update'] })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ targetType: 'user', targetId: BOB.oid, outcome: 'success' })
    expect(ev[0].details).toEqual({ op: 'bootstrap.repromote', from: 'maintainer', to: 'admin' })
  })

  it('a missing bearer on sign-in is audited as session.denied missing', async () => {
    hub = await testHub()
    const r = await hub.app.inject({ method: 'POST', url: '/api/v1/session' })
    expect(r.statusCode).toBe(401)
    expect(hub.audit.list({ actions: ['session.denied'] })[0].details).toEqual({ reason: 'missing', ip: '127.0.0.1' })
  })

  it('abandoned expired sessions are swept when a session is created', async () => {
    hub = await testHub()
    await hub.signIn(ADMIN)
    hub.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    expect((await hub.signIn(BOB)).status).toBe(201)
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1)
  })

  it('me reports the touched lastSeenAt', async () => {
    hub = await testHub()
    const { token } = await hub.signIn(BOB)
    hub.clock.now = new Date(hub.clock.now.getTime() + 5 * 60_000)
    const me = (await hub.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).json()
    expect(me.lastSeenAt).toBe(hub.clock.now.toISOString())
  })
})

describe('first admin matching', () => {
  it('with an oid configured, matches on oid only: a person holding the configured upn is not promoted', async () => {
    hub = await testHub({ firstAdmin: { oid: ADMIN.oid, upn: BOB.upn } })
    const bob = await hub.signIn(BOB)
    expect(bob.body.user).toMatchObject({ role: 'maintainer', status: 'pending' })
    const admin = await hub.signIn(ADMIN)
    expect(admin.body.user).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('the oid match ignores case, and a renamed upn does not matter', async () => {
    hub = await testHub({ firstAdmin: { oid: ADMIN.oid.toUpperCase() } })
    const r = await hub.signIn({ ...ADMIN, upn: 'renamed@example.com' })
    expect(r.body.user.role).toBe('admin')
  })

  it('with only a upn configured, keeps matching on upn and warns at startup', async () => {
    hub = await testHub({ firstAdmin: { upn: 'admin@example.com' } })
    expect((await hub.signIn(ADMIN)).body.user.role).toBe('admin')
    expect(hub.logs.join('')).toMatch(/firstAdmin is matched by upn only.*firstAdmin\.oid/)
  })

  it('no warning when an oid is configured', async () => {
    hub = await testHub({ firstAdmin: { oid: ADMIN.oid } })
    expect(hub.logs.join('')).not.toMatch(/firstAdmin is matched/)
    expect(firstAdminWarning({ firstAdmin: { oid: ADMIN.oid, upn: 'x@y' } })).toBeNull()
    expect(firstAdminWarning({ firstAdmin: { upn: 'x@y' } })).toMatch(/oid/)
  })
})
