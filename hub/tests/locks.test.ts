import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FREEZE_DEFAULT_HOURS, FREEZE_MAX_HOURS, type HubEnvLock } from '../../src/shared/hub'
import { buildApp } from '../src/app'
import { HubAudit } from '../src/audit'
import { openHubDb } from '../src/db'
import { EnvLocks } from '../src/locks'
import { testHub, type TestHub } from './helpers'
import { ENV_ID, manifest } from './manifest'

let hub: TestHub
afterEach(async () => hub?.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const CAT = { oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', upn: 'cat@example.com', name: 'Cat' }

const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })
const freeze = (t: string, body: object = { reason: 'db migration' }) => call(t, 'POST', `/api/v1/environments/${ENV_ID}/freeze`, body)
const unfreeze = (t: string, body?: object) => call(t, 'DELETE', `/api/v1/environments/${ENV_ID}/freeze`, body)
const holder = (u: { oid: string; name: string }) => ({ oid: u.oid, name: u.name })

async function setup(opts: { protectedEnv?: boolean } = {}) {
  hub = await testHub()
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const cat = (await hub.signIn(CAT)).token
  const m = manifest()
  m.environment.protected = opts.protectedEnv ?? true
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, m)).statusCode).toBe(200)
  // Bob and Cat are maintainers with a grant on the environment.
  const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Ops' })).json().id as string
  await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid, CAT.oid] })
  expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })).statusCode).toBe(201)
  const locks = new EnvLocks(hub.db, { now: () => hub.clock.now })
  return { admin, bob, cat, locks }
}

