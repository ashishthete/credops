import { afterEach, describe, expect, it } from 'vitest'
import { MAX_MANIFEST_BYTES, type HubEnvManifest } from '../../src/shared/hub'
import { testHub, type TestHub } from './helpers'
import { DEP_API, DEP_WEB, ENV_ID, HOST_ID, deployment, manifest, SECRET_DB } from './manifest'

let hub: TestHub
afterEach(async () => hub.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }

const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })
const put = (token: string, m: HubEnvManifest) => call(token, 'PUT', `/api/v1/admin/environments/${m.environment.id}`, m)

async function setup() {
  hub = await testHub()
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  return { admin, bob }
}

/** Bob in a fresh group; returns helpers to grant him things. */
async function bobInGroup(admin: string) {
  const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Ops' })).json().id as string
  await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
  await call(admin, 'DELETE', `/api/v1/admin/groups/00000000-0000-4000-8000-000000000001/members/${BOB.oid}`).catch(() => undefined)
  return g
}

describe('environment registry', () => {
  it('a Hub-wide row with a required secret id does not hide a missing secret', async () => {
    const { admin } = await setup()
    const m = manifest()
    const id = m.requiredSecrets[0].secretId
    await put(admin, m)
    hub.db
      .prepare("INSERT INTO hub_secrets(id, environment_id, name, kind, value_enc, key_id, updated_by, updated_at) VALUES (?, NULL, 'wide', 'env', 'x', 'k', 'u', 'now')")
      .run(id)
    const r = await put(admin, m)
    expect(r.json().missingSecrets).toContain(id)
  })

  it('publish stores the manifest and returns missing secrets', async () => {
    const { admin } = await setup()
    const m = manifest()
    const r = await put(admin, m)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.missingSecrets.sort()).toEqual(m.requiredSecrets.map((s) => s.secretId).sort())
    const got = await call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}`)
    expect(got.statusCode).toBe(200)
    expect(got.json()).toEqual(m)
    const audit = hub.audit.list({ actions: ['env.publish'] })
    expect(audit).toHaveLength(1)
    expect(audit[0].details).toEqual({ name: 'prod', hosts: 1, deployments: 2, manifestHash: body.manifestHash })
    expect(JSON.stringify(audit)).not.toContain('10.0.0.5')
  })

  it('the same state hashes the same regardless of list order', async () => {
    const { admin } = await setup()
    const a = (await put(admin, manifest())).json().manifestHash
    const m = manifest()
    m.deployments.reverse()
    m.requiredSecrets.reverse()
    expect((await put(admin, m)).json().manifestHash).toBe(a)
  })

  it('orders by code point, not by locale', async () => {
    const { admin } = await setup()
    // localeCompare puts "a" before "B"; code-point order puts "B" first.
    const m = manifest({ deployments: [deployment(DEP_WEB, 'a'), deployment(DEP_API, 'B')], requiredSecrets: [] })
    expect((await put(admin, m)).statusCode).toBe(200)
    const got = (await call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}`)).json() as { deployments: { name: string }[] }
    expect(got.deployments.map((d) => d.name)).toEqual(['B', 'a'])
  })

  it('rejects a deployment on an unknown host', async () => {
    const { admin } = await setup()
    const m = manifest({ deployments: [deployment(DEP_WEB, 'web', { hostId: 'a9999999-9999-4999-8999-999999999999' })], requiredSecrets: [] })
    const r = await put(admin, m)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('bad_request')
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM environments').get()).toEqual({ n: 0 })
  })

  it('refuses a repository URL with credentials without echoing or storing it', async () => {
    const { admin } = await setup()
    const url = 'https://ghp_secrettoken123@github.com/acme/web.git'
    const r = await put(admin, manifest({ deployments: [deployment(DEP_WEB, 'web', { repoUrl: url })], requiredSecrets: [] }))
    expect(r.statusCode).toBe(400)
    expect(r.body).not.toContain('ghp_secrettoken123')
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM environments').get()).toEqual({ n: 0 })
    const dump = JSON.stringify([hub.db.prepare('SELECT * FROM audit').all(), hub.db.prepare('SELECT * FROM deployments').all()])
    expect(dump).not.toContain('ghp_secrettoken123')
    for (const bad of ['ssh://user:pw-fake-1@github.com/acme/web.git', 'HTTPS://tok-fake-2@github.com/acme/web.git', 'https://user:pw-fake-3@github.com/acme/web.git']) {
      const r2 = await put(admin, manifest({ deployments: [deployment(DEP_WEB, 'web', { repoUrl: bad })], requiredSecrets: [] }))
      expect(r2.statusCode, bad).toBe(400)
      expect(r2.body).not.toMatch(/fake-\d/)
    }
    const ok = await put(admin, manifest({ deployments: [deployment(DEP_WEB, 'web', { repoUrl: 'git@github.com:acme/web.git', composeProject: 'web' })], requiredSecrets: [] }))
    expect(ok.statusCode).toBe(200)
  })

  it('validates services and shows them with their checkout', async () => {
    const { admin, bob } = await setup()
    const base = manifest()
    const host = base.hosts[0].id
    const SVC = 'c1111111-1111-4111-8111-111111111111'
    const DB = 'c2222222-2222-4222-8222-222222222222'
    const svc = (over: object) => ({ id: SVC, name: 'web', kind: 'service', composeService: 'web', deploymentId: DEP_API, hostId: host, viaHostId: null, ...over })
    const LOOSE = 'c3333333-3333-4333-8333-333333333333'
    const dbs = { id: DB, name: 'main-db', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: host }
    const withServices = (services: unknown[]) => ({ ...base, services }) as HubEnvManifest
    for (const bad of [
      [svc({ deploymentId: 'd9999999-9999-4999-8999-999999999999' })],
      [svc({ hostId: null })],
      [svc({ composeService: 'Bad Name' })],
      [svc({ viaHostId: host })],
      [svc({}), svc({})],
      [{ ...dbs, deploymentId: DEP_API }],
      [{ ...dbs, viaHostId: 'a9999999-9999-4999-8999-999999999999' }],
    ]) {
      expect((await put(admin, withServices(bad))).statusCode).toBe(400)
    }
    const unknownDep = await put(admin, withServices([svc({ deploymentId: 'd9999999-9999-4999-8999-999999999999' })]))
    expect(unknownDep.json().message).toContain('not one of the manifest deployments')
    const unknownVia = await put(admin, withServices([{ ...dbs, viaHostId: 'a9999999-9999-4999-8999-999999999999' }]))
    expect(unknownVia.json().message).toContain('viaHostId is not one of the manifest hosts')
    const loose = svc({ id: LOOSE, name: 'loose', deploymentId: null, hostId: null })
    expect((await put(admin, withServices([svc({}), loose, dbs]))).statusCode).toBe(200)

    const g = await bobInGroup(admin)
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_API } })
    const cat = (await call(bob, 'GET', '/api/v1/catalog')).json() as { services: { id: string }[] }[]
    expect(cat[0].services.map((x) => x.id)).toEqual([SVC])
    const full = (await call(admin, 'GET', '/api/v1/catalog')).json() as { services: { id: string }[] }[]
    expect(full[0].services.map((x) => x.id).sort()).toEqual([SVC, DB, LOOSE].sort())
  })

  it('rejects an env template ref not in requiredSecrets', async () => {
    const { admin } = await setup()
    const m = manifest({ requiredSecrets: [] })
    const r = await put(admin, m)
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('uses a secret that is not in requiredSecrets')
    expect(JSON.stringify(r.json())).not.toContain(SECRET_DB)
  })

  it('rejects a bad env template, a mismatched id and an oversize manifest', async () => {
    const { admin } = await setup()
    const bad = manifest({ deployments: [deployment(DEP_WEB, 'web', { managedEnv: true, envTemplate: 'not a line' })], requiredSecrets: [] })
    const badRes = await put(admin, bad)
    expect(badRes.statusCode).toBe(400)
    expect(badRes.json().message).toContain('envTemplate is not a valid .env template')
    const other = await call(admin, 'PUT', '/api/v1/admin/environments/e2222222-2222-4222-8222-222222222222', manifest())
    expect(other.statusCode).toBe(400)
    expect(other.json().message).toBe('invalid request: /environment/id must match the path')
    const big = manifest({ requiredSecrets: [{ secretId: SECRET_DB, name: 'x'.repeat(MAX_MANIFEST_BYTES), usedBy: [] }] })
    const bigRes = await put(admin, big)
    expect(bigRes.statusCode).toBe(413)
    expect(bigRes.json()).toEqual({ error: 'bad_request', message: 'Request body too large' })
  })

  it('refuses a hop chain whose last hop is not the host', async () => {
    const { admin } = await setup()
    const m = manifest()
    m.hosts[0].hops[1].address = '10.9.9.9'
    expect((await put(admin, m)).statusCode).toBe(400)
  })

  it('republish replaces rows atomically', async () => {
    const { admin } = await setup()
    await put(admin, manifest())
    const next = manifest({ deployments: [deployment(DEP_API, 'api'), deployment('d3333333-3333-4333-8333-333333333333', 'worker', { position: 1 })], requiredSecrets: [] })
    expect((await put(admin, next)).statusCode).toBe(200)
    const ids = (hub.db.prepare('SELECT id FROM deployments ORDER BY name').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toEqual([DEP_API, 'd3333333-3333-4333-8333-333333333333'])
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM hosts').get()).toEqual({ n: 1 })

    // A failing republish leaves the previous state untouched.
    const before = JSON.stringify(hub.db.prepare('SELECT * FROM deployments ORDER BY id').all())
    hub.db.exec('CREATE TRIGGER boom BEFORE INSERT ON services BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    const withApp = manifest({ services: [{ id: 'b1111111-1111-4111-8111-111111111111', name: 'shop', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: null }], deployments: [deployment(DEP_WEB, 'web')], requiredSecrets: [] })
    expect((await put(admin, withApp)).statusCode).toBe(500)
    expect(JSON.stringify(hub.db.prepare('SELECT * FROM deployments ORDER BY id').all())).toBe(before)
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE environment_id NOT IN (SELECT id FROM environments)").get()).toEqual({ n: 0 })
  })

  it('republish drops grants for deployments that no longer exist', async () => {
    const { admin } = await setup()
    await put(admin, manifest())
    const g = await bobInGroup(admin)
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_WEB } })
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_API } })
    await put(admin, manifest({ deployments: [deployment(DEP_API, 'api')], requiredSecrets: [] }))
    const left = hub.db.prepare('SELECT deployment_id FROM grants WHERE group_id = ?').all(g) as { deployment_id: string }[]
    expect(left.map((r) => r.deployment_id)).toEqual([DEP_API])
  })

  it('catalog is filtered by grants', async () => {
    const { admin, bob } = await setup()
    await put(admin, manifest())
    const other = manifest()
    other.environment = { ...other.environment, id: 'e2222222-2222-4222-8222-222222222222', name: 'staging', protected: false }
    other.hosts = [{ ...other.hosts[0], id: 'a3333333-3333-4333-8333-333333333333', hops: [{ ...other.hosts[0].hops[1], hostId: 'a3333333-3333-4333-8333-333333333333' }] }]
    other.deployments = [deployment('d4444444-4444-4444-8444-444444444444', 'stg', { environmentId: other.environment.id, hostId: other.hosts[0].id })]
    other.requiredSecrets = []
    expect((await put(admin, other)).statusCode).toBe(200)

    // Pending: sees nothing.
    expect((await call(bob, 'GET', '/api/v1/catalog')).json()).toEqual([])

    const g = await bobInGroup(admin)
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_API } })
    const r = await call(bob, 'GET', '/api/v1/catalog')
    expect(r.statusCode).toBe(200)
    const cat = r.json() as { environment: { id: string }; deployments: { id: string }[]; hosts: unknown[] }[]
    expect(cat.map((e) => e.environment.id)).toEqual([ENV_ID])
    expect(cat[0].deployments.map((d) => d.id)).toEqual([DEP_API])
    const text = r.body
    for (const secret of ['address', '10.0.0.5', '203.0.113.9', 'knownHosts', 'hops', 'ssh-ed25519', 'username']) expect(text).not.toContain(secret)

    // Admins see everything in the catalog; the full manifest only via the admin route.
    const adm = (await call(admin, 'GET', '/api/v1/catalog')).json() as unknown[]
    expect(adm).toHaveLength(2)
    expect((await call(bob, 'GET', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(403)
    expect((await call(bob, 'GET', '/api/v1/admin/environments')).statusCode).toBe(403)
    const list = (await call(admin, 'GET', '/api/v1/admin/environments')).json() as { environment: { name: string } }[]
    expect(list.map((e) => e.environment.name).sort()).toEqual(['prod', 'staging'])
  })

  it('a partial viewer never gets a db via-host that no visible checkout uses', async () => {
    const { admin, bob } = await setup()
    const VIA = 'a4444444-4444-4444-8444-444444444444'
    const m = manifest()
    m.hosts = [...m.hosts, { ...m.hosts[0], id: VIA, label: 'db-box', address: '10.9.9.9', hops: [{ ...m.hosts[0].hops[1], hostId: VIA, label: 'db-box', address: '10.9.9.9' }] }]
    m.services = [{ id: '75555555-5555-4555-8555-555555555555', name: 'pg', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: VIA }]
    expect((await put(admin, m)).statusCode).toBe(200)
    const g = await bobInGroup(admin)
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_API } })
    const r = await call(bob, 'GET', '/api/v1/catalog')
    const cat = r.json() as { hosts: { id: string }[]; services: unknown[] }[]
    expect(cat[0].hosts.map((h) => h.id)).toEqual([HOST_ID])
    expect(cat[0].services).toEqual([])
    expect(r.body).not.toContain('db-box')
    expect(r.body).not.toContain('10.9.9.9')
  })

  it('unpublish drops grants that reference the environment', async () => {
    const { admin } = await setup()
    await put(admin, manifest())
    const g = await bobInGroup(admin)
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_WEB } })
    const r = await call(admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)
    expect(r.statusCode).toBe(204)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM grants WHERE group_id = ?').get(g)).toEqual({ n: 0 })
    for (const t of ['hosts', 'deployments']) expect(hub.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 })
    // The row stays, marked, for its release history.
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM environments WHERE unpublished_at IS NOT NULL').get()).toEqual({ n: 1 })
    const audit = hub.audit.list({ actions: ['env.unpublish'] })
    expect(audit).toHaveLength(1)
    expect(audit[0].details).toMatchObject({ name: 'prod' })
    expect((await call(admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(404)
  })

  it('a grant needs a published environment or deployment', async () => {
    const { admin } = await setup()
    const g = await bobInGroup(admin)
    const noEnv = await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })
    expect(noEnv.statusCode).toBe(404)
    await put(admin, manifest())
    const noDep = await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: 'd9999999-9999-4999-8999-999999999999' } })
    expect(noDep.statusCode).toBe(404)
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })).statusCode).toBe(201)
  })

  it('publish and unpublish are refused while a release lock is held', async () => {
    const { admin } = await setup()
    await put(admin, manifest())
    hub.db.prepare("INSERT INTO env_locks(environment_id, kind, release_id, holder_oid, holder_name, reason, created_at, expires_at) VALUES (?, 'release', 'r1', 'o', 'Zed', NULL, 't', NULL)").run(ENV_ID)
    const before = hub.audit.list().length
    for (const r of [await put(admin, manifest()), await call(admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)]) {
      expect(r.statusCode).toBe(409)
      expect(r.json()).toEqual({ error: 'conflict', message: 'A release is running on prod' })
    }
    expect(hub.audit.list().length).toBe(before)
    // A manual freeze does not block a publish.
    hub.db.exec('DELETE FROM env_locks')
    hub.db.prepare("INSERT INTO env_locks(environment_id, kind, release_id, holder_oid, holder_name, reason, created_at, expires_at) VALUES (?, 'manual', NULL, 'o', 'Zed', 'x', 't', 'later')").run(ENV_ID)
    expect((await put(admin, manifest())).statusCode).toBe(200)
  })

  it('publish is admin only', async () => {
    const { admin, bob } = await setup()
    await call(admin, 'POST', '/api/v1/admin/groups/00000000-0000-4000-8000-000000000001/members', { oids: [BOB.oid] })
    const r = await put(bob, manifest())
    expect(r.statusCode).toBe(403)
    expect((await call(bob, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(403)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM environments').get()).toEqual({ n: 0 })
    expect((await hub.app.inject({ method: 'PUT', url: `/api/v1/admin/environments/${ENV_ID}`, payload: manifest() })).statusCode).toBe(401)
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/catalog' })).statusCode).toBe(401)
  })
})
