import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../src/main/db/migrations'
import { ReleaseStore } from '../../src/main/deploy/release-store'
import type { HubEnvManifest, HubUser } from '../../src/shared/hub'
import { HUB_AUDIT_ACTIONS } from '../../src/shared/hub'
import { HUB_MIGRATIONS } from '../src/db'
import { decide } from '../src/access/policy'
import { hubAudit } from '../src/releases/adapters'
import { DEP_API, DEP_WEB, ENV_ID, SECRET_DB, deployment, manifest } from './manifest'
import { ADMIN, BOB, CAROL, OPTIONS, SVC_API, SVC_WEB, envManifest, rig, type Rig } from './history-rig'
import { testHub, type TestHub } from './helpers'

let r: Rig | undefined
let hub: TestHub | undefined
afterEach(async () => {
  await r?.hub.close()
  await hub?.close()
  r = undefined
  hub = undefined
})

const STEP = {
  id: 's1', name: 'migrate', run: 'shell', service: null, script: 'echo hi', cwd: null, sudo: 'docker', timeoutSec: 60,
  onFailure: 'stop', when: { kind: 'always' }, secrets: [], anchor: 'after_up', alsoOnRollback: false,
}
const put = async (m: HubEnvManifest) => {
  hub = await testHub()
  const admin = (await hub.signIn(ADMIN)).token
  const res = await hub.app.inject({ method: 'PUT', url: `/api/v1/admin/environments/${m.environment.id}`, headers: { authorization: `Bearer ${admin}` }, payload: m as object })
  return { res, admin }
}
const withSteps = (steps: unknown[]) => {
  const m = manifest()
  m.deployments[0] = deployment(DEP_WEB, 'web', { steps })
  return m
}

const ENV2 = 'e2222222-2222-4222-8222-222222222222'
const HOST2 = 'a3333333-3333-4333-8333-333333333333'
const DEP2 = 'd3333333-3333-4333-8333-333333333333'
const SVC2 = '74444444-4444-4444-8444-444444444444'
/** A second published environment, whose service the first one's releases must never accept. */
function stageManifest(): HubEnvManifest {
  const m2 = manifest()
  m2.environment = { id: ENV2, name: 'stage', protected: false, versioned: true, autoRollback: false, currentVersion: 'v1.0.0' }
  m2.hosts = [{ ...m2.hosts[0], id: HOST2, label: 'web-2', address: '10.0.1.5', hops: [{ hostId: HOST2, label: 'web-2', address: '10.0.1.5', port: 22, username: 'deploy' }] }]
  m2.deployments = [deployment(DEP2, 'web2', { environmentId: ENV2, hostId: HOST2 })]
  m2.services = [{ id: SVC2, name: 'web2-svc', kind: 'service', composeService: 'web', deploymentId: DEP2, hostId: HOST2, viaHostId: null }]
  m2.requiredSecrets = []
  return m2
}

describe('migration 11', () => {
  it('a v9 hub migrates to the latest and a release keeps operation null', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, HUB_MIGRATIONS.filter((m) => m.version <= 9))
    db.exec(`INSERT INTO environments VALUES ('e1','prod',0,0,0,NULL,'{}','h','u','t',NULL)`)
    db.exec(`INSERT INTO releases(id, environment_id, kind, status, version_bump, redeploy, options, triggered_by, created_at) VALUES ('r1','e1','release','succeeded','none',0,'{}','u','t')`)
    expect(migrate(db, HUB_MIGRATIONS).to).toBe(11)
    expect(db.prepare('SELECT operation FROM releases WHERE id = ?').get('r1')).toEqual({ operation: null })
    expect(db.prepare("SELECT playbook_ops FROM environments WHERE id = 'e1'").get()).toEqual({ playbook_ops: '{}' })
  })
})

