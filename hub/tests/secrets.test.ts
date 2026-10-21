import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SECRET_BYTES } from '../../src/shared/hub'
import { installErrorHandler } from '../src/errors'
import { createMasterKeyFile, KeyRing, loadMasterKey } from '../src/secrets/keyring'
import { registerSecrets } from '../src/routes/secrets'
import { EnvLocks } from '../src/locks'
import { DeployKeys } from '../src/secrets/deploykeys'
import { SecretStore } from '../src/secrets/store'
import { openHubDb } from '../src/db'
import { testHub, type TestHub } from './helpers'
import { ENV_ID, manifest, SECRET_DB, SECRET_SUDO } from './manifest'

let hub: TestHub
const cleanup: (() => void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn()
  await hub?.close()
  hub = undefined as never
})

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const SENTINEL = `HUBSECRET-${randomBytes(8).toString('hex')}`

const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })

async function setup() {
  hub = await testHub()
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, manifest())).statusCode).toBe(200)
  return { admin, bob }
}
const ENV2 = 'e2222222-2222-4222-8222-222222222222'
const ENV3 = 'e3333333-3333-4333-8333-333333333333'
async function publishSecond(admin: string): Promise<void> {
  for (const [id, name] of [[ENV2, 'staging'], [ENV3, 'qa']]) {
    const m = manifest()
    m.environment = { ...m.environment, id, name }
    m.hosts = []
    m.deployments = []
    const r = await call(admin, 'PUT', `/api/v1/admin/environments/${id}`, m)
    expect(r.statusCode, r.body).toBe(200)
  }
}
const putSecret = (token: string, id: string, body: object) => call(token, 'PUT', `/api/v1/admin/secrets/${id}`, body)
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'opsdeck-mk-'))
  cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