describe('environment locks', () => {
  it('exactly one concurrent acquire wins', async () => {
    const { locks } = await setup()
    const file = join(hub.config.dataDir, 'hub.db')
    const handles = Array.from({ length: 10 }, () => openHubDb(file))
    try {
      const results = await Promise.all(
        handles.map(async (db, i) => {
          try {
            return { ok: new EnvLocks(db, { now: () => hub.clock.now }).acquireRelease(ENV_ID, randomUUID(), { oid: `oid-${i}`, name: `User ${i}` }) }
          } catch (e) {
            return { err: e as { code?: string; status?: number; message: string } }
          }
        }),
      )
      const wins = results.filter((r) => 'ok' in r)
      const losses = results.filter((r) => 'err' in r)
      expect(wins).toHaveLength(1)
      expect(losses).toHaveLength(9)
      const winner = (wins[0] as { ok: HubEnvLock }).ok.holder.name
      for (const l of losses) {
        const e = (l as { err: { code?: string; status?: number; message: string } }).err
        expect(e).toMatchObject({ status: 409, code: 'env_locked' })
        expect(e.message).toContain(`Locked by ${winner} since `)
      }
      expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 1 })
      locks.releaseFor((wins[0] as { ok: HubEnvLock }).ok.releaseId as string)
      expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 0 })
    } finally {
      for (const h of handles) h.close()
    }
  })

  it('a freeze blocks others, not its holder', async () => {
    const { bob, cat, locks } = await setup()
    const r = await freeze(bob, { reason: 'db migration' })
    expect(r.statusCode).toBe(200)
    const lock = r.json() as HubEnvLock
    expect(lock).toMatchObject({ environmentId: ENV_ID, kind: 'manual', releaseId: null, holder: holder(BOB), reason: 'db migration' })
    expect(Date.parse(lock.expiresAt as string) - Date.parse(lock.createdAt)).toBe(FREEZE_DEFAULT_HOURS * 3_600_000)
    // Someone else cannot take a release lock or freeze.
    expect(() => locks.acquireRelease(ENV_ID, randomUUID(), holder(CAT))).toThrow(/Locked by Bob since .*: db migration/)
    const other = await freeze(cat)
    expect(other.statusCode).toBe(409)
    expect(other.json().error).toBe('env_locked')
    // The holder can start a release, which upgrades the freeze to a release lock.
    const rel = locks.acquireRelease(ENV_ID, 'r-1', holder(BOB))
    expect(rel).toMatchObject({ kind: 'release', releaseId: 'r-1', holder: holder(BOB) })
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 1 })
    // A release lock cannot be frozen over or lifted as a freeze.
    expect((await freeze(bob)).statusCode).toBe(409)
    expect((await unfreeze(bob)).statusCode).toBe(409)
  })

  it('clamps hours and requires a reason', async () => {
    const { bob, admin } = await setup()
    const long = (await freeze(bob, { reason: 'x', hours: 500 })).json() as HubEnvLock
    expect(Date.parse(long.expiresAt as string) - Date.parse(long.createdAt)).toBe(FREEZE_MAX_HOURS * 3_600_000)
    const short = (await freeze(bob, { reason: 'x', hours: 0.01 })).json() as HubEnvLock
    expect(Date.parse(short.expiresAt as string) - Date.parse(short.createdAt)).toBe(3_600_000)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 1 })
    for (const bad of [{}, { reason: '' }, { reason: 'x'.repeat(281) }, { reason: 'x', hours: 'soon' }]) {
      expect((await freeze(admin, bad)).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await call(admin, 'POST', '/api/v1/environments/e9999999-9999-4999-8999-999999999999/freeze', { reason: 'x' })).statusCode).toBe(404)
  })

  it('expired freeze is swept and no longer blocks', async () => {
    const { bob, cat, locks } = await setup()
    await freeze(bob, { reason: 'x', hours: 1 })
    const seen: string[] = []
    locks.onChange((e) => seen.push(e))
    hub.clock.now = new Date(hub.clock.now.getTime() + 61 * 60_000)
    // Expired but not yet swept: it already does not block, and is not listed.
    expect(locks.get(ENV_ID)).toBeNull()
    expect(((await call(cat, 'GET', '/api/v1/locks')).json() as unknown[]).length).toBe(0)
    expect(locks.sweepExpired()).toBe(1)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 0 })
    expect(seen).toEqual([ENV_ID])
    expect(locks.sweepExpired()).toBe(0)
    expect((await freeze(cat)).statusCode).toBe(200)
  })

  it('an expired freeze does not stop a release lock', async () => {
    const { bob, locks } = await setup()
    await freeze(bob, { reason: 'x', hours: 1 })
    hub.clock.now = new Date(hub.clock.now.getTime() + 2 * 3_600_000)
    expect(locks.acquireRelease(ENV_ID, 'r-2', holder(ADMIN)).kind).toBe('release')
  })

  it('admin lifting another\'s freeze on a protected env needs the exact name', async () => {
    const { admin, bob } = await setup()
    await freeze(bob)
    const before = hub.audit.list({ limit: 1000 }).length
    for (const body of [undefined, {}, { typedName: 'PROD' }, { typedName: 'prod ' }]) {
      const r = await unfreeze(admin, body)
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('confirm_required')
    }
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 1 })
    const denied = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'access.denied')
    expect(denied).toHaveLength(4)
    expect(hub.audit.list({ limit: 1000 }).length).toBe(before + 4)
    expect(hub.audit.list({ limit: 1000 }).some((e) => e.action === 'lock.break')).toBe(false)

    expect((await unfreeze(admin, { typedName: 'prod' })).statusCode).toBe(204)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 0 })
    const brk = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'lock.break')
    expect(brk).toHaveLength(1)
    expect(brk[0].details).toMatchObject({ environmentId: ENV_ID, holder: BOB.oid })
  })

  it('an unprotected env needs no name; the holder lifting their own is an unfreeze', async () => {
    const { admin, bob } = await setup({ protectedEnv: false })
    await freeze(bob)
    expect((await unfreeze(admin)).statusCode).toBe(204)
    await freeze(bob)
    expect((await unfreeze(bob)).statusCode).toBe(204)
    // A protected holder never needs the name for their own freeze.
    expect((await unfreeze(bob)).statusCode).toBe(404)
    const actions = hub.audit.list({ limit: 1000 }).map((e) => e.action).filter((a) => a.startsWith('lock.')).reverse()
    expect(actions).toEqual(['lock.freeze', 'lock.break', 'lock.freeze', 'lock.unfreeze'])
  })

  it('a protected holder lifts their own freeze without the name', async () => {
    const { admin, bob } = await setup()
    await freeze(admin)
    expect((await unfreeze(admin)).statusCode).toBe(204)
    await freeze(bob)
    expect((await unfreeze(bob)).statusCode).toBe(204)
  })

  it('maintainer cannot lift another\'s freeze', async () => {
    const { bob, cat } = await setup()
    await freeze(bob)
    const r = await unfreeze(cat, { typedName: 'prod' })
    expect(r.statusCode).toBe(403)
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM env_locks').get()).toEqual({ n: 1 })
    expect(hub.audit.list({ limit: 1000 }).some((e) => e.action === 'access.denied')).toBe(true)
    expect(hub.audit.list({ limit: 1000 }).some((e) => e.action === 'lock.break')).toBe(false)
  })

  it('freeze needs a grant on the environment; the locks list is filtered by deploy.view', async () => {
    const { admin, bob } = await setup()
    const dan = { oid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', upn: 'dan@example.com', name: 'Dan' }
    const danTok = (await hub.signIn(dan)).token
    expect((await freeze(danTok)).statusCode).toBe(403)
    expect((await call(danTok, 'GET', '/api/v1/locks')).json()).toEqual([])
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/locks' })).statusCode).toBe(401)
    await freeze(bob)
    const own = (await call(bob, 'GET', '/api/v1/locks')).json() as HubEnvLock[]
    expect(own.map((l) => l.environmentId)).toEqual([ENV_ID])
    expect((await call(admin, 'GET', '/api/v1/locks')).json()).toHaveLength(1)
    // The catalog carries the lock too.
    const cat = (await call(bob, 'GET', '/api/v1/catalog')).json() as { lock: HubEnvLock | null }[]
    expect(cat[0].lock).toMatchObject({ kind: 'manual', holder: holder(BOB) })
  })

  it('boot clears release locks but keeps live freezes', async () => {
    const { bob, locks } = await setup()
    await freeze(bob, { reason: 'keep me', hours: 2 })
    // A second environment with a running release.
    const m2 = manifest()
    const ENV2 = 'e2222222-2222-4222-8222-222222222222'
    m2.environment = { ...m2.environment, id: ENV2, name: 'staging' }
    m2.hosts = []
    m2.deployments = []
    m2.requiredSecrets = []
    const admin = (await hub.signIn(ADMIN)).token
    expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV2}`, m2)).statusCode).toBe(200)
    locks.acquireRelease(ENV2, 'r-9', holder(BOB))
    const app = buildApp({
      config: hub.config,
      db: hub.db,
      audit: new HubAudit(hub.db),
      masterKey: hub.masterKey,
      verifier: { verify: async () => { throw new Error('unused') } },
      now: () => hub.clock.now,
      ids: randomUUID,
      log: { write: () => undefined },
    })
    await app.ready()
    const rows = hub.db.prepare('SELECT environment_id, kind FROM env_locks ORDER BY environment_id').all()
    expect(rows).toEqual([{ environment_id: ENV_ID, kind: 'manual' }])
    await app.close()
  })

  it('release locks are released by release id and only that id', async () => {
    const { locks } = await setup()
    locks.acquireRelease(ENV_ID, 'r-1', holder(ADMIN))
    locks.releaseFor('r-other')
    expect(locks.get(ENV_ID)).not.toBeNull()
    locks.releaseFor('r-1')
    expect(locks.get(ENV_ID)).toBeNull()
    locks.releaseFor('r-1')
  })

  it('publish is refused while a release lock is held (real table, no probe)', async () => {
    const { admin, locks } = await setup()
    locks.acquireRelease(ENV_ID, 'r-3', holder(BOB))
    const r = await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, manifest())
    expect(r.statusCode).toBe(409)
    expect(r.json()).toEqual({ error: 'conflict', message: 'A release is running on prod' })
  })
})