describe('manifest schema 2', () => {
  it('a schema-1 manifest with a preHook reads back with a pre-hook step', async () => {
    const m = manifest()
    m.deployments[0] = deployment(DEP_WEB, 'web', { preHook: 'make prep' })
    const { res, admin } = await put(m)
    expect(res.statusCode, res.body).toBe(200)
    const got = (await hub!.app.inject({ method: 'GET', url: `/api/v1/admin/environments/${ENV_ID}`, headers: { authorization: `Bearer ${admin}` } })).json() as HubEnvManifest
    expect(got.deployments.find((d) => d.id === DEP_WEB)?.steps?.map((s) => s.id)).toEqual(['pre-hook'])
  })

  it('round-trips steps, flow, runbooks, skipUnchanged and prepare settings', async () => {
    const m = withSteps([STEP])
    m.environment.parallelPrepare = false
    m.environment.prepareCap = 5
    m.services = [{ id: SVC_WEB, name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: DEP_WEB, hostId: manifest().hosts[0].id, viaHostId: null, skipUnchanged: true }]
    const { res, admin } = await put(m)
    expect(res.statusCode, res.body).toBe(200)
    const got = (await hub!.app.inject({ method: 'GET', url: `/api/v1/admin/environments/${ENV_ID}`, headers: { authorization: `Bearer ${admin}` } })).json() as HubEnvManifest
    expect(got.environment.parallelPrepare).toBe(false)
    expect(got.environment.prepareCap).toBe(5)
    expect(got.services[0].skipUnchanged).toBe(true)
    expect(got.deployments.find((d) => d.id === DEP_WEB)?.steps?.[0].id).toBe('s1')
  })

  it.each([
    ['an invalid step', [{ ...STEP, anchor: 'nope' }]],
    ['a step secret outside requiredSecrets', [{ ...STEP, secrets: [{ envName: 'TOKEN', secretId: '59999999-9999-4999-8999-999999999999' }] }]],
    ['21 steps in a checkout', Array.from({ length: 21 }, (_, i) => ({ ...STEP, id: `s${i}`, name: `n${i}` }))],
  ])('rejects %s with a path message', async (_n, steps) => {
    const { res } = await put(withSteps(steps))
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/deployments/)
    expect(res.body).not.toContain('echo hi')
  })

  it('accepts a step secret that requiredSecrets names', async () => {
    const m = withSteps([{ ...STEP, secrets: [{ envName: 'TOKEN', secretId: SECRET_DB }] }])
    const { res } = await put(m)
    expect(res.statusCode, res.body).toBe(200)
  })
})

describe('policy', () => {
  const maintainer: HubUser = { oid: 'u1', upn: 'u@x.com', name: 'U', role: 'maintainer', status: 'active', groupIds: ['g'], createdAt: '', lastSeenAt: null }
  const grp = (scope: object) => ({
    id: 'g', name: 'G', description: '', builtin: false, memberOids: [], createdAt: '', updatedAt: '',
    grants: [{ id: 'x', groupId: 'g', scope, createdAt: '' }],
  })
  it('playbook.edit is admin only; ops.run follows a covering grant', () => {
    const groups = [grp({ kind: 'environment', environmentId: ENV_ID })] as never
    expect(decide(maintainer, groups, 'playbook.edit', { environmentId: ENV_ID }).allowed).toBe(false)
    expect(decide(maintainer, groups, 'ops.run', { environmentId: ENV_ID }).allowed).toBe(true)
    expect(decide({ ...maintainer, role: 'admin' }, groups, 'playbook.edit', { environmentId: ENV_ID }).allowed).toBe(true)
  })
})

describe('meta and config', () => {
  it('/meta reports the capabilities', async () => {
    hub = await testHub()
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/meta' })).json().capabilities).toEqual({ manifestSchema: 2, playbookEdits: false })
    await hub.close()
    hub = await testHub({ allowPlaybookEdits: true })
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/meta' })).json().capabilities.playbookEdits).toBe(true)
  })
})