describe('shared secrets', () => {
  it('no secret plaintext at rest or in any response', async () => {
    const { admin } = await setup()
    const bodies: string[] = []
    const keep = async (p: ReturnType<typeof call>) => {
      const r = await p
      bodies.push(r.body)
      return r
    }
    expect((await keep(putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: SENTINEL }))).statusCode).toBe(204)
    expect((await keep(putSecret(admin, '53333333-3333-4333-8333-333333333333', { environmentId: ENV_ID, name: 'teams_webhook', kind: 'teams_webhook', value: `https://hooks.example.com/${SENTINEL}` }))).statusCode).toBe(204)
    const key = await keep(call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`))
    expect(key.statusCode).toBe(200)
    await keep(call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}/deploy-key`))
    await keep(call(admin, 'GET', '/api/v1/admin/secrets'))
    await keep(call(admin, 'GET', `/api/v1/admin/secrets?environmentId=${ENV_ID}`))
    await keep(call(admin, 'GET', '/api/v1/admin/audit'))
    await keep(call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}`))
    await keep(call(admin, 'GET', '/api/v1/catalog'))
    for (const b of bodies) expect(b).not.toContain(SENTINEL)
    expect(bodies.join('')).not.toContain('PRIVATE KEY')

    hub.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    for (const f of ['hub.db', 'hub.db-wal']) {
      const path = join(hub.config.dataDir, f)
      if (existsSync(path)) expect(readFileSync(path).includes(SENTINEL)).toBe(false)
    }
    expect(hub.logs.join('')).not.toContain(SENTINEL)
    expect(JSON.stringify(hub.audit.list({ limit: 1000 }))).not.toContain(SENTINEL)
    expect(JSON.stringify(hub.db.prepare('SELECT * FROM audit').all())).not.toContain(SENTINEL)
    const audited = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'secret.set').reverse()
    expect(audited.map((e) => e.details)).toEqual([
      { name: 'DB_PASSWORD', kind: 'env', environmentId: ENV_ID },
      { name: 'teams_webhook', kind: 'teams_webhook', environmentId: ENV_ID },
    ])
  })

  it('maintainer gets 403 and nothing changes', async () => {
    const { bob, admin } = await setup()
    const group = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Ops' })).json().id as string
    await call(admin, 'POST', `/api/v1/admin/groups/${group}/members`, { oids: [BOB.oid] })
    const reqs: [string, string, object?][] = [
      ['GET', '/api/v1/admin/secrets'],
      ['PUT', `/api/v1/admin/secrets/${SECRET_DB}`, { environmentId: ENV_ID, name: 'x', kind: 'env', value: SENTINEL }],
      ['DELETE', `/api/v1/admin/secrets/${SECRET_DB}`],
      ['POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`],
      ['GET', `/api/v1/admin/environments/${ENV_ID}/deploy-key`],
    ]
    for (const [m, u, p] of reqs) {
      const r = await call(bob, m as 'GET', u, p)
      expect(r.statusCode, `${m} ${u}`).toBe(403)
      expect(r.body).not.toContain(SENTINEL)
      expect((await hub.app.inject({ method: m as 'GET', url: u, ...(p ? { payload: p } : {}) })).statusCode).toBe(401)
    }
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM hub_secrets').get()).toEqual({ n: 0 })
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_deploy_keys').get()).toEqual({ n: 0 })
  })

  it('missing lists required secrets not yet set', async () => {
    const { admin } = await setup()
    const missing = async () => (await call(admin, 'GET', `/api/v1/admin/secrets?environmentId=${ENV_ID}`)).json().missing[ENV_ID] as { secretId: string; name: string }[]
    expect((await missing()).map((m) => m.secretId).sort()).toEqual([SECRET_DB, SECRET_SUDO].sort())
    await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: SENTINEL })
    expect(await missing()).toEqual([{ secretId: SECRET_SUDO, name: 'sudo' }])
    const list = (await call(admin, 'GET', '/api/v1/admin/secrets')).json()
    expect(list.secrets).toEqual([
      { id: SECRET_DB, environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', updatedBy: 'admin@example.com', updatedAt: expect.any(String) },
    ])
    expect((await call(admin, 'GET', '/api/v1/admin/secrets?environmentId=nope')).statusCode).toBe(400)
    // A delete names the environment's copy; without it the Hub-wide scope is meant and there is no such row.
    expect((await call(admin, 'DELETE', `/api/v1/admin/secrets/${SECRET_DB}`)).statusCode).toBe(404)
    expect((await call(admin, 'DELETE', `/api/v1/admin/secrets/${SECRET_DB}?environmentId=${ENV_ID}`)).statusCode).toBe(204)
    expect((await missing()).length).toBe(2)
    expect((await call(admin, 'DELETE', `/api/v1/admin/secrets/${SECRET_DB}?environmentId=${ENV_ID}`)).statusCode).toBe(404)
    expect(hub.audit.list({ limit: 100 }).some((e) => e.action === 'secret.delete' && JSON.stringify(e.details) === JSON.stringify({ name: 'DB_PASSWORD', kind: 'env', environmentId: ENV_ID }))).toBe(true)
  })

  it('a set replaces in place; integration kinds use fixed names and scopes', async () => {
    const { admin } = await setup()
    await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'one' })
    await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'two' })
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM hub_secrets').get()).toEqual({ n: 1 })
    const store = new SecretStore(hub.db, new KeyRing(hub.db, hub.masterKey), { audit: hub.audit, now: () => new Date(), ids: () => randomBytes(16).toString('hex') })
    expect(store.resolveForRun(ENV_ID, [SECRET_DB, SECRET_SUDO]).get(SECRET_DB)).toBe('two')
    expect(store.resolveForRun(ENV_ID, [SECRET_DB, SECRET_SUDO]).has(SECRET_SUDO)).toBe(false)

    const t1 = '54444444-4444-4444-8444-444444444444'
    const t2 = '55555555-5555-4555-8555-555555555555'
    expect((await putSecret(admin, t1, { environmentId: ENV_ID, name: 'whatever', kind: 'teams_webhook', value: 'https://hook/1' })).statusCode).toBe(204)
    expect((await putSecret(admin, t2, { environmentId: ENV_ID, name: 'whatever', kind: 'teams_webhook', value: 'https://hook/2' })).statusCode).toBe(204)
    expect(store.integration(ENV_ID, 'teams_webhook')).toBe('https://hook/2')
    expect(hub.db.prepare("SELECT name FROM hub_secrets WHERE kind = 'teams_webhook'").all()).toEqual([{ name: 'teams_webhook' }])
    // Teams hooks belong to an environment; SendGrid/GitHub/Anthropic keys are global.
    expect((await putSecret(admin, t1, { environmentId: null, name: 'x', kind: 'teams_webhook', value: 'v' })).statusCode).toBe(400)
    expect((await putSecret(admin, '56666666-6666-4666-8666-666666666666', { environmentId: ENV_ID, name: 'x', kind: 'sendgrid_api_key', value: 'v' })).statusCode).toBe(400)
    expect((await putSecret(admin, '56666666-6666-4666-8666-666666666666', { environmentId: null, name: 'x', kind: 'sendgrid_api_key', value: 'SG.key' })).statusCode).toBe(204)
    expect(store.integration(ENV_ID, 'sendgrid_api_key')).toBe('SG.key')
    // env/become secrets need an environment, and it must be published.
    expect((await putSecret(admin, '57777777-7777-4777-8777-777777777777', { environmentId: null, name: 'x', kind: 'env', value: 'v' })).statusCode).toBe(400)
    expect((await putSecret(admin, '57777777-7777-4777-8777-777777777777', { environmentId: 'f1111111-1111-4111-8111-111111111111', name: 'x', kind: 'env', value: 'v' })).statusCode).toBe(404)
  })

  it('validation errors never echo the value', async () => {
    const { admin } = await setup()
    const big = 'ZQ'.repeat(MAX_SECRET_BYTES / 2 + 1)
    const r = await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: big })
    expect(r.statusCode).toBe(400)
    expect(r.body).not.toContain('ZQZQ')
    const ok = await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'q'.repeat(MAX_SECRET_BYTES) })
    expect(ok.statusCode).toBe(204)
    for (const bad of [{ value: '' }, { kind: SENTINEL }, { name: '' }, { environmentId: SENTINEL }]) {
      const res = await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: SENTINEL, ...bad })
      expect(res.statusCode).toBe(400)
      expect(res.body).not.toContain(SENTINEL)
    }
    expect(hub.logs.join('')).not.toContain(SENTINEL)
    expect(hub.logs.join('')).not.toContain('ZQZQ')
  })

  it('ciphertext moved to another row fails to open', async () => {
    const { admin } = await setup()
    await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'alpha-value' })
    await putSecret(admin, SECRET_SUDO, { environmentId: ENV_ID, name: 'sudo', kind: 'become', value: 'beta-value' })
    const store = new SecretStore(hub.db, new KeyRing(hub.db, hub.masterKey), { audit: hub.audit, now: () => new Date(), ids: randomUUIDish })
    const enc = (id: string) => (hub.db.prepare('SELECT value_enc FROM hub_secrets WHERE id = ?').get(id) as { value_enc: string }).value_enc
    hub.db.prepare('UPDATE hub_secrets SET value_enc = ? WHERE id = ?').run(enc(SECRET_DB), SECRET_SUDO)
    expect(() => store.resolveForRun(ENV_ID, [SECRET_SUDO])).toThrow(/could not be decrypted/)
    try {
      store.resolveForRun(ENV_ID, [SECRET_SUDO])
    } catch (e) {
      expect((e as Error).message).not.toContain('alpha-value')
    }
  })

  it('deploy key: public only over the API, private sealed', async () => {
    const { admin } = await setup()
    expect((await call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)).statusCode).toBe(404)
    const first = await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)
    expect(first.statusCode).toBe(200)
    expect(Object.keys(first.json()).sort()).toEqual(['fingerprint', 'publicKey'])
    expect(first.json().publicKey).toMatch(/^ssh-ed25519 \S+ opsdeck-hub:prod$/)
    expect(first.json().fingerprint).toMatch(/^SHA256:/)
    const row = hub.db.prepare('SELECT * FROM env_deploy_keys').get() as Record<string, string>
    expect(JSON.stringify(row)).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(row.private_enc).toMatch(/^v1\./)
    const got = await call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)
    expect(got.json()).toEqual(first.json())
    // The catalog fingerprint is set by the same row.
    const cat = (await call(admin, 'GET', `/api/v1/admin/environments/${ENV_ID}`)).json()
    expect(cat.environment.id).toBe(ENV_ID)

    const { DeployKeys } = await import('../src/secrets/deploykeys')
    const keys = new DeployKeys(hub.db, new KeyRing(hub.db, hub.masterKey), { now: () => new Date() })
    expect(keys.privateForRun(ENV_ID)).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(keys.publicKey(ENV_ID)).toEqual(first.json())
    // Rotation replaces the key and is audited with names only.
    const second = await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)
    expect(second.json().fingerprint).not.toBe(first.json().fingerprint)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_deploy_keys').get()).toEqual({ n: 1 })
    const ev = hub.audit.list({ limit: 100 }).filter((e) => e.action === 'deploykey.create').reverse()
    expect(ev.map((e) => e.details)).toEqual([
      { name: 'prod', environmentId: ENV_ID, rotated: false },
      { name: 'prod', environmentId: ENV_ID, rotated: true },
    ])
    expect(JSON.stringify(ev)).not.toContain('PRIVATE KEY')
    expect((await call(admin, 'POST', '/api/v1/admin/environments/f1111111-1111-4111-8111-111111111111/deploy-key')).statusCode).toBe(404)
  })

  it('a deploy key blob moved to another environment fails to open (AAD)', async () => {
    const { admin } = await setup()
    await publishSecond(admin)
    await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)
    await call(admin, 'POST', `/api/v1/admin/environments/${ENV2}/deploy-key`)
    const keys = new DeployKeys(hub.db, new KeyRing(hub.db, hub.masterKey), { now: () => new Date() })
    expect(keys.privateForRun(ENV2)).toContain('BEGIN OPENSSH PRIVATE KEY')
    const enc = (hub.db.prepare('SELECT private_enc FROM env_deploy_keys WHERE environment_id = ?').get(ENV_ID) as { private_enc: string }).private_enc
    hub.db.prepare('UPDATE env_deploy_keys SET private_enc = ? WHERE environment_id = ?').run(enc, ENV2)
    expect(() => keys.privateForRun(ENV2)).toThrow('deploy key could not be decrypted')
    expect(keys.privateForRun(ENV_ID)).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('a shared vault secret uploads to each environment with its own sealed copy', async () => {
    const { admin } = await setup()
    await publishSecond(admin)
    const body = (environmentId: string, value: string) => ({ environmentId, name: 'DB_PASSWORD', kind: 'env', value })
    expect((await putSecret(admin, SECRET_DB, body(ENV_ID, 'prod-value'))).statusCode).toBe(204)
    expect((await putSecret(admin, SECRET_DB, body(ENV2, 'staging-value'))).statusCode).toBe(204)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM hub_secrets WHERE id = ?').get(SECRET_DB)).toEqual({ n: 2 })
    const present = async (env: string) =>
      ((await call(admin, 'GET', `/api/v1/admin/secrets?environmentId=${env}`)).json().missing[env] as { secretId: string }[]).map((m) => m.secretId)
    expect(await present(ENV_ID)).not.toContain(SECRET_DB)
    expect(await present(ENV2)).not.toContain(SECRET_DB)

    const store = new SecretStore(hub.db, new KeyRing(hub.db, hub.masterKey), { audit: hub.audit, now: () => new Date(), ids: randomUUIDish })
    expect(store.resolveForRun(ENV_ID, [SECRET_DB]).get(SECRET_DB)).toBe('prod-value')
    expect(store.resolveForRun(ENV2, [SECRET_DB]).get(SECRET_DB)).toBe('staging-value')
    // Env A never resolves env B's row.
    hub.db.prepare('DELETE FROM hub_secrets WHERE id = ? AND environment_id = ?').run(SECRET_DB, ENV_ID)
    expect(store.resolveForRun(ENV_ID, [SECRET_DB]).size).toBe(0)
    expect(store.resolveForRun(ENV2, [SECRET_DB]).get(SECRET_DB)).toBe('staging-value')
    await putSecret(admin, SECRET_DB, body(ENV_ID, 'prod-value'))

    // Deleting one environment's copy leaves the other.
    expect((await call(admin, 'DELETE', `/api/v1/admin/secrets/${SECRET_DB}?environmentId=${ENV_ID}`)).statusCode).toBe(204)
    expect(await present(ENV_ID)).toContain(SECRET_DB)
    expect(await present(ENV2)).not.toContain(SECRET_DB)
    expect(store.resolveForRun(ENV2, [SECRET_DB]).get(SECRET_DB)).toBe('staging-value')

    // A row moved to another environment fails to open: the AAD binds the environment.
    await putSecret(admin, SECRET_DB, body(ENV_ID, 'prod-value'))
    hub.db.prepare('UPDATE hub_secrets SET environment_id = ? WHERE id = ? AND environment_id = ?').run(ENV3, SECRET_DB, ENV_ID)
    expect(() => store.resolveForRun(ENV3, [SECRET_DB])).toThrow(/could not be decrypted/)
  })

  it('secret and deploy-key changes are refused while a release runs on the environment', async () => {
    const { admin } = await setup()
    await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'v' })
    await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)
    const locks = new EnvLocks(hub.db, { now: () => new Date() })
    locks.acquireRelease(ENV_ID, 'r-1', { oid: ADMIN.oid, name: 'Admin' })
    const attempts = [
      await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'w' }),
      await call(admin, 'DELETE', `/api/v1/admin/secrets/${SECRET_DB}?environmentId=${ENV_ID}`),
      await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`),
    ]
    for (const r of attempts) {
      expect(r.statusCode).toBe(409)
      expect(r.json()).toEqual({ error: 'env_locked', message: 'A release is running on prod' })
    }
    const store = new SecretStore(hub.db, new KeyRing(hub.db, hub.masterKey), { audit: hub.audit, now: () => new Date(), ids: randomUUIDish })
    expect(store.resolveForRun(ENV_ID, [SECRET_DB]).get(SECRET_DB)).toBe('v')
    locks.releaseFor('r-1')
    expect((await putSecret(admin, SECRET_DB, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: 'w' })).statusCode).toBe(204)
  })

  it('the serialization guard refuses a response with a value key', async () => {
    const app = Fastify()
    installErrorHandler(app, () => [])
    const db = openHubDb(':memory:')
    cleanup.push(() => db.close())
    const store = {
      meta: () => [{ id: 'x', value: SENTINEL }],
    }
    const auth = { requireUser: async (req: { user?: unknown }) => void (req.user = { role: 'admin', status: 'active', groupIds: [] }) }
    registerSecrets(app, {
      secrets: store as never,
      deployKeys: {} as never,
      locks: { get: () => null } as never,
      registry: { required: () => [], exists: () => true } as never,
      directory: { listGroups: () => [] } as never,
      audit: {} as never,
      auth: auth as never,
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/secrets' })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain(SENTINEL)
    await app.close()
  })
})

const randomUUIDish = (): string => randomBytes(16).toString('hex')

describe('master key', () => {
  it('wrong master key refuses boot', () => {
    const db = openHubDb(':memory:')
    cleanup.push(() => db.close())
    const a = randomBytes(32)
    new KeyRing(db, a)
    expect(() => new KeyRing(db, randomBytes(32))).toThrow('master key does not match this database')
    expect(() => new KeyRing(db, a)).not.toThrow()
    expect(new KeyRing(db, a).keyId).toMatch(/^[0-9a-f]{16}$/)
  })

  describe('master key under systemd LoadCredential', () => {
    const rootOwned = (mode: number) => (fd: number) => ({ ...fstatSync(fd), mode: 0o100000 | mode, uid: 0 })

    function credential(mode = 0o440) {
      const dir = tmp()
      const creds = join(dir, 'creds')
      mkdirSync(creds)
      const file = join(creds, 'master-key')
      const key = randomBytes(32)
      writeFileSync(file, `${key.toString('base64')}\n`)
      return { dir, creds, file, key, env: { CREDENTIALS_DIRECTORY: creds }, stat: rootOwned(mode) }
    }

    it('accepts a root-owned 0440 file inside the credentials directory', () => {
      const c = credential()
      expect(loadMasterKey({ file: c.file, env: c.env, fstat: c.stat }).equals(c.key)).toBe(true)
    })

    it('refuses the same file outside the directory (strict check applies)', () => {
      const c = credential()
      expect(() => loadMasterKey({ file: c.file, env: { CREDENTIALS_DIRECTORY: join(c.dir, 'elsewhere') }, fstat: c.stat })).toThrow('chmod 600')
      expect(() => loadMasterKey({ file: c.file, env: {}, fstat: c.stat })).toThrow('chmod 600')
    })

    it('refuses other bits and write bits inside the directory', () => {
      const c = credential()
      expect(() => loadMasterKey({ file: c.file, env: c.env, fstat: rootOwned(0o444) })).toThrow('other users')
      expect(() => loadMasterKey({ file: c.file, env: c.env, fstat: rootOwned(0o640) })).toThrow('not be writable')
      expect(() => loadMasterKey({ file: c.file, env: c.env, fstat: rootOwned(0o460) })).toThrow('not be writable')
    })

    it('uses the strict check when CREDENTIALS_DIRECTORY is "/" or relative', () => {
      const c = credential()
      expect(() => loadMasterKey({ file: c.file, env: { CREDENTIALS_DIRECTORY: '/' }, fstat: c.stat })).toThrow('chmod 600')
      const rel = relative(process.cwd(), c.creds)
      expect(() => loadMasterKey({ file: c.file, env: { CREDENTIALS_DIRECTORY: rel }, fstat: c.stat })).toThrow('chmod 600')
    })

    it('refuses a foreign owner inside the directory', () => {
      const c = credential()
      const uid = process.getuid!()
      const other = (fd: number) => ({ ...fstatSync(fd), mode: 0o100440, uid: uid + 1 })
      expect(() => loadMasterKey({ file: c.file, env: c.env, fstat: other })).toThrow('owned by root or the Hub user')
    })

    it('refuses a symlink that escapes the directory', () => {
      const c = credential()
      const outside = join(c.dir, 'outside.key')
      writeFileSync(outside, `${c.key.toString('base64')}\n`)
      const link = join(c.creds, 'link')
      symlinkSync(outside, link)
      expect(() => loadMasterKey({ file: link, env: c.env, fstat: c.stat })).toThrow('chmod 600')
    })
  })

  it('master key file must be 0600', () => {
    const dir = tmp()
    const file = join(dir, 'master.key')
    const key = randomBytes(32)
    writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o644 })
    chmodSync(file, 0o644)
    expect(() => loadMasterKey({ file, env: {} })).toThrow('masterKeyFile must be chmod 600')
    chmodSync(file, 0o600)
    expect(loadMasterKey({ file, env: {} }).equals(key)).toBe(true)
    chmodSync(file, 0o400)
    expect(loadMasterKey({ file, env: {} }).equals(key)).toBe(true)
    chmodSync(file, 0o660)
    expect(() => loadMasterKey({ file, env: {} })).toThrow('masterKeyFile must be chmod 600')
  })

  it('fails closed on a missing, short or malformed key without echoing it', () => {
    const dir = tmp()
    expect(() => loadMasterKey({ env: {} })).toThrow('no master key: set masterKeyFile or OPSDECK_HUB_MASTER_KEY')
    expect(() => loadMasterKey({ file: join(dir, 'absent'), env: {} })).toThrow(/masterKeyFile could not be read/)
    const short = randomBytes(16).toString('base64')
    expect(() => loadMasterKey({ env: { OPSDECK_HUB_MASTER_KEY: short } })).toThrow('master key must be 32 bytes (base64)')
    try {
      loadMasterKey({ env: { OPSDECK_HUB_MASTER_KEY: short } })
    } catch (e) {
      expect((e as Error).message).not.toContain(short)
    }
    expect(() => loadMasterKey({ env: { OPSDECK_HUB_MASTER_KEY: '!!!not base64!!!' } })).toThrow('master key must be 32 bytes (base64)')
    const good = randomBytes(32)
    expect(loadMasterKey({ env: { OPSDECK_HUB_MASTER_KEY: good.toString('base64') } }).equals(good)).toBe(true)
    // The file wins over the env var; a bad file is never papered over by the env var.
    const file = join(dir, 'k')
    writeFileSync(file, 'short', { mode: 0o600 })
    expect(() => loadMasterKey({ file, env: { OPSDECK_HUB_MASTER_KEY: good.toString('base64') } })).toThrow('master key must be 32 bytes (base64)')
  })

  it('createMasterKeyFile writes 0600 and never overwrites', () => {
    const file = join(tmp(), 'master.key')
    createMasterKeyFile(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(loadMasterKey({ file, env: {} })).toHaveLength(32)
    const before = readFileSync(file, 'utf8')
    expect(() => createMasterKeyFile(file)).toThrow(/already exists/)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
