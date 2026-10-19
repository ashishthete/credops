import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_ID } from '../../src/shared/hub'
import { testHub, type TestHub } from './helpers'

let hub: TestHub
afterEach(async () => hub.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const CAROL = { oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', upn: 'carol@example.com', name: 'Carol' }
const E1 = 'e1111111-1111-4111-8111-111111111111'

const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })

async function setup() {
  hub = await testHub()
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const carol = (await hub.signIn(CAROL)).token
  return { admin, bob, carol }
}

const snapshot = (): string =>
  JSON.stringify(
    ['users', 'groups', 'group_members', 'grants', 'sessions'].map((t) => hub.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()),
  )

async function createGroup(admin: string, name: string) {
  const r = await call(admin, 'POST', '/api/v1/admin/groups', { name, description: '' })
  expect(r.statusCode).toBe(201)
  return r.json().id as string
}

describe('admin api', () => {
  it('admin adds all pending people to Default in one call', async () => {
    const { admin } = await setup()
    const r = await call(admin, 'POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members`, { oids: [BOB.oid, CAROL.oid] })
    expect(r.statusCode).toBe(200)
    const users = (await call(admin, 'GET', '/api/v1/admin/users')).json() as { oid: string; status: string }[]
    expect(users.filter((u) => u.oid !== ADMIN.oid).map((u) => u.status)).toEqual(['active', 'active'])
  })

  it('unknown oids are 404 and add nothing', async () => {
    const { admin } = await setup()
    const before = snapshot()
    const r = await call(admin, 'POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members`, { oids: [BOB.oid, 'ffffffff-ffff-4fff-8fff-ffffffffffff'] })
    expect(r.statusCode).toBe(404)
    expect(snapshot()).toBe(before)
  })

  it('the group invariant holds on every path', async () => {
    const { admin } = await setup()
    await call(admin, 'POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members`, { oids: [BOB.oid, CAROL.oid] })
    const g2 = await createGroup(admin, 'G2')
    await call(admin, 'POST', `/api/v1/admin/groups/${g2}/members`, { oids: [CAROL.oid] })
    expect((await call(admin, 'DELETE', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members/${CAROL.oid}`)).statusCode).toBe(204)

    const before = snapshot()
    const expectRefused = async (r: ReturnType<typeof call>, code: string) => {
      const res = await r
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe(code)
      expect(snapshot()).toBe(before)
    }
    await expectRefused(call(admin, 'DELETE', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members/${BOB.oid}`), 'last_group')
    await expectRefused(call(admin, 'DELETE', `/api/v1/admin/groups/${g2}`), 'last_group')
    await expectRefused(call(admin, 'DELETE', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}`), 'builtin_group')
    await expectRefused(call(admin, 'POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/grants`, { scope: { kind: 'environment', environmentId: E1 } }), 'builtin_group')
    await expectRefused(call(admin, 'PATCH', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}`, { name: 'Renamed' }), 'builtin_group')
    await expectRefused(call(admin, 'PATCH', `/api/v1/admin/users/${ADMIN.oid}`, { role: 'maintainer' }), 'last_admin')
    await expectRefused(call(admin, 'PATCH', `/api/v1/admin/users/${ADMIN.oid}`, { disabled: true }), 'last_admin')
  })

  it('duplicate grants conflict and bad ids are 400', async () => {
    const { admin } = await setup()
    const g = await createGroup(admin, 'Pay')
    const scope = { kind: 'environment', environmentId: E1 }
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope })).statusCode).toBe(201)
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope })).json().error).toBe('conflict')
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: 'nope' } })).statusCode).toBe(400)
    expect((await call(admin, 'POST', '/api/v1/admin/groups', { name: 'bad/name', description: '' })).statusCode).toBe(400)
  })

  it('maintainer gets 403 on every admin route; anonymous gets 401', async () => {
    const { bob } = await setup()
    const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE', string][] = [
      ['GET', '/api/v1/admin/users'],
      ['PATCH', `/api/v1/admin/users/${BOB.oid}`],
      ['GET', '/api/v1/admin/groups'],
      ['POST', '/api/v1/admin/groups'],
      ['PATCH', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}`],
      ['DELETE', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}`],
      ['POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members`],
      ['DELETE', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members/${BOB.oid}`],
      ['POST', `/api/v1/admin/groups/${DEFAULT_GROUP_ID}/grants`],
      ['DELETE', `/api/v1/admin/grants/${DEFAULT_GROUP_ID}`],
      ['GET', '/api/v1/admin/audit'],
      ['POST', '/api/v1/admin/audit/verify'],
    ]
    for (const [m, url] of routes) {
      const r = await call(bob, m, url, m === 'GET' || m === 'DELETE' ? undefined : {})
      expect([m, url, r.statusCode]).toEqual([m, url, 403])
      expect(r.json().message).toBe('Admins only')
      expect((await hub.app.inject({ method: m, url })).statusCode).toBe(401)
    }
  })

  it('authorization changes apply on the next request', async () => {
    const { admin, bob } = await setup()
    const g = await createGroup(admin, 'Pay')
    const grant = (await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: E1 } })).json()
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
    const q = `/api/v1/access?action=release.start&environmentId=${E1}`
    expect((await call(bob, 'GET', q)).json()).toMatchObject({ allowed: true, via: { groupName: 'Pay' } })
    expect((await call(admin, 'DELETE', `/api/v1/admin/grants/${grant.id}`)).statusCode).toBe(204)
    expect((await call(bob, 'GET', q)).json()).toMatchObject({ allowed: false, code: 'no_grant' })
    expect((await call(admin, 'PATCH', `/api/v1/admin/users/${BOB.oid}`, { disabled: true })).statusCode).toBe(200)
    // revokeAll removed the session, so the next call is session_expired; a fresh sign-in is 403.
    expect((await call(bob, 'GET', q)).statusCode).toBe(401)
    expect((await hub.signIn(BOB)).status).toBe(403)
  })

  it('access query validates its input', async () => {
    const { bob } = await setup()
    expect((await call(bob, 'GET', '/api/v1/access?action=bogus&environmentId=x')).statusCode).toBe(400)
  })

  it('every mutation is audited with the admin actor, and the chain verifies', async () => {
    const { admin } = await setup()
    const g = await createGroup(admin, 'Pay')
    await call(admin, 'PATCH', `/api/v1/admin/groups/${g}`, { description: 'x' })
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
    const gr = (await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'all' } })).json()
    await call(admin, 'DELETE', `/api/v1/admin/grants/${gr.id}`)
    await call(admin, 'DELETE', `/api/v1/admin/groups/${g}/members/${BOB.oid}`).catch(() => null)
    await call(admin, 'PATCH', `/api/v1/admin/users/${CAROL.oid}`, { role: 'admin' })
    await call(admin, 'DELETE', `/api/v1/admin/groups/${g}`).catch(() => null)
    expect((await call(admin, 'POST', '/api/v1/admin/audit/verify')).json()).toMatchObject({ ok: true })
    const evs = hub.audit.list({ actions: ['group.create', 'group.update', 'member.add', 'grant.add', 'grant.remove', 'user.update', 'audit.verify'] })
    expect(new Set(evs.map((e) => e.action))).toEqual(new Set(['group.create', 'group.update', 'member.add', 'grant.add', 'grant.remove', 'user.update', 'audit.verify']))
    for (const e of evs) {
      expect(e.actor?.oid).toBe(ADMIN.oid)
      expect(e.viaGroup).toBeNull()
    }
    const list = (await call(admin, 'GET', '/api/v1/admin/audit?actions=group.create&limit=5')).json()
    expect(list).toHaveLength(1)
    expect(hub.audit.verify().ok).toBe(true)
  })

  it('disabling a user revokes their sessions', async () => {
    const { admin } = await setup()
    await call(admin, 'PATCH', `/api/v1/admin/users/${BOB.oid}`, { disabled: true })
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE oid = ?').get(BOB.oid) as { n: number }).n).toBe(0)
  })
})
