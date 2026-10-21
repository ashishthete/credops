import { afterEach, describe, expect, it } from 'vitest'
import type { ReleaseDetail, ReleaseSummary, RunEvent } from '../../src/shared/deploy'
import { DEP_API, DEP_WEB, ENV_ID, HOST_ID } from './manifest'
import { ADMIN, BOB, CAROL, OPTIONS, SVC_API, SVC_WEB, rig, type Rig } from './history-rig'

/* Carol's grant covers the api checkout only: she sees the releases that touch it, and only its part of them. */

let r: Rig
afterEach(async () => r?.hub.close())

const get = async <T>(t: string, url: string): Promise<T> => {
  const res = await r.call(t, 'GET', url)
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200)
  return res.json() as T
}
const ids = (l: ReleaseSummary[]) => l.map((x) => x.id)
const lines = (evs: RunEvent[]) => evs.flatMap((e) => (e.type === 'log' ? [e.line] : []))

/** What a scripted run does besides its usual lines: fail one checkout, or wait before it ends. */
interface Script {
  fail?: { name: string; error: string }
  hold?: Promise<void>
}
let script: Script = {}

/**
 * A release run writes a step and a log line per checkout, plus host, release-level (one of them the version
 * step's), raw host and unattributed lines.
 */
async function scoped(): Promise<Rig> {
  script = {}
  r = await rig()
  r.fr.checks = [
    { id: 'repo', deploymentId: DEP_WEB, hostId: HOST_ID, label: 'Repo', level: 'ok', message: 'web repo ok' },
    { id: 'repo', deploymentId: DEP_API, hostId: HOST_ID, label: 'Repo', level: 'ok', message: 'api repo ok' },
    { id: 'disk', deploymentId: null, hostId: HOST_ID, label: 'Disk', level: 'ok', message: 'host disk ok' },
  ]
  const commits = r.fr.on.release!
  r.fr.on.release = async (plan, secrets, emit, runId) => {
    emit({ type: 'step.started', stepId: `host:${HOST_ID}:lock`, kind: 'lock', name: 'Lock', hostId: HOST_ID, deploymentRunId: null })
    emit({ type: 'log', stepId: `host:${HOST_ID}:lock`, hostId: HOST_ID, stream: 'out', line: 'host lock line' })
    for (const d of plan.deployments) {
      const stepId = `${d.runId}:checkout`
      emit({ type: 'step.started', stepId, kind: 'checkout', name: `Checkout ${d.name}`, hostId: d.hostId, deploymentRunId: d.runId })
      emit({ type: 'log', stepId, hostId: d.hostId, stream: 'out', line: `pulled ${d.name}` })
      emit({ type: 'task.done', stepId, task: 'git', hostId: d.hostId, state: 'ok', rc: 0, attempts: null, durationMs: 1 })
      if (script.fail?.name === d.name) emit({ type: 'step.failed', stepId, error: script.fail.error, durationMs: 1 })
      else emit({ type: 'step.done', stepId, state: 'ok', durationMs: 1 })
    }
    emit({ type: 'log', stepId: 'release:record', hostId: null, stream: 'ansible', line: 'release line' })
    emit({ type: 'log', stepId: 'release:version', hostId: null, stream: 'ansible', line: 'version line' })
    emit({ type: 'log', stepId: null, hostId: HOST_ID, stream: 'out', line: 'host raw line' })
    emit({ type: 'log', stepId: null, hostId: null, stream: 'err', line: 'unattributed line' })
    if (script.hold) await script.hold
    const out = (await commits(plan, secrets, emit, runId)) || {}
    const failed = plan.deployments.find((d) => d.name === script.fail?.name)
    return failed ? { ...out, exitCode: 2, failedDeploymentRunIds: [failed.runId], reachedCheckout: plan.deployments.map((d) => d.runId) } : out
  }
  return r
}

