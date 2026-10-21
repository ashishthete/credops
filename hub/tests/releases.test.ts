import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { FakeRunner, A } from '../../tests/main/fake-runner'
import { EntraVerifier } from '../src/auth/entra'
import { HubAudit } from '../src/audit'
import { buildApp } from '../src/app'
import { KeyRing } from '../src/secrets/keyring'
import { DeployKeys } from '../src/secrets/deploykeys'
import { HostKeyError } from '../../src/main/ssh/connect'
import { READY_RELEASE_TTL_MS } from '../../src/shared/hub'
import { hubVerify } from '../src/releases/adapters'
import { testHub, type TestHub } from './helpers'
import { DEP_API, DEP_WEB, ENV_ID, HOST_ID, JUMP_ID, SECRET_DB, SECRET_SUDO, deployment, manifest } from './manifest'

let hub: TestHub
afterEach(async () => hub?.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const DAN = { oid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', upn: 'dan@example.com', name: 'Dan' }

const SVC_WEB = '71111111-1111-4111-8111-111111111111'
const SVC_API = '72222222-2222-4222-8222-222222222222'
const SVC_DB = '73333333-3333-4333-8333-333333333333'
const ENV2 = 'e2222222-2222-4222-8222-222222222222'
const HOST2 = 'a3333333-3333-4333-8333-333333333333'
const DEP2 = 'd3333333-3333-4333-8333-333333333333'
const SVC2 = '74444444-4444-4444-8444-444444444444'

const SENTINEL = 'sentinel-pw-9f3c1d77a2b84e55'
const OPTIONS = { backup: false, notify: false, qa: false }
const runIds = (plan: DeployPlan): string[] => plan.deployments.map((d) => d.runId)

const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })

function manifestOne(opts: { protectedEnv?: boolean; autoRollback?: boolean }) {
  const m = manifest()
  m.environment.protected = opts.protectedEnv ?? true
  m.environment.autoRollback = opts.autoRollback ?? false
  m.deployments[0] = deployment(DEP_WEB, 'web', { envTemplate: `DB_PASSWORD=\${secret:${SECRET_DB}}\n`, becomeSecretId: SECRET_SUDO, managedEnv: true })
  m.services = [
    { id: SVC_WEB, name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: DEP_WEB, hostId: HOST_ID, viaHostId: null },
    { id: SVC_API, name: 'api-svc', kind: 'service', composeService: 'api', deploymentId: DEP_API, hostId: HOST_ID, viaHostId: null },
    { id: SVC_DB, name: 'pg', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: HOST_ID },
  ]
  return m
}

function manifestTwo() {
  const m = manifest()
  m.environment = { id: ENV2, name: 'stage', protected: false, versioned: true, autoRollback: false, currentVersion: 'v1.0.0' }
  m.hosts = [{ ...m.hosts[0], id: HOST2, label: 'web-2', address: '10.0.1.5', hops: [{ hostId: HOST2, label: 'web-2', address: '10.0.1.5', port: 22, username: 'deploy' }] }]
  m.deployments = [deployment(DEP2, 'web2', { environmentId: ENV2, hostId: HOST2 })]
  m.services = [{ id: SVC2, name: 'web2-svc', kind: 'service', composeService: 'web', deploymentId: DEP2, hostId: HOST2, viaHostId: null }]
  m.requiredSecrets = []
  return m
}

