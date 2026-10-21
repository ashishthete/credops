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
import { ADMIN, BOB, CAROL, OPTIONS, SVC_API, SVC_WEB, rig, type Rig } from './history-rig'
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