describe('deployment-scoped access to releases', () => {
  it('lists only the releases that include her deployment; any other is a 404 and is not counted', async () => {
    await scoped()
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const apiOnly = await r.release(r.carol, [SVC_API])
    const webOnly = await r.release(r.bob, [SVC_WEB])

    expect(ids(await get(r.carol, `/api/v1/releases?environmentId=${ENV_ID}`))).toEqual([apiOnly, both])
    expect(ids(await get(r.carol, '/api/v1/releases'))).toEqual([apiOnly, both])
    // The limit counts what she can see: the newest release (web only) does not use up a slot.
    expect(ids(await get(r.carol, `/api/v1/releases?environmentId=${ENV_ID}&limit=2`))).toEqual([apiOnly, both])
    expect(ids(await get(r.carol, `/api/v1/releases?limit=1&before=${apiOnly}`))).toEqual([both])

    for (const path of ['', '/events', '/playbook']) {
      expect((await r.call(r.carol, 'GET', `/api/v1/releases/${webOnly}${path}`)).statusCode, path).toBe(404)
    }

    // Her copy of the shared release counts only her part.
    const s = (await get<ReleaseSummary[]>(r.carol, '/api/v1/releases')).find((x) => x.id === both)!
    expect(s).toMatchObject({ deploymentCount: 1, hostCount: 1, serviceIds: [SVC_API], serviceCount: 1 })

    // Env-wide members and admins are unchanged.
    for (const t of [r.bob, r.admin]) {
      expect(ids(await get(t, `/api/v1/releases?environmentId=${ENV_ID}`))).toEqual([webOnly, apiOnly, both])
      expect((await get<ReleaseSummary[]>(t, '/api/v1/releases')).find((x) => x.id === both)).toMatchObject({ deploymentCount: 2, serviceCount: 2 })
    }
  })

  it('her detail and events of a shared release hold only her deployment, its host and the release-wide parts', async () => {
    await scoped()
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const apiRun = (await get<ReleaseDetail>(r.admin, `/api/v1/releases/${both}`)).runs.find((x) => x.deploymentId === DEP_API)!.id

    const d = await get<ReleaseDetail>(r.carol, `/api/v1/releases/${both}`)
    expect(d.runs.map((x) => x.deploymentId)).toEqual([DEP_API])
    expect(d.preflight!.checks.map((c) => c.message)).toEqual(['api repo ok', 'host disk ok'])
    expect(Object.keys(d.preflight!.commits)).toEqual([DEP_API])
    expect(Object.keys(d.preflight!.dockerModes)).toEqual([DEP_API])
    expect(Object.keys(d.preflight!.composeServices)).toEqual([DEP_API])
    expect(Object.keys(d.preflight!.serviceCommits)).toEqual([SVC_API])
    // The playbook covers both checkouts, so she does not get it.
    expect(d.playbook).toBeNull()

    const evs = await get<RunEvent[]>(r.carol, `/api/v1/releases/${both}/events`)
    expect(lines(evs)).toEqual(['host lock line', 'pulled api', 'release line'])
    const runIds = evs.flatMap((e) => (e.type === 'step.started' || e.type === 'deployment.updated') && e.deploymentRunId ? [e.deploymentRunId] : [])
    expect(new Set(runIds)).toEqual(new Set([apiRun]))
    expect(evs.filter((e) => e.type === 'task.done')).toHaveLength(1)
    expect(evs.filter((e) => e.type === 'preflight.check').map((e) => (e.type === 'preflight.check' ? e.check.message : ''))).toEqual(['api repo ok', 'host disk ok'])
    const report = evs.find((e) => e.type === 'preflight.done')
    expect(report && report.type === 'preflight.done' ? Object.keys(report.report.commits) : null).toEqual([DEP_API])
    expect(JSON.stringify(evs)).not.toContain('pulled web')
    expect(JSON.stringify(d)).not.toContain(DEP_WEB)

    // A page of events is filled with what she can see.
    const page = await get<RunEvent[]>(r.carol, `/api/v1/releases/${both}/events?limit=3`)
    expect(page).toEqual(evs.slice(0, 3))
    const rest = await get<RunEvent[]>(r.carol, `/api/v1/releases/${both}/events?afterSeq=${page[2].seq}`)
    expect([...page, ...rest]).toEqual(evs)

    // Env-wide members and admins see all of it.
    for (const t of [r.bob, r.admin]) {
      const all = await get<ReleaseDetail>(t, `/api/v1/releases/${both}`)
      expect(all.runs).toHaveLength(2)
      expect(all.playbook).not.toBeNull()
      // Theirs include the finish-up notices, which carry no step or host and so are never in a scoped view.
      expect(lines(await get<RunEvent[]>(t, `/api/v1/releases/${both}/events`)).slice(0, 7)).toEqual(['host lock line', 'pulled web', 'pulled api', 'release line', 'version line', 'host raw line', 'unattributed line'])
    }
  })

  it('the playbook preview is hers only when it covers only her deployments', async () => {
    await scoped()
    const ready = async (t: string, serviceIds: string[]) => {
      const pf = await r.call(t, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds, bump: 'none', options: OPTIONS })
      expect(pf.statusCode, pf.body).toBe(201)
      await r.hub.app.releases.whenIdle()
      return pf.json().releaseId as string
    }
    const mine = await ready(r.carol, [SVC_API])
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${mine}/playbook`)).statusCode).toBe(200)
    const dc = await r.call(r.admin, 'POST', `/api/v1/releases/${mine}/discard`)
    expect(dc.statusCode, dc.body).toBe(204)
    await r.hub.app.releases.whenIdle()
    const shared = await ready(r.bob, [SVC_WEB, SVC_API])
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${shared}/playbook`)).statusCode).toBe(403)
    expect((await r.call(r.admin, 'POST', `/api/v1/releases/${shared}/discard`)).statusCode).toBe(204)
    await r.hub.app.releases.whenIdle()
    const theirs = await ready(r.bob, [SVC_WEB])
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${theirs}/playbook`)).statusCode).toBe(404)
    expect((await r.call(r.bob, 'GET', `/api/v1/releases/${theirs}/playbook`)).statusCode).toBe(200)
  })

  it('the live feed sends her only her releases and her part of them', async () => {
    await scoped()
    const feed = (oid: string) => {
      const frames: { event: string; data: any }[] = []
      r.hub.app.live.subscribe(oid, (f) => {
        const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(f)
        if (m) frames.push({ event: m[1], data: JSON.parse(m[2]) })
      }, () => {})
      return frames
    }
    const carol = feed(CAROL.oid)
    const bob = feed(BOB.oid)
    const admin = feed(ADMIN.oid)
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const webOnly = await r.release(r.bob, [SVC_WEB])

    const releasesIn = (fs: typeof carol) => new Set(fs.flatMap((f) => (f.event === 'release.state' ? [f.data.summary.id] : f.event === 'deploy.events' ? f.data.events.map((e: RunEvent) => e.runId) : [])))
    const feedLines = (fs: typeof carol, id: string) => fs.flatMap((f) => (f.event === 'deploy.events' ? lines((f.data.events as RunEvent[]).filter((e) => e.runId === id)) : []))
    expect(releasesIn(carol)).toEqual(new Set([both]))
    expect(feedLines(carol, both)).toEqual(['host lock line', 'pulled api', 'release line'])
    expect(carol.filter((f) => f.event === 'release.state').every((f) => f.data.summary.deploymentCount === 1)).toBe(true)
    for (const fs of [bob, admin]) {
      expect(releasesIn(fs)).toEqual(new Set([both, webOnly]))
      expect(feedLines(fs, both).slice(0, 7)).toEqual(['host lock line', 'pulled web', 'pulled api', 'release line', 'version line', 'host raw line', 'unattributed line'])
    }
  })

  it('the history of an unpublished environment keeps her scope', async () => {
    await scoped()
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const webOnly = await r.release(r.bob, [SVC_WEB])
    expect((await r.call(r.admin, 'DELETE', `/api/v1/admin/environments/${ENV_ID}`)).statusCode).toBe(204)

    expect(ids(await get(r.carol, `/api/v1/releases?environmentId=${ENV_ID}`))).toEqual([both])
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${webOnly}`)).statusCode).toBe(404)
    expect((await r.call(r.carol, 'GET', `/api/v1/releases/${webOnly}/events`)).statusCode).toBe(404)
    const d = await get<ReleaseDetail>(r.carol, `/api/v1/releases/${both}`)
    expect(d).toMatchObject({ unpublished: true, deploymentCount: 1 })
    expect(d.runs.map((x) => x.deploymentId)).toEqual([DEP_API])
    expect(lines(await get<RunEvent[]>(r.carol, `/api/v1/releases/${both}/events`))).toEqual(['host lock line', 'pulled api', 'release line'])
    expect(ids(await get(r.bob, `/api/v1/releases?environmentId=${ENV_ID}`))).toEqual([webOnly, both])
  })
})