async function setup(opts: { protectedEnv?: boolean; autoRollback?: boolean; secrets?: boolean | 'become'; second?: boolean; bobGrantEnv?: string } = {}) {
  const fr = new FakeRunner()
  hub = await testHub({}, { runner: fr })
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const dan = (await hub.signIn(DAN)).token
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, manifestOne(opts))).statusCode).toBe(200)
  expect((await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)).statusCode).toBe(200)
  if (opts.secrets !== false && opts.secrets !== 'become') {
    expect((await call(admin, 'PUT', `/api/v1/admin/secrets/${SECRET_DB}`, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: SENTINEL })).statusCode).toBe(204)
  }
  if (opts.secrets !== false) {
    expect((await call(admin, 'PUT', `/api/v1/admin/secrets/${SECRET_SUDO}`, { environmentId: ENV_ID, name: 'sudo', kind: 'become', value: 'sudo-pw-sentinel-2' })).statusCode).toBe(204)
  }
  if (opts.second) {
    expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV2}`, manifestTwo())).statusCode).toBe(200)
    expect((await call(admin, 'POST', `/api/v1/admin/environments/${ENV2}/deploy-key`)).statusCode).toBe(200)
  }
  const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Ops' })).json().id as string
  await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
  expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: opts.bobGrantEnv ?? ENV_ID } })).statusCode).toBe(201)
  return { fr, admin, bob, dan }
}

const preflight = (t: string, body: object = {}) =>
  call(t, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds: [SVC_WEB, SVC_API], bump: 'none', options: OPTIONS, ...body })
const detail = async (t: string, id: string) => (await call(t, 'GET', `/api/v1/releases/${id}`)).json()
const events = async (t: string, id: string) => (await call(t, 'GET', `/api/v1/releases/${id}/events`)).json() as { seq: number; type: string; line?: string }[]

async function ready(t: string, body: object = {}): Promise<string> {
  const res = await preflight(t, body)
  expect(res.statusCode, res.body).toBe(201)
  const id = res.json().releaseId as string
  await hub.app.releases.whenIdle()
  expect((await detail(t, id)).status).toBe('ready')
  return id
}

const audits = (action: string) => hub.audit.list({ limit: 1000 }).filter((e) => e.action === action)
const lockRows = () => hub.db.prepare('SELECT * FROM env_locks').all() as { environment_id: string; release_id: string }[]

describe('hub releases', () => {
  it('a maintainer with a grant runs preflight, start and finish; events persist with seq and audit names the group', async () => {
    const { fr, bob } = await setup()
    fr.on.release = (_p, _s, emit) => emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: 'hello from the run' })
    const id = await ready(bob)
    const start = await call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' })
    expect(start.statusCode, start.body).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('succeeded')
    const ev = await events(bob, id)
    expect(ev.length).toBeGreaterThan(0)
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1))
    expect(ev.some((e) => e.line === 'hello from the run')).toBe(true)
    expect(lockRows()).toEqual([])
    for (const action of ['release.preflight', 'release.start', 'release.finish']) {
      const row = audits(action)[0]
      expect(row, action).toBeTruthy()
      expect(row).toMatchObject({ actor: { oid: BOB.oid }, viaGroup: 'Ops' })
    }
    const list = (await call(bob, 'GET', `/api/v1/releases?environmentId=${ENV_ID}`)).json()
    expect(list.map((r: { id: string }) => r.id)).toContain(id)
    expect(hub.audit.verify().ok).toBe(true)
  })

  it('a protected start needs the exact environment name; nothing runs and the denial is audited', async () => {
    const { fr, bob } = await setup()
    const id = await ready(bob)
    const spy = vi.spyOn(hub.app.releases.service, 'start')
    const before = lockRows()
    for (const body of [{}, { typedName: 'PROD' }, { typedName: 'prod ' }]) {
      const res = await call(bob, 'POST', `/api/v1/releases/${id}/start`, body)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'confirm_required' })
      expect(res.json().message).toBe('Type the environment name "prod" to deploy to a protected environment')
    }
    expect(spy).not.toHaveBeenCalled()
    expect(fr.kinds).not.toContain('release')
    expect(lockRows()).toEqual(before)
    expect(audits('access.denied').length).toBeGreaterThanOrEqual(3)
    expect((await detail(bob, id)).status).toBe('ready')
  })

  it('an unprotected environment starts without a typed name', async () => {
    const { bob } = await setup({ protectedEnv: false })
    const id = await ready(bob)
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})).statusCode).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('succeeded')
  })

  it('ten parallel preflights give one 201 and nine 409 env_locked, and one release row', async () => {
    const { bob } = await setup()
    const res = await Promise.all(Array.from({ length: 10 }, () => preflight(bob)))
    const codes = res.map((r) => r.statusCode).sort()
    expect(codes).toEqual([201, ...Array(9).fill(409)])
    for (const r of res.filter((x) => x.statusCode === 409)) expect(r.json()).toMatchObject({ error: 'env_locked' })
    await hub.app.releases.whenIdle()
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM releases').get() as { n: number }).n).toBe(1)
    expect(lockRows()).toHaveLength(1)
  })

  it('zero new commits needs redeploy', async () => {
    const { fr, bob } = await setup({ protectedEnv: false })
    fr.commitsTotal = 0
    const id = await ready(bob)
    const no = await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})
    expect(no.statusCode).toBe(400)
    expect(no.json()).toMatchObject({ error: 'confirm_required' })
    expect(fr.kinds).not.toContain('release')
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, { redeploy: true })).statusCode).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('succeeded')
  })

  it('a failure with auto-rollback rolls back and frees the lock', async () => {
    const { fr, bob } = await setup({ autoRollback: true })
    fr.on.release = (plan) => ({ exitCode: 2, failedDeploymentRunIds: runIds(plan), reachedCheckout: runIds(plan), commits: { [runIds(plan)[0]]: { previous: A } } })
    const id = await ready(bob)
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' })).statusCode).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('rolled_back')
    expect(fr.kinds).toContain('rollback')
    expect(lockRows()).toEqual([])
    // The environment is free again.
    expect((await preflight(bob)).statusCode).toBe(201)
  })

  it('a failure without auto-rollback ends failed and frees the lock', async () => {
    const { fr, bob } = await setup()
    fr.on.release = () => ({ exitCode: 2 })
    const id = await ready(bob)
    await call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' })
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('failed')
    expect(lockRows()).toEqual([])
  })

  it('a manual rollback of a succeeded release takes its own lock and frees it', async () => {
    const { fr, bob } = await setup()
    fr.on.release = (plan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous: A }])) })
    const id = await ready(bob)
    await call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' })
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('succeeded')
    expect(lockRows()).toEqual([])
    const bad = await call(bob, 'POST', `/api/v1/releases/${id}/rollback`, {})
    expect(bad.statusCode).toBe(400)
    const rb = await call(bob, 'POST', `/api/v1/releases/${id}/rollback`, { typedName: 'prod' })
    expect(rb.statusCode, rb.body).toBe(201)
    const rid = rb.json().releaseId as string
    expect(rid).not.toBe(id)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, rid)).kind).toBe('rollback')
    expect(lockRows()).toEqual([])
    expect(audits('release.rollback')[0]).toMatchObject({ actor: { oid: BOB.oid }, viaGroup: 'Ops' })
  })

  it('a person without a grant gets 403 and nothing runs', async () => {
    const { fr, dan } = await setup()
    const res = await preflight(dan)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'forbidden' })
    expect(fr.calls).toHaveLength(0)
    expect(lockRows()).toEqual([])
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM releases').get() as { n: number }).n).toBe(0)
    expect(audits('access.denied').length).toBeGreaterThan(0)
  })

  it('break-lock is admin only and needs the typed host label', async () => {
    const { fr, admin, bob } = await setup()
    fr.locks = { [HOST_ID]: { holder: { releaseId: 'x', user: 'ana', machine: 'mbp', environment: 'prod', version: null, startedAt: new Date().toISOString() }, stale: true, raw: 'raw' } }
    const id = await ready(admin)
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/break-lock`, { hostId: HOST_ID, typedLabel: 'web-1' })).statusCode).toBe(403)
    const wrong = await call(admin, 'POST', `/api/v1/releases/${id}/break-lock`, { hostId: HOST_ID, typedLabel: 'nope' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toMatchObject({ error: 'confirm_required' })
    expect(fr.kinds).not.toContain('unlock')
    const ok = await call(admin, 'POST', `/api/v1/releases/${id}/break-lock`, { hostId: HOST_ID, typedLabel: 'web-1' })
    expect(ok.statusCode, ok.body).toBe(204)
    expect(audits('deploy.lock_break').some((e) => e.outcome === 'success')).toBe(true)
  })

  describe('retry version', () => {
    // A release that deployed but whose version tag failed: failed, lock freed.
    async function tagFailed() {
      const t = await setup({ protectedEnv: false })
      t.fr.on.version = (_p, _s, emit) => {
        emit({ type: 'step.failed', stepId: 'release:version', error: 'tag already exists', durationMs: 1 })
        return { exitCode: 2 }
      }
      const id = await ready(t.bob, { bump: 'minor' })
      expect((await call(t.bob, 'POST', `/api/v1/releases/${id}/start`, {})).statusCode).toBe(204)
      await hub.app.releases.whenIdle()
      expect((await detail(t.bob, id)).status).toBe('failed')
      expect(lockRows()).toEqual([])
      t.fr.on.version = undefined
      return { ...t, id }
    }

    it('is refused with 409 env_locked while the environment is frozen by someone else', async () => {
      const { admin, bob, id } = await tagFailed()
      expect((await call(admin, 'POST', `/api/v1/environments/${ENV_ID}/freeze`, { reason: 'migration' })).statusCode).toBeLessThan(300)
      const res = await call(bob, 'POST', `/api/v1/releases/${id}/retry-version`)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toBe('env_locked')
      expect((await detail(bob, id)).status).toBe('failed')
    })

    it('is refused with 409 env_locked while another release holds the lock', async () => {
      const { admin, bob, id } = await tagFailed()
      expect((await preflight(admin)).statusCode).toBe(201)
      const res = await call(bob, 'POST', `/api/v1/releases/${id}/retry-version`)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toBe('env_locked')
      expect((await detail(bob, id)).status).toBe('failed')
    })

    it('takes the lock for the retry and frees it when the release ends', async () => {
      const { bob, id } = await tagFailed()
      const res = await call(bob, 'POST', `/api/v1/releases/${id}/retry-version`)
      expect(res.statusCode, res.body).toBe(204)
      await hub.app.releases.whenIdle()
      expect((await detail(bob, id)).status).toBe('succeeded')
      expect(lockRows()).toEqual([])
    })

    it('a refused retry leaves the lock of the release that holds it', async () => {
      const { bob } = await setup()
      const id = await ready(bob)
      const res = await call(bob, 'POST', `/api/v1/releases/${id}/retry-version`)
      expect(res.statusCode).toBe(409)
      expect(lockRows()).toMatchObject([{ release_id: id }])
    })
  })

  it('discard frees the lock of a ready release', async () => {
    const { bob } = await setup()
    const id = await ready(bob)
    expect(lockRows()).toHaveLength(1)
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/discard`)).statusCode).toBe(204)
    expect(lockRows()).toEqual([])
    expect(audits('release.discard')).toHaveLength(1)
  })

  it('a restart fails interrupted releases and frees their locks', async () => {
    const { fr, bob } = await setup()
    let hold: () => void = () => undefined
    fr.on.release = () => new Promise<void>((res) => (hold = res))
    const id = await ready(bob)
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' })).statusCode).toBe(204)
    for (let i = 0; i < 50 && !fr.kinds.includes('release'); i++) await new Promise((r) => setImmediate(r))
    expect((await detail(bob, id)).status).toBe('running')
    expect(lockRows()).toHaveLength(1)

    // The process dies: a new app boots on the same database.
    const app2 = buildApp({
      config: hub.config,
      db: hub.db,
      audit: new HubAudit(hub.db),
      masterKey: hub.masterKey,
      verifier: new EntraVerifier(hub.config.entra, { now: () => hub.clock.now, jwksCooldownMs: 0 }),
      now: () => hub.clock.now,
      ids: randomUUID,
      log: { write: () => undefined },
      runner: new FakeRunner(),
    })
    await app2.ready()
    expect(app2.releases.recover()).toBe(1)
    const row = hub.db.prepare('SELECT status, error FROM releases WHERE id = ?').get(id) as { status: string; error: string }
    expect(row.status).toBe('failed')
    expect(row.error).toBe('Hub restarted')
    expect(lockRows()).toEqual([])
    expect(hub.audit.verify().ok).toBe(true)
    const again = await app2.inject({
      method: 'POST',
      url: '/api/v1/releases/preflight',
      headers: { authorization: `Bearer ${bob}` },
      payload: { environmentId: ENV_ID, serviceIds: [SVC_WEB], bump: 'none', options: OPTIONS },
    })
    expect(again.statusCode, again.body).toBe(201)
    hold()
    await app2.close()
  })

  it('a release leaks no secret anywhere', async () => {
    const { fr, bob } = await setup()
    const keys = new DeployKeys(hub.db, new KeyRing(hub.db, hub.masterKey), { now: () => hub.clock.now })
    const pem = keys.privateForRun(ENV_ID)
    // Every key line a log could carry on its own: the line itself is the secret, with or without the BEGIN/END markers.
    const pemLines = pem.split('\n').filter((l) => !l.startsWith('-----') && l.length >= 16)
    expect(pemLines.length).toBeGreaterThan(2)
    fr.on.release = async (_p, secrets, emit) => {
      // The runner resolves the identity as the real one does, so the Hub remembers the PEM for masking.
      await hub.app.releases.identities.resolve(ENV_ID)
      const value = Object.values(secrets.values).join(' ')
      emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: `connecting with ${value}` })
      // A body line without the BEGIN/END markers: only the remembered PEM can mask it.
      for (const l of pemLines) emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: `key ${l}` })
      throw new Error(`boom ${SENTINEL}`)
    }
    const bodies: string[] = []
    const keep = async <T extends { body: string }>(p: Promise<T>): Promise<T> => {
      const r = await p
      bodies.push(r.body)
      return r
    }
    const pre = await keep(preflight(bob))
    const id = pre.json().releaseId as string
    await hub.app.releases.whenIdle()
    await keep(call(bob, 'POST', `/api/v1/releases/${id}/start`, { typedName: 'prod' }))
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('failed')
    await keep(call(bob, 'GET', `/api/v1/releases/${id}`))
    await keep(call(bob, 'GET', `/api/v1/releases/${id}/events`))
    await keep(call(bob, 'GET', '/api/v1/releases'))
    await keep(call(bob, 'GET', '/api/v1/releases/active'))
    hub.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytes = readFileSync(join(hub.config.dataDir, 'hub.db')).toString('latin1')
    for (const needle of [SENTINEL, 'sudo-pw-sentinel-2', ...pemLines]) {
      expect(bytes).not.toContain(needle)
      expect(bodies.join('\n')).not.toContain(needle)
      expect(JSON.stringify(await events(bob, id))).not.toContain(needle)
      expect(JSON.stringify(hub.audit.list({ limit: 1000 }))).not.toContain(needle)
      expect(JSON.stringify(hub.db.prepare('SELECT * FROM audit').all())).not.toContain(needle)
      expect(hub.logs.join('\n')).not.toContain(needle)
    }
  })

  it('a republish keeps the version the Hub released', async () => {
    const { admin, bob } = await setup({ protectedEnv: false })
    const version = () => (hub.db.prepare('SELECT current_version AS v FROM environments WHERE id = ?').get(ENV_ID) as { v: string }).v
    const id = await ready(bob, { bump: 'patch' })
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})).statusCode).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('succeeded')
    const bumped = version()
    expect(bumped).not.toBe('v1.2.3')
    const again = manifestOne({ protectedEnv: false })
    expect(again.environment.currentVersion).toBe('v1.2.3')
    expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, again)).statusCode).toBe(200)
    expect(version()).toBe(bumped)
  })

  it('a republish takes the manifest version while no release has set one', async () => {
    const { admin, bob, fr } = await setup({ protectedEnv: false })
    const version = () => (hub.db.prepare('SELECT current_version AS v FROM environments WHERE id = ?').get(ENV_ID) as { v: string }).v
    fr.on.release = () => ({ exitCode: 1, failedDeploymentRunIds: [], commits: {} })
    const id = await ready(bob, { bump: 'patch' })
    expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})).statusCode).toBe(204)
    await hub.app.releases.whenIdle()
    expect((await detail(bob, id)).status).toBe('failed')
    expect(version()).toBe('v1.2.3')
    const again = manifestOne({ protectedEnv: false })
    again.environment.currentVersion = 'v1.5.0'
    expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, again)).statusCode).toBe(200)
    expect(version()).toBe('v1.5.0')
  })

  it('a ready release with work in flight is not expired', async () => {
    const { bob } = await setup()
    const id = await ready(bob)
    hub.clock.now = new Date(hub.clock.now.getTime() + READY_RELEASE_TTL_MS + 60_000)
    const busy = vi.spyOn(hub.app.releases.service, 'isBusy').mockReturnValue(true)
    expect(hub.app.releases.expireReady()).toBe(0)
    expect((await detail(bob, id)).status).toBe('ready')
    busy.mockRestore()
    expect(hub.app.releases.expireReady()).toBe(1)
  })

  it('a ready release that never starts is discarded after the TTL and frees the lock', async () => {
    const { bob } = await setup()
    const id = await ready(bob)
    hub.clock.now = new Date(hub.clock.now.getTime() + READY_RELEASE_TTL_MS - 60_000)
    expect(hub.app.releases.expireReady()).toBe(0)
    expect(lockRows().length).toBe(1)
    hub.clock.now = new Date(hub.clock.now.getTime() + 120_000)
    expect(hub.app.releases.expireReady()).toBe(1)
    expect((await detail(bob, id)).status).toBe('discarded')
    expect(lockRows()).toEqual([])
    const row = audits('release.discard')[0]!
    expect(row).toMatchObject({ actor: null, targetId: id, details: { reason: 'expired' } })
    expect(hub.audit.verify().ok).toBe(true)
  })

  it('a preflight on an unknown environment is a 404', async () => {
    const { admin } = await setup()
    const res = await call(admin, 'POST', '/api/v1/releases/preflight', { environmentId: ENV2, serviceIds: [SVC_WEB], bump: 'none', options: OPTIONS })
    expect(res.statusCode, res.body).toBe(404)
    expect(lockRows()).toEqual([])
  })

  it('a missing secret blocks start and names only the secret', async () => {
    const { fr, bob } = await setup({ secrets: 'become', protectedEnv: false })
    const id = await ready(bob)
    const res = await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe(`Secret "DB_PASSWORD" isn't set on the Hub. Ask a Hub admin to upload it.`)
    expect(fr.kinds).not.toContain('release')
    expect((await detail(bob, id)).status).toBe('ready')
  })

  it('a missing become secret blocks the preflight with a friendly message naming only the secret', async () => {
    const { fr, bob } = await setup({ secrets: false, protectedEnv: false })
    const res = await preflight(bob)
    expect(res.statusCode, res.body).toBe(201)
    await hub.app.releases.whenIdle()
    const d = await detail(bob, res.json().releaseId)
    expect(d.status).toBe('blocked')
    expect(d.preflight.checks.map((c: { message: string }) => c.message)).toContain(`Secret "sudo" isn't set on the Hub. Ask a Hub admin to upload it.`)
    expect(fr.kinds).toEqual([])
    // A blocked preflight holds no lock.
    expect(lockRows()).toEqual([])
  })

  it('a release selection can never include a database service', async () => {
    const { fr, bob } = await setup()
    const res = await preflight(bob, { serviceIds: [SVC_WEB, SVC_DB] })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().message).toBe('pg is a database; databases are never deployed')
    expect(fr.calls).toHaveLength(0)
    expect(lockRows()).toEqual([])
  })

  it('a viewer on one environment gets its events and none from another', async () => {
    const { fr, admin } = await setup({ second: true })
    const frames: string[] = []
    hub.app.live.subscribe(BOB.oid, (f) => void frames.push(f), () => undefined)
    fr.on.release = (plan, _s, emit) =>
      emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: plan.environment.id === ENV_ID ? 'E1-LINE' : 'E2-ONLY' })
    const one = await ready(admin)
    await call(admin, 'POST', `/api/v1/releases/${one}/start`, { typedName: 'prod' })
    await hub.app.releases.whenIdle()
    const res = await preflight(admin, { environmentId: ENV2, serviceIds: [SVC2] })
    expect(res.statusCode, res.body).toBe(201)
    await hub.app.releases.whenIdle()
    await call(admin, 'POST', `/api/v1/releases/${res.json().releaseId}/start`, {})
    await hub.app.releases.whenIdle()
    const all = frames.join('')
    expect(all).toContain('E1-LINE')
    expect(all).not.toContain('E2-ONLY')
    expect(all).not.toContain(ENV2)
    expect(all).toContain('event: release.state')
  })

  it('trusts only the host keys published with the environment: no first-use trust, no prompt', async () => {
    const blobOf = () => {
      const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url')
      const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b])
      return Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')
    }
    const good = blobOf()
    const other = blobOf()
    const m = manifestOne({})
    m.hosts[0].knownHosts = [`10.0.0.5 ssh-ed25519 ${good}`, `@revoked 10.0.0.9 ssh-ed25519 ${other}`]
    const { bob } = await setup()
    const id = await ready(bob)
    const verify = hubVerify({ db: hub.db, registry: { get: () => m } })
    const check = (address: string, key: string) =>
      verify(null, null, { ownerId: id, group: new Set(), hop: { label: 'h', address, port: 22, identity: {} as never }, hostId: null, keyType: 'ssh-ed25519', keyBase64: key, isLive: () => true, onLocked: () => undefined })
    await expect(check('10.0.0.5', good)).resolves.toBe(true)
    await expect(check('10.0.0.5', other)).rejects.toMatchObject({ code: 'host-key-changed' })
    await expect(check('10.0.0.7', good)).rejects.toMatchObject({ code: 'host-key-rejected' })
    await expect(check('10.0.0.9', other)).rejects.toBeInstanceOf(HostKeyError)
    await expect(check('10.0.0.9', other)).rejects.toMatchObject({ code: 'host-key-revoked' })
  })
})
