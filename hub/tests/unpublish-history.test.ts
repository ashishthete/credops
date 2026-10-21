import { afterEach, describe, expect, it } from 'vitest'
import { A } from '../../tests/main/fake-runner'
import { DEP_API, DEP_WEB, ENV_ID } from './manifest'
import { BOB, OPTIONS, PREV, SVC_API, SVC_WEB, envManifest, rig, type Rig } from './history-rig'

let r: Rig
afterEach(async () => r?.hub.close())

const list = async (t: string, q = `?environmentId=${ENV_ID}`) => (await r.call(t, 'GET', `/api/v1/releases${q}`)).json() as { id: string; unpublished?: boolean }[]
const unpublish = async () => {
  const res = await r.call(r.admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)
  expect(res.statusCode, res.body).toBe(204)
}

describe('unpublish keeps release history', () => {
  it('keeps each release read-only with its deployments, commits, times, status and actor', async () => {
    r = await rig()
    const id = await r.release(r.bob, [SVC_WEB, SVC_API])
    await unpublish()

    // The environment's inventory goes; its release rows stay.
    for (const t of ['hosts', 'deployments', 'services', 'env_deploy_keys', 'hub_secrets']) {
      expect(r.hub.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 })
    }
    expect(r.hub.db.prepare('SELECT COUNT(*) AS n FROM releases WHERE id = ?').get(id)).toEqual({ n: 1 })

    const d = (await r.call(r.admin, 'GET', `/api/v1/releases/${id}`)).json()
    expect(d).toMatchObject({ id, environmentName: 'prod', status: 'succeeded', triggeredBy: `${BOB.upn}@Test Hub`, unpublished: true })
    expect(d.startedAt).toBeTruthy()
    expect(d.finishedAt).toBeTruthy()
    const runs = d.runs as { deploymentId: string; deploymentName: string; previousCommit: string; deployedCommit: string; startedAt: string | null; finishedAt: string | null; status: string }[]
    expect(runs.map((x) => [x.deploymentId, x.deploymentName, x.previousCommit, x.deployedCommit, x.status])).toEqual([
      [DEP_WEB, 'web', PREV, A, 'succeeded'],
      [DEP_API, 'api', PREV, A, 'succeeded'],
    ])

    // Listed for admins, marked unpublished; the unfiltered list carries it too.
    expect(await list(r.admin)).toEqual([expect.objectContaining({ id, unpublished: true })])
    expect((await list(r.admin, '')).map((x) => x.id)).toContain(id)
    expect((await r.call(r.admin, 'GET', `/api/v1/releases/${id}/events`)).statusCode).toBe(200)

    // The audit says how many releases it kept.
    expect(r.hub.audit.list({ actions: ['env.unpublish'] })[0].details).toMatchObject({ name: 'prod', keptReleases: 1 })
  })

  it('no release can be started, rolled back or changed on an unpublished environment', async () => {
    r = await rig()
    const id = await r.release(r.bob, [SVC_WEB])
    await unpublish()
    const pf = await r.call(r.admin, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds: [SVC_WEB], bump: 'none', options: OPTIONS })
    expect(pf.statusCode).toBe(404)
    for (const op of ['start', 'rollback', 'cancel', 'discard', 'retry-version']) {
      expect((await r.call(r.admin, 'POST', `/api/v1/releases/${id}/${op}`, {})).statusCode, op).toBe(404)
    }
    expect((await r.call(r.admin, 'GET', `/api/v1/releases/${id}/playbook`)).statusCode).toBe(404)
    expect((await r.call(r.admin, 'POST', `/api/v1/environments/${ENV_ID}/freeze`, { reason: 'x', hours: 1 })).statusCode).toBe(404)
    expect(r.fr.kinds.filter((k) => k === 'release')).toHaveLength(1)
    // Grants and secrets cannot be added for it either.
    const g = (await r.call(r.admin, 'POST', '/api/v1/admin/groups', { name: 'Late' })).json().id as string
    expect((await r.call(r.admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })).statusCode).toBe(404)
    // Gone from the catalog and the admin list, and a second unpublish is a 404.
    expect((await r.call(r.admin, 'GET', '/api/v1/catalog')).json()).toEqual([])
    expect((await r.call(r.admin, 'GET', '/api/v1/admin/environments')).json()).toEqual([])
    expect((await r.call(r.admin, 'GET', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(404)
    expect((await r.call(r.admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(404)
  })

  it('former members still read it; someone who never had access does not', async () => {
    r = await rig()
    const id = await r.release(r.bob, [SVC_WEB])
    await unpublish()
    // The grants themselves are gone, as before.
    expect(r.hub.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE environment_id = ?").get(ENV_ID)).toEqual({ n: 0 })
    expect((await list(r.bob)).map((x) => x.id)).toEqual([id])
    expect((await r.call(r.bob, 'GET', `/api/v1/releases/${id}`)).statusCode).toBe(200)
    expect((await r.call(r.bob, 'GET', `/api/v1/releases/${id}/events`)).statusCode).toBe(200)
    expect((await list(r.dan, '')).map((x) => x.id)).not.toContain(id)
    expect((await r.call(r.dan, 'GET', `/api/v1/releases/${id}`)).statusCode).toBe(404)
    expect((await r.call(r.dan, 'GET', `/api/v1/releases/${id}/events`)).statusCode).toBe(404)
    expect((await r.call(r.dan, 'GET', `/api/v1/releases?environmentId=${ENV_ID}`)).statusCode).toBe(403)
    // Bob can still read it but not act on it.
    expect((await r.call(r.bob, 'POST', `/api/v1/releases/${id}/rollback`, {})).statusCode).toBe(404)
  })

  it('a republish shows the old history again, no longer marked unpublished', async () => {
    r = await rig()
    const id = await r.release(r.bob, [SVC_WEB])
    await unpublish()
    await r.publish()
    expect(await list(r.admin)).toEqual([expect.objectContaining({ id })])
    expect((await list(r.admin))[0].unpublished).toBeUndefined()
    // Access follows the new grants: Bob sees it once an admin grants him the environment again.
    expect((await r.call(r.bob, 'GET', `/api/v1/releases/${id}`)).statusCode).toBe(404)
    await r.grant()
    expect((await list(r.bob)).map((x) => x.id)).toEqual([id])
    // And the environment releases again.
    const next = await r.release(r.bob, [SVC_WEB])
    expect((await list(r.bob)).map((x) => x.id)).toEqual([next, id])
  })

  it('an unpublished environment does not hold its name', async () => {
    r = await rig()
    await r.release(r.bob, [SVC_WEB])
    await unpublish()
    const other = envManifest()
    other.environment.id = 'e9999999-9999-4999-8999-999999999999'
    other.hosts = [{ ...other.hosts[0], id: 'a9999999-9999-4999-8999-999999999999', hops: [{ ...other.hosts[0].hops[1], hostId: 'a9999999-9999-4999-8999-999999999999' }] }]
    other.deployments = other.deployments.map((d, i) => ({ ...d, id: `d999999${i}-9999-4999-8999-999999999999`, environmentId: other.environment.id, hostId: other.hosts[0].id }))
    other.services = []
    const res = await r.call(r.admin, 'PUT', `/api/v1/admin/environments/${other.environment.id}`, other)
    expect(res.statusCode, res.body).toBe(200)
  })
})