describe('deployment-scoped access: what else could name the other deployment', () => {
  const HIDDEN_ERROR = /may concern deployments you don't have access to/

  it('a raw line on a host shared with a hidden checkout, and the version step lines, are not hers', async () => {
    await scoped()
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const apiOnly = await r.release(r.carol, [SVC_API])
    expect(lines(await get<RunEvent[]>(r.carol, `/api/v1/releases/${both}/events`))).toEqual(['host lock line', 'pulled api', 'release line'])
    // On her own release the host runs nothing else, so its raw lines are hers.
    expect(lines(await get<RunEvent[]>(r.carol, `/api/v1/releases/${apiOnly}/events`))).toEqual(['host lock line', 'pulled api', 'release line', 'host raw line'])
  })

  it('the release notes are hers only when the release is all hers', async () => {
    await scoped()
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const apiOnly = await r.release(r.carol, [SVC_API])
    r.hub.db.prepare("UPDATE releases SET release_notes = 'web: new checkout page' WHERE id IN (?, ?)").run(both, apiOnly)
    expect((await get<ReleaseDetail>(r.carol, `/api/v1/releases/${both}`)).releaseNotes).toBeNull()
    expect((await get<ReleaseDetail>(r.carol, `/api/v1/releases/${apiOnly}`)).releaseNotes).toBe('web: new checkout page')
    expect((await get<ReleaseDetail>(r.bob, `/api/v1/releases/${both}`)).releaseNotes).toBe('web: new checkout page')
  })

  it("the error of a part she can't view is replaced; her own part's error is shown", async () => {
    await scoped()
    const feed: { event: string; data: any }[] = []
    r.hub.app.live.subscribe(CAROL.oid, (f) => {
      const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(f)
      if (m) feed.push({ event: m[1], data: JSON.parse(m[2]) })
    }, () => {})
    script.fail = { name: 'web', error: 'web broke on web-secret-host' }
    const webFailed = await r.release(r.bob, [SVC_WEB, SVC_API])
    expect((await get<ReleaseDetail>(r.bob, `/api/v1/releases/${webFailed}`)).error).toBe('web broke on web-secret-host')
    const d = await get<ReleaseDetail>(r.carol, `/api/v1/releases/${webFailed}`)
    expect(d.error).toMatch(HIDDEN_ERROR)
    expect((await get<ReleaseSummary[]>(r.carol, '/api/v1/releases')).find((x) => x.id === webFailed)!.error).toMatch(HIDDEN_ERROR)
    const fin = (await get<RunEvent[]>(r.carol, `/api/v1/releases/${webFailed}/events`)).find((e) => e.type === 'run.finished')
    expect(fin && fin.type === 'run.finished' ? fin.error : null).toMatch(HIDDEN_ERROR)
    expect(JSON.stringify(feed)).not.toContain('web-secret-host')

    script.fail = { name: 'api', error: 'api broke' }
    const apiFailed = await r.release(r.bob, [SVC_WEB, SVC_API])
    expect((await get<ReleaseDetail>(r.carol, `/api/v1/releases/${apiFailed}`)).error).toBe('api broke')
  })

  it('the environment lock does not give her the id of a release she cannot view', async () => {
    await scoped()
    let go!: () => void
    script.hold = new Promise((res) => (go = res))
    const frames: string[] = []
    r.hub.app.live.subscribe(CAROL.oid, (f) => frames.push(f), () => {})
    const pf = await r.call(r.bob, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds: [SVC_WEB], bump: 'none', options: OPTIONS })
    const id = pf.json().releaseId as string
    await r.hub.app.releases.whenIdle()
    expect((await r.call(r.bob, 'POST', `/api/v1/releases/${id}/start`, { redeploy: true })).statusCode).toBe(204)
    await new Promise((res) => setTimeout(res, 20))
    const carolLocks = await get<{ releaseId: string | null; kind: string }[]>(r.carol, '/api/v1/locks')
    expect(carolLocks).toEqual([expect.objectContaining({ kind: 'release', releaseId: null })])
    expect((await get<{ releaseId: string | null }[]>(r.bob, '/api/v1/locks'))[0].releaseId).toBe(id)
    expect(frames.join('')).not.toContain(id)
    go()
    await r.hub.app.releases.whenIdle()
  })

  it('a change to a release she cannot view is a 404, audited; one she views in part is refused without naming the rest', async () => {
    await scoped()
    const webOnly = await r.release(r.bob, [SVC_WEB])
    const both = await r.release(r.bob, [SVC_WEB, SVC_API])
    const denied = () => r.hub.audit.list({ actions: ['access.denied'] }).filter((a) => a.targetId === webOnly).length
    const before = denied()
    const posts: [string, unknown][] = [
      ['start', { redeploy: true }],
      ['cancel', undefined],
      ['rollback', {}],
      ['discard', undefined],
      ['retry-version', undefined],
      ['break-lock', { hostId: HOST_ID, typedLabel: 'x' }],
    ]
    for (const [op, body] of posts) {
      const res = await r.call(r.carol, 'POST', `/api/v1/releases/${webOnly}/${op}`, body)
      expect(res.statusCode, `${op}: ${res.body}`).toBe(404)
    }
    expect(denied() - before).toBe(posts.length)
    expect(r.hub.audit.list({ actions: ['access.denied'] }).find((a) => a.targetId === webOnly)!.details).toMatchObject({ code: 'not_visible' })

    for (const res of [await r.call(r.carol, 'POST', `/api/v1/releases/${both}/rollback`, {}), await r.call(r.carol, 'GET', `/api/v1/releases/${both}/playbook`)]) {
      expect(res.statusCode).toBe(403)
      expect(res.body).not.toContain(DEP_WEB)
      expect(res.json().message).toBe("This release includes deployments you don't have access to.")
    }
  })

  it('she can discard and cancel her own release', async () => {
    await scoped()
    const pf = await r.call(r.carol, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds: [SVC_API], bump: 'none', options: OPTIONS })
    await r.hub.app.releases.whenIdle()
    const dc = await r.call(r.carol, 'POST', `/api/v1/releases/${pf.json().releaseId}/discard`)
    expect(dc.statusCode, dc.body).toBe(204)

    let go!: () => void
    script.hold = new Promise((res) => (go = res))
    const pf2 = await r.call(r.carol, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds: [SVC_API], bump: 'none', options: OPTIONS })
    const id = pf2.json().releaseId as string
    await r.hub.app.releases.whenIdle()
    expect((await r.call(r.carol, 'POST', `/api/v1/releases/${id}/start`, { redeploy: true })).statusCode).toBe(204)
    await new Promise((res) => setTimeout(res, 20))
    const cancel = r.call(r.carol, 'POST', `/api/v1/releases/${id}/cancel`)
    go()
    const res = await cancel
    expect(res.statusCode, res.body).toBe(204)
    await r.hub.app.releases.whenIdle()
  })
})
