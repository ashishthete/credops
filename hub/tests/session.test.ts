import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_ID } from '../../src/shared/hub'
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
    expect(ev[0].details).toEqual({ reason: 'signature' })
    expect(JSON.stringify(ev)).not.toContain(bad)
    expect(hub.logs.join('')).not.toContain(bad)
  })

  it('audits session.create with created, bootstrapped and pending', async () => {
    hub = await testHub()
    await hub.signIn(BOB)
    const ev = hub.audit.list({ actions: ['session.create'] })[0]
    expect(ev.details).toEqual({ created: true, bootstrapped: false, pending: true })
  })
})