describe('validate-edit and edited start', () => {
  const seed = async (rg: Rig) => {
    const store = new ReleaseStore({ db: rg.hub.db, now: () => new Date() })
    const rel = store.createRelease({
      environmentId: ENV_ID, kind: 'release', status: 'ready', version: null, previousVersion: null, versionBump: 'none',
      redeploy: true, rollbackOf: null, options: OPTIONS, triggeredBy: 'x', serviceIds: [SVC_WEB],
    })
    store.createRuns(rel.id, [{ deploymentId: DEP_WEB, deploymentName: 'web', hostId: manifest().hosts[0].id, hostLabel: 'web-1', position: 0, branch: 'main', steps: [], services: [], wholeCheckout: true } as never])
    return rel.id
  }
  const ok = { ok: true, canonical: 'x', sha256: 'y' }

  it('403 with the setting off, 403 for a maintainer with it on, 200 for an admin with it on', async () => {
    r = await rig()
    ;(r.hub.app.releases as any).service.validateEdit = async () => ok
    ;(r.hub.app.releases as any).service.preflightOperation = async () => ({ releaseId: 'x' })
    const id = await seed(r)
    const url = `/api/v1/releases/${id}/validate-edit`
    expect((await r.call(r.admin, 'POST', url, { text: 'a' })).statusCode).toBe(403)
    await r.hub.close()
    r = await rig({ allowPlaybookEdits: true })
    ;(r.hub.app.releases as any).service.validateEdit = async () => ok
    ;(r.hub.app.releases as any).service.preflightOperation = async () => ({ releaseId: 'x' })
    const id2 = await seed(r)
    const url2 = `/api/v1/releases/${id2}/validate-edit`
    expect((await r.call(r.bob, 'POST', url2, { text: 'a' })).statusCode).toBe(403)
    const res = await r.call(r.admin, 'POST', url2, { text: 'a' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual(ok)
  })
})

describe('operation visibility and audit', () => {
  it('a partially scoped holder cannot list an operation targeting an uncovered checkout', async () => {
    r = await rig()
    const store = new ReleaseStore({ db: r.hub.db, now: () => new Date() })
    const op = { runbookId: 'rb', name: 'restart', params: {}, readOnly: false, lock: true, targetServiceIds: [SVC_WEB, SVC_API] }
    const rel = store.createRelease({
      environmentId: ENV_ID, kind: 'release', status: 'succeeded', version: null, previousVersion: null, versionBump: 'none',
      redeploy: true, rollbackOf: null, options: OPTIONS, triggeredBy: 'x', serviceIds: [SVC_WEB, SVC_API], operation: op,
    })
    const plan = (deploymentId: string, name: string, position: number) =>
      ({ deploymentId, deploymentName: name, hostId: manifest().hosts[0].id, hostLabel: 'web-1', position, branch: 'main', steps: [], services: [], wholeCheckout: true }) as never
    store.createRuns(rel.id, [plan(DEP_WEB, 'web', 0), plan(DEP_API, 'api', 1)])
    const ids = async (t: string, q = '') => ((await r!.call(t, 'GET', `/api/v1/releases?environmentId=${ENV_ID}${q}`)).json() as { id: string }[]).map((x) => x.id)
    expect(await ids(r.bob)).toContain(rel.id)
    expect(await ids(r.bob, '&operations=only')).toContain(rel.id)
    expect(await ids(r.bob, '&operations=exclude')).not.toContain(rel.id)
    expect(await ids(r.carol)).not.toContain(rel.id)
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${rel.id}`)).statusCode).toBe(404)
  })

  it('the ops.run audit entry carries no host fields', async () => {
    hub = await testHub()
    const adapter = hubAudit({ audit: hub.audit, directory: { get: () => null } as never, access: { viaFor: () => null } as never, envOfTarget: () => null })
    expect(HUB_AUDIT_ACTIONS).toContain('ops.run')
    adapter.append({ action: 'ops.run', outcome: 'success', actor: { osUser: 'x', hubUserId: null } as never, targetType: 'release', targetId: 'r1', details: { services: 2, runbook: 'restart' } })
    const rows = hub.audit.list({ actions: ['ops.run'] })
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(/host|address|10\.0\.0/i)
  })
})

describe('hooks next to steps', () => {
  it('schema-1 hooks migrate to steps and the hooks are nulled', async () => {
    const m = manifest()
    m.deployments[0] = deployment(DEP_WEB, 'web', { preHook: 'make prep', postHook: 'make done' })
    const { res, admin } = await put(m)
    expect(res.statusCode, res.body).toBe(200)
    const got = (await hub!.app.inject({ method: 'GET', url: `/api/v1/admin/environments/${ENV_ID}`, headers: { authorization: `Bearer ${admin}` } })).json() as HubEnvManifest
    const d = got.deployments.find((x) => x.id === DEP_WEB)!
    expect(d.steps?.map((s) => s.id)).toEqual(['pre-hook', 'post-hook'])
    expect(d.preHook).toBeNull()
    expect(d.postHook).toBeNull()
  })

  it('a schema-2 manifest with steps and hooks is rejected with a path message', async () => {
    const m = withSteps([STEP])
    m.deployments[0] = { ...m.deployments[0], preHook: 'make prep' }
    ;(m as { schema?: number }).schema = 2
    const { res } = await put(m)
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/deployments\/0\/steps/)
    expect(res.body).not.toContain('make prep')
  })
})

describe('preview forceServiceIds', () => {
  it('forwards the ids to previewPlaybook and rejects bad ones', async () => {
    r = await rig()
    const store = new ReleaseStore({ db: r.hub.db, now: () => new Date() })
    const rel = store.createRelease({
      environmentId: ENV_ID, kind: 'release', status: 'ready', version: null, previousVersion: null, versionBump: 'none',
      redeploy: true, rollbackOf: null, options: OPTIONS, triggeredBy: 'x', serviceIds: [SVC_WEB, SVC_API],
    })
    store.createRuns(rel.id, [{ deploymentId: DEP_WEB, deploymentName: 'web', hostId: manifest().hosts[0].id, hostLabel: 'web-1', position: 0, branch: 'main', steps: [], services: [], wholeCheckout: true } as never])
    expect((await r.call(r.admin, 'PUT', `/api/v1/admin/environments/${ENV2}`, stageManifest())).statusCode).toBe(200)
    const seen: unknown[] = []
    ;(r.hub.app.releases as any).service.previewPlaybook = async (_id: string, _ctx: unknown, force: unknown) => {
      seen.push(force)
      return { playbook: 'p', sha256: 'a'.repeat(64) }
    }
    const url = `/api/v1/releases/${rel.id}/playbook`
    expect((await r.call(r.admin, 'GET', url)).statusCode).toBe(200)
    expect((await r.call(r.admin, 'GET', `${url}?forceServiceIds=${SVC_WEB}&forceServiceIds=${SVC_API}`)).statusCode).toBe(200)
    expect((await r.call(r.admin, 'GET', `${url}?forceServiceIds=${SVC_API}`)).statusCode).toBe(200)
    expect(seen).toEqual([undefined, [SVC_WEB, SVC_API], [SVC_API]])
    expect((await r.call(r.admin, 'GET', `${url}?forceServiceIds=not-an-id`)).statusCode).toBe(400)
    expect((await r.call(r.admin, 'GET', `${url}?forceServiceIds=${SVC2}`)).statusCode).toBe(400)
    expect(seen).toHaveLength(3)
  })
})

describe('operations: preflight and start', () => {
  const RB_LOCK = 'b1111111-1111-4111-8111-111111111111'
  const RB_READ = 'b2222222-2222-4222-8222-222222222222'
  const RB_OTHER = 'b3333333-3333-4333-8333-333333333333'
  const runbook = (id: string, name: string, svc: string, builtin: 'restart' | 'status') => ({
    id, name, description: '', targetServiceIds: [svc], items: [{ type: 'builtin' as const, builtin }], params: [], lock: true, notify: false,
  })
  const lockOf = () => r!.hub.db.prepare('SELECT release_id FROM env_locks WHERE environment_id = ?').get(ENV_ID) as { release_id: string } | undefined
  const operation = (lock: boolean) => ({ runbookId: RB_LOCK, name: 'restart', params: {}, readOnly: !lock, lock, targetServiceIds: [SVC_WEB] })
  const seedOp = (lock: boolean, status: 'ready' | 'succeeded' = 'ready') => {
    const store = new ReleaseStore({ db: r!.hub.db, now: () => new Date() })
    const rel = store.createRelease({
      environmentId: ENV_ID, kind: 'release', status, version: null, previousVersion: null, versionBump: 'none',
      redeploy: true, rollbackOf: null, options: OPTIONS, triggeredBy: 'x', serviceIds: [SVC_WEB], operation: operation(lock),
    })
    store.createRuns(rel.id, [{ deploymentId: DEP_WEB, deploymentName: 'web', hostId: manifest().hosts[0].id, hostLabel: 'web-1', position: 0, branch: 'main', steps: [], services: [], wholeCheckout: true } as never])
    return rel.id
  }
  const body = (runbookId: string, serviceIds = [SVC_WEB]) => ({ environmentId: ENV_ID, runbookId, serviceIds, params: {} })

  async function setup(config = {}) {
    r = await rig(config)
    const m = envManifest()
    m.runbooks = [runbook(RB_LOCK, 'restart', SVC_WEB, 'restart'), { ...runbook(RB_READ, 'status', SVC_WEB, 'status'), lock: false }]
    expect((await r.call(r.admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, m)).statusCode).toBe(200)
    const m2 = stageManifest()
    m2.runbooks = [runbook(RB_OTHER, 'other', SVC2, 'restart')]
    expect((await r.call(r.admin, 'PUT', `/api/v1/admin/environments/${ENV2}`, m2)).statusCode).toBe(200)
    return (r.hub.app.releases as any).service as Record<string, unknown>
  }
  const URL_PF = '/api/v1/releases/preflight-operation'

  it('refuses a holder whose grant does not cover the target checkout', async () => {
    const svc = await setup()
    let called = false
    svc.preflightOperation = async () => ((called = true), { releaseId: 'x' })
    svc.validateEdit = async () => ({ ok: true })
    const res = await r!.call(r!.carol, 'POST', URL_PF, body(RB_LOCK))
    expect(res.statusCode).toBe(403)
    expect(called).toBe(false)
    expect(lockOf()).toBeUndefined()
  })

  it('404s for a runbook of another environment', async () => {
    const svc = await setup()
    svc.preflightOperation = async () => ({ releaseId: 'x' })
    svc.validateEdit = async () => ({ ok: true })
    expect((await r!.call(r!.admin, 'POST', URL_PF, body(RB_OTHER))).statusCode).toBe(404)
    expect(lockOf()).toBeUndefined()
  })

  it('takes the lock for a locking runbook, binds it to the release, and frees it when the service fails', async () => {
    const svc = await setup()
    svc.validateEdit = async () => ({ ok: true })
    const rel = seedOp(true)
    svc.preflightOperation = async () => ({ releaseId: rel })
    const ok = await r!.call(r!.admin, 'POST', URL_PF, body(RB_LOCK))
    expect(ok.statusCode, ok.body).toBe(201)
    expect(lockOf()).toEqual({ release_id: rel })
    r!.hub.db.exec('DELETE FROM env_locks')
    svc.preflightOperation = async () => {
      expect(lockOf()).toBeDefined()
      throw new Error('boom')
    }
    const bad = await r!.call(r!.admin, 'POST', URL_PF, body(RB_LOCK))
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)
    expect(lockOf()).toBeUndefined()
  })

  it('takes no lock for a runbook that does not lock, and start does not need one', async () => {
    const svc = await setup()
    svc.validateEdit = async () => ({ ok: true })
    const rel = seedOp(false)
    svc.preflightOperation = async () => {
      expect(lockOf()).toBeUndefined()
      return { releaseId: rel }
    }
    const pf = await r!.call(r!.admin, 'POST', URL_PF, body(RB_READ))
    expect(pf.statusCode, pf.body).toBe(201)
    expect(lockOf()).toBeUndefined()
    const started: string[] = []
    svc.start = async (id: string) => void started.push(id)
    const st = await r!.call(r!.admin, 'POST', `/api/v1/releases/${rel}/start`, {})
    expect(st.statusCode, st.body).toBe(204)
    expect(started).toEqual([rel])
    // A locking operation without its lock is refused.
    const locked = seedOp(true)
    const no = await r!.call(r!.admin, 'POST', `/api/v1/releases/${locked}/start`, {})
    expect(no.statusCode).toBe(409)
  })

  it('start refuses a forceServiceIds naming a real service of another environment', async () => {
    const svc = await setup()
    let started = false
    svc.start = async () => void (started = true)
    const rel = seedOp(false)
    const res = await r!.call(r!.admin, 'POST', `/api/v1/releases/${rel}/start`, { forceServiceIds: [SVC2] })
    expect(res.statusCode, res.body).toBe(400)
    expect(started).toBe(false)
  })

  it('refuses start with an editedPlaybook while edits are off, before the service runs', async () => {
    const svc = await setup()
    let started = false
    svc.start = async () => void (started = true)
    const rel = seedOp(false)
    const res = await r!.call(r!.admin, 'POST', `/api/v1/releases/${rel}/start`, { editedPlaybook: 'x' })
    expect(res.statusCode).toBe(403)
    expect(started).toBe(false)
    expect(r!.hub.audit.list({ actions: ['access.denied'] }).length).toBeGreaterThan(0)
  })
})
