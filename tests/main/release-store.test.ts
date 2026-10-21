import { describe, expect, it, vi } from 'vitest'
import { uuidv7Time } from '../../src/main/deploy/uuidv7'
import { DEFAULT_RELEASE_OPTIONS, type PreflightReport, type RunEventBody, type RunService } from '../../src/shared/deploy'
import { makeDeployFixture } from './deploy-helpers'

const log = (line: string): RunEventBody => ({ type: 'log', stepId: null, hostId: null, stream: 'out', line })

async function release(maxEvents?: number) {
  const f = await makeDeployFixture({ maxEvents })
  const d = f.deploys.create(f.input())
  const r = f.releases.createRelease({
    environmentId: f.staging.id,
    kind: 'release',
    status: 'ready',
    version: null,
    previousVersion: null,
    versionBump: 'none',
    redeploy: false,
    rollbackOf: null,
    options: DEFAULT_RELEASE_OPTIONS,
    triggeredBy: 'ana@mbp',
    serviceIds: [],
  })
  return { f, d, r }
}

describe('ReleaseStore', () => {
  it('createRelease stores a UUIDv7 id and get returns the summary', async () => {
    const { f, r } = await release()
    expect(uuidv7Time(r.id)).toBeGreaterThan(0)
    expect(f.releases.get(r.id)).toMatchObject({
      id: r.id,
      environmentName: 'staging',
      kind: 'release',
      status: 'ready',
      triggeredBy: 'ana@mbp',
      deploymentCount: 0,
      hostCount: 0,
      startedAt: null,
      error: null,
    })
    f.releases.setStatus(r.id, 'running', { startedAt: '2026-01-01T00:00:00.000Z', version: 'v1.0.0', previousVersion: null })
    expect(f.releases.get(r.id)).toMatchObject({ status: 'running', startedAt: '2026-01-01T00:00:00.000Z', version: 'v1.0.0' })
    expect(() => f.releases.get('nope')).toThrow('release not found')
  })

  it('appendEvents assigns increasing seq and UUIDv7 ids', async () => {
    const { f, r } = await release()
    const a = f.releases.appendEvents(r.id, [log('one'), log('two')])
    const b = f.releases.appendEvents(r.id, [log('three')])
    expect([...a, ...b].map((e) => e.seq)).toEqual([1, 2, 3])
    const ids = [...a, ...b].map((e) => e.id)
    expect([...ids].sort()).toEqual(ids)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/)
    expect(a[0]).toMatchObject({ runId: r.id, type: 'log', line: 'one' })
    expect(typeof a[0].at).toBe('string')
  })

  it('events pages by afterSeq', async () => {
    const { f, r } = await release()
    f.releases.appendEvents(r.id, Array.from({ length: 10 }, (_, i) => log(`l${i}`)))
    const p1 = f.releases.events(r.id, 0, 4)
    expect(p1.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    const p2 = f.releases.events(r.id, 4, 100)
    expect(p2.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10])
    expect(p2[0]).toMatchObject({ type: 'log', line: 'l4', runId: r.id })
    expect(f.releases.events(r.id, 10, 100)).toEqual([])
    expect(f.releases.events(r.id, 0, 99999)).toHaveLength(10)
  })

  it('drops log events past the cap with one log.truncated', async () => {
    const { f, r } = await release(5)
    f.releases.appendEvents(r.id, Array.from({ length: 4 }, (_, i) => log(`l${i}`)))
    const out = f.releases.appendEvents(r.id, [log('x1'), log('x2'), log('x3')])
    f.releases.appendEvents(r.id, [log('x4')])
    const finished = f.releases.appendEvents(r.id, [{ type: 'run.finished', status: 'failed' }])
    expect(finished.map((e) => e.type)).toEqual(['log.truncated', 'run.finished'])
    const all = f.releases.events(r.id, 0, 100)
    expect(all.filter((e) => e.type === 'log')).toHaveLength(5)
    expect(all.filter((e) => e.type === 'log.truncated')).toHaveLength(1)
    expect(all.at(-1)).toMatchObject({ type: 'run.finished' })
    expect(out).toHaveLength(1) // dropped logs add no events until the next non-log event
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1))
    // x2, x3 in one batch, x4 in the next: the stored count keeps up.
    expect(all.find((e) => e.type === 'log.truncated')).toMatchObject({ dropped: 3 })
  })

  it('createRuns stores planned pending steps', async () => {
    const { f, d, r } = await release()
    const [run] = f.releases.createRuns(r.id, [
      {
        deploymentId: d.id,
        deploymentName: 'api',
        hostId: d.hostId,
        hostLabel: 'app1',
        position: 0,
        branch: 'main',
        steps: [
          { stepId: 'X:record', kind: 'record' },
          { stepId: 'X:fetch', kind: 'fetch' },
        ],
        services: [],
        wholeCheckout: true,
      },
    ])
    expect(run).toMatchObject({ status: 'pending', rolledBack: false, previousCommit: null, commits: [] })
    expect(run.steps).toEqual([
      { stepId: 'X:record', kind: 'record', state: 'pending', startedAt: null, finishedAt: null },
      { stepId: 'X:fetch', kind: 'fetch', state: 'pending', startedAt: null, finishedAt: null },
    ])
    expect(f.releases.get(r.id)).toMatchObject({ deploymentCount: 1, hostCount: 1 })
  })

  it('detail gives a report stored before services empty composeServices and serviceCommits', async () => {
    const { f, r } = await release()
    const old = { releaseId: r.id, checks: [], commits: {}, dockerModes: {}, locks: {}, commitsTotal: 0, blocked: false }
    f.releases.appendEvents(r.id, [{ type: 'preflight.done', report: old as unknown as PreflightReport }])
    expect(f.releases.detail(r.id).preflight).toEqual({ ...old, composeServices: {}, serviceCommits: {} })
  })

  it('detail joins runs with parsed steps and commits', async () => {
    const { f, d, r } = await release()
    const [run] = f.releases.createRuns(r.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [{ stepId: 's1', kind: 'record' }], services: [], wholeCheckout: true },
    ])
    const commits = [{ sha: 'abc', subject: 's', author: 'a', date: 'd', deploymentId: d.id }]
    const steps = [{ stepId: 's1', kind: 'record' as const, state: 'ok' as const, startedAt: 't0', finishedAt: 't1' }]
    f.releases.updateRun(run.id, { status: 'running', previousCommit: 'p1', deployedCommit: 'd1', commits, steps, backupFile: '/b/x.sql', startedAt: 't0' })
    f.releases.updateRun(run.id, { rolledBack: true })
    const report = { releaseId: r.id, checks: [], commits: {}, dockerModes: {}, composeServices: {}, serviceCommits: {}, locks: {}, commitsTotal: 0, blocked: false }
    f.releases.appendEvents(r.id, [{ type: 'preflight.done', report }, log('hi')])
    f.releases.setStatus(r.id, 'ready', { releaseNotes: 'notes', playbook: '{"p":1}' })
    const detail = f.releases.detail(r.id)
    expect(detail).toMatchObject({ id: r.id, options: DEFAULT_RELEASE_OPTIONS, releaseNotes: 'notes', playbook: '{"p":1}', lastSeq: 2, preflight: report })
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]).toMatchObject({
      status: 'running',
      rolledBack: true,
      previousCommit: 'p1',
      deployedCommit: 'd1',
      commits,
      steps,
      backupFile: '/b/x.sql',
      deploymentName: 'api',
    })
  })

  it('list pages newest first and filters by environment; active lists running ones', async () => {
    const f = await makeDeployFixture()
    const mk = (environmentId: string) =>
      f.releases.createRelease({
        environmentId, kind: 'release', status: 'ready', version: null, previousVersion: null,
        versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m', serviceIds: [],
      })
    const a = mk(f.staging.id)
    const b = mk(f.staging.id)
    const c = mk(f.prod.id)
    expect(f.releases.list({ limit: 10 }).map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect(f.releases.list({ environmentId: f.staging.id, limit: 10 }).map((r) => r.id)).toEqual([b.id, a.id])
    expect(f.releases.list({ limit: 10, before: c.id }).map((r) => r.id)).toEqual([b.id, a.id])
    expect(f.releases.list({ limit: 1 })).toHaveLength(1)
    f.releases.setStatus(a.id, 'running')
    f.releases.setStatus(b.id, 'rolling_back')
    expect(f.releases.active().map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('latestPerEnvironment gives each environment its newest release that ran, with its first run\'s commits, in one query', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    const mk = (environmentId: string, status: 'ready' | 'running' | 'failed' | 'succeeded' | 'discarded') => {
      const r = f.releases.createRelease({
        environmentId, kind: 'release', status: 'ready', version: null, previousVersion: null,
        versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m', serviceIds: [],
      })
      if (status !== 'ready') f.releases.setStatus(r.id, status, { version: status === 'succeeded' ? 'v1.4.0' : undefined })
      return r
    }
    const plan = (releaseId: string, position: number) =>
      f.releases.createRuns(releaseId, [
        { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position, branch: 'main', steps: [], services: [], wholeCheckout: true },
      ])[0]
    mk(f.staging.id, 'failed')
    const ok = mk(f.staging.id, 'succeeded')
    f.releases.updateRun(plan(ok.id, 1).id, { previousCommit: 'bbbbbbb', deployedCommit: 'ccccccc' })
    f.releases.updateRun(plan(ok.id, 0).id, { previousCommit: 'aaaaaaa', deployedCommit: 'ddddddd' })
    // A preflight that never started, or one thrown away, is not the last release.
    mk(f.staging.id, 'ready')
    mk(f.staging.id, 'discarded')
    const failed = mk(f.prod.id, 'failed')

    const spy = vi.spyOn(f.db, 'prepare')
    const out = f.releases.latestPerEnvironment()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    const byEnv = new Map(out.map((r) => [r.environmentId, r]))
    expect(out).toHaveLength(2)
    expect(byEnv.get(f.staging.id)).toMatchObject({ id: ok.id, status: 'succeeded', version: 'v1.4.0', previousCommit: 'aaaaaaa', deployedCommit: 'ddddddd' })
    expect(byEnv.get(f.prod.id)).toMatchObject({ id: failed.id, status: 'failed', previousCommit: null, deployedCommit: null })
  })

  it('latestPerEnvironment looks each environment up in the release index rather than scanning every release', async () => {
    const f = await makeDeployFixture()
    const spy = vi.spyOn(f.db, 'prepare')
    f.releases.latestPerEnvironment()
    const sql = spy.mock.calls[0][0] as string
    spy.mockRestore()
    const plan = (f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail)
    expect(plan.some((d) => /SEARCH r2 USING INDEX releases_env/.test(d))).toBe(true)
    expect(plan.some((d) => /SCAN (releases|r2)\b/.test(d))).toBe(false)
  })

  it('failInterrupted marks running and rolling_back as failed', async () => {
    const { f, d, r } = await release()
    const mk = () =>
      f.releases.createRelease({
        environmentId: f.prod.id, kind: 'release', status: 'running', version: null, previousVersion: null,
        versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m', serviceIds: [],
      })
    const run = mk()
    const rb = mk()
    f.releases.setStatus(rb.id, 'rolling_back')
    const [dr] = f.releases.createRuns(run.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [], services: [], wholeCheckout: true },
    ])
    f.releases.updateRun(dr.id, { status: 'running' })
    const ids = f.releases.failInterrupted()
    expect(ids.sort()).toEqual([run.id, rb.id].sort())
    expect(f.releases.get(run.id)).toMatchObject({ status: 'failed', error: 'interrupted: OpsDeck quit during the run' })
    expect(f.releases.get(run.id).finishedAt).not.toBeNull()
    expect(f.releases.detail(run.id).runs[0].status).toBe('failed')
    expect(f.releases.get(r.id).status).toBe('ready')
    expect(f.releases.events(run.id, 0, 10).at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(f.releases.failInterrupted()).toEqual([])
  })

  it('updateRun and appendEvents can share one transaction', async () => {
    const { f, d, r } = await release()
    const [run] = f.releases.createRuns(r.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [], services: [], wholeCheckout: true },
    ])
    f.releases.transaction(() => {
      f.releases.updateRun(run.id, { status: 'running' })
      f.releases.appendEvents(r.id, [log('x')])
    })
    expect(f.releases.detail(r.id).runs[0].status).toBe('running')
    expect(() =>
      f.releases.transaction(() => {
        f.releases.updateRun(run.id, { status: 'failed' })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(f.releases.detail(r.id).runs[0].status).toBe('running')
  })

  it('failInterrupted also settles run steps', async () => {
    const { f, d } = await release()
    const rel = f.releases.createRelease({
      environmentId: f.prod.id, kind: 'release', status: 'running', version: null, previousVersion: null,
      versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m', serviceIds: [],
    })
    const [dr] = f.releases.createRuns(rel.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main',
        steps: [{ stepId: 'a', kind: 'record' }, { stepId: 'b', kind: 'fetch' }, { stepId: 'c', kind: 'unlock' }], services: [], wholeCheckout: true },
    ])
    f.releases.updateRun(dr.id, {
      status: 'running',
      steps: [
        { stepId: 'a', kind: 'record', state: 'ok', startedAt: 't0', finishedAt: 't1' },
        { stepId: 'b', kind: 'fetch', state: 'running', startedAt: 't1', finishedAt: null },
        { stepId: 'c', kind: 'unlock', state: 'pending', startedAt: null, finishedAt: null },
      ],
    })
    f.releases.failInterrupted()
    const steps = f.releases.detail(rel.id).runs[0].steps
    expect(steps[0]).toMatchObject({ state: 'ok', finishedAt: 't1' })
    expect(steps[1]).toMatchObject({ state: 'failed', startedAt: 't1' })
    expect(steps[1].finishedAt).not.toBeNull()
    expect(steps[2]).toMatchObject({ state: 'skipped', finishedAt: null })
  })

  it('failInterrupted fails a release stuck in preflight but leaves ready alone', async () => {
    const { f, r } = await release()
    const pre = f.releases.createRelease({
      environmentId: f.prod.id, kind: 'release', status: 'preflight', version: null, previousVersion: null,
      versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m', serviceIds: [],
    })
    expect(f.releases.failInterrupted()).toEqual([pre.id])
    expect(f.releases.get(pre.id)).toMatchObject({ status: 'failed', error: 'interrupted: OpsDeck quit during the run' })
    expect(f.releases.get(r.id).status).toBe('ready')
  })

  describe('per-service record', () => {
    const SA = 'a'.repeat(40)
    const SB = 'b'.repeat(40)
    const entry = (id: string, over: Partial<RunService> = {}): RunService => ({ id, name: id, composeService: id, previousCommit: null, previousReleaseId: null, deployedCommit: null, ...over })
    type F = Awaited<ReturnType<typeof release>>['f']
    type D = Awaited<ReturnType<typeof release>>['d']
    /** One release with one run listing `services`; started unless `started` is false. */
    const rel = (f: F, d: D, services: RunService[], o: { started?: boolean; runStatus?: 'succeeded' | 'failed' | 'rolled_back'; kind?: 'release' | 'rollback'; status?: 'succeeded' | 'rolled_back'; serviceIds?: string[] } = {}) => {
      const r = f.releases.createRelease({
        environmentId: f.staging.id, kind: o.kind ?? 'release', status: 'ready', version: null, previousVersion: null, versionBump: 'none',
        redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'ana@mbp', serviceIds: o.serviceIds ?? services.map((s) => s.id),
      })
      const [run] = f.releases.createRuns(r.id, [
        { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [], services, wholeCheckout: false },
      ])
      if (o.started !== false) f.releases.setStatus(r.id, o.status ?? 'succeeded', { startedAt: '2026-01-01T00:00:00.000Z' })
      if (o.runStatus) f.releases.updateRun(run.id, { status: o.runStatus })
      return { id: r.id, runId: run.id }
    }

    it('service_ids and runs.services round-trip; summary has serviceIds and serviceCount', async () => {
      const { f, d } = await release()
      const services = [entry('s1', { previousCommit: SA }), entry('s2')]
      const { id, runId } = rel(f, d, services)
      expect(f.releases.get(id)).toMatchObject({ serviceIds: ['s1', 's2'], serviceCount: 2 })
      expect(f.releases.list({ limit: 5 })[0]).toMatchObject({ serviceIds: ['s1', 's2'], serviceCount: 2 })
      expect(f.releases.detail(id).runs[0]).toMatchObject({ services, wholeCheckout: false })
      f.releases.setRunServices(runId, services.map((s) => ({ ...s, deployedCommit: SB })))
      expect(f.releases.detail(id).runs[0].services.map((s) => s.deployedCommit)).toEqual([SB, SB])
      expect(() => f.releases.setRunServices('nope', [])).toThrow('deployment run not found')
    })

    it('runs.services is shape-checked on read: bad JSON or malformed entries read as none', async () => {
      const { f, d } = await release()
      const good = entry('s1', { previousCommit: SA })
      const { id, runId } = rel(f, d, [good])
      const put = (v: string) => f.db.prepare('UPDATE deployment_runs SET services = ? WHERE id = ?').run(v, runId)
      put(JSON.stringify([good, { id: 5, name: 'x', composeService: 'x', previousCommit: null, previousReleaseId: null, deployedCommit: null }, { id: 's2', name: 's2' }, 'junk', null, { ...good, id: 's3', previousCommit: 7 }]))
      expect(f.releases.detail(id).runs[0].services).toEqual([good])
      put(JSON.stringify([{ ...good, extra: 'dropped' }]))
      expect(f.releases.detail(id).runs[0].services).toEqual([good])
      for (const bad of ['{"id":"s1"}', 'not json', '"s1"']) {
        put(bad)
        expect(f.releases.detail(id).runs[0].services).toEqual([])
      }
      // An entry stored before previousReleaseId reads it as null; a wrong type drops the entry.
      const { previousReleaseId: _, ...older } = good
      put(JSON.stringify([older, { ...good, id: 's4', previousReleaseId: 3 }]))
      expect(f.releases.detail(id).runs[0].services).toEqual([good])
    })

    it('serviceCount counts the run entries; service_ids is shape-checked on read', async () => {
      const { f, d } = await release()
      // A whole checkout picked by checkout: no explicit ids, two entries.
      const { id } = rel(f, d, [entry('s1'), entry('s2')], { serviceIds: [] })
      expect(f.releases.get(id)).toMatchObject({ serviceIds: [], serviceCount: 2 })
      expect(f.releases.list({ limit: 5 }).find((x) => x.id === id)).toMatchObject({ serviceCount: 2 })
      const put = (v: string) => f.db.prepare('UPDATE releases SET service_ids = ? WHERE id = ?').run(v, id)
      for (const [bad, ids] of [['not json', []], ['{"a":1}', []], ['"s1"', []], ['["s1", 2, null, {"id":"s3"}, "s2"]', ['s1', 's2']]] as const) {
        put(bad)
        expect(f.releases.get(id).serviceIds).toEqual(ids)
      }
      f.db.prepare('UPDATE deployment_runs SET services = ? WHERE release_id = ?').run('not json', id)
      expect(f.releases.get(id).serviceCount).toBe(0)
    })

    it('latestTouching counts only started releases that left the service deployed', async () => {
      const { f, d } = await release()
      const r1 = rel(f, d, [entry('s1'), entry('s2')], { runStatus: 'succeeded' })
      const r2 = rel(f, d, [entry('s2')], { kind: 'rollback', runStatus: 'rolled_back' })
      rel(f, d, [entry('s1'), entry('s2')], { runStatus: 'succeeded', started: false })
      rel(f, d, [entry('s1'), entry('s2')], { runStatus: 'failed' })
      rel(f, d, [entry('s1'), entry('s2')], { runStatus: 'succeeded', status: 'rolled_back' })
      rel(f, d, [entry('s1'), entry('s2')], { kind: 'rollback', runStatus: 'failed' })
      const m = f.releases.latestTouching(['s1', 's2', 's3'])
      expect(Object.fromEntries(m)).toEqual({ s1: r1.id, s2: r2.id })
      expect(f.releases.latestTouching([]).size).toBe(0)
      // A rollback of a release newer than the one given does not count; a rollback of it or an older one does.
      f.db.prepare('UPDATE releases SET rollback_of = ? WHERE id = ?').run(r2.id, r2.id)
      expect(Object.fromEntries(f.releases.latestTouching(['s1', 's2'], r1.id))).toEqual({ s1: r1.id, s2: r1.id })
      expect(Object.fromEntries(f.releases.latestTouching(['s1', 's2'], r2.id))).toEqual({ s1: r1.id, s2: r2.id })
    })

    it('previousTouching returns the earlier succeeded deploy of that service', async () => {
      const { f, d } = await release()
      const r1 = rel(f, d, [entry('s1', { deployedCommit: SA })], { runStatus: 'succeeded' })
      rel(f, d, [entry('s1', { deployedCommit: SB })], { runStatus: 'failed' })
      rel(f, d, [entry('s1', { deployedCommit: SB })], { runStatus: 'succeeded', started: false })
      const r4 = rel(f, d, [entry('s1', { deployedCommit: SB })], { runStatus: 'succeeded' })
      expect(f.releases.previousTouching('s1', r4.id)).toEqual({ releaseId: r1.id, commit: SA, rollbackOf: null })
      expect(f.releases.previousTouching('s1', r1.id)).toBeNull()
      expect(f.releases.previousTouching('s2', r4.id)).toBeNull()
    })

    it('previousTouching counts a rollback release whose run ended rolled_back and skips a rolled-back release', async () => {
      const { f, d } = await release()
      const r1 = rel(f, d, [entry('s1', { deployedCommit: SA })], { runStatus: 'succeeded' })
      // A rollback run that did not finish rolled_back does not count.
      rel(f, d, [entry('s1', { deployedCommit: SB })], { kind: 'rollback', runStatus: 'failed' })
      const rb = rel(f, d, [entry('s1', { deployedCommit: SB })], { kind: 'rollback', runStatus: 'rolled_back' })
      const gone = rel(f, d, [entry('s1', { deployedCommit: SA })], { runStatus: 'succeeded', status: 'rolled_back' })
      const r5 = rel(f, d, [entry('s1')], { runStatus: 'succeeded' })
      expect(f.releases.previousTouching('s1', r5.id)).toEqual({ releaseId: rb.id, commit: SB, rollbackOf: null })
      expect(f.releases.previousTouching('s1', gone.id)).toEqual({ releaseId: rb.id, commit: SB, rollbackOf: null })
      expect(f.releases.previousTouching('s1', rb.id)).toEqual({ releaseId: r1.id, commit: SA, rollbackOf: null })
    })

    it('previousRelease resolves a rollback to the release it restored, never naming a rollback', async () => {
      const { f, d } = await release()
      const r1 = rel(f, d, [entry('s1', { deployedCommit: SA })], { runStatus: 'succeeded' })
      const r2 = rel(f, d, [entry('s1', { deployedCommit: SB })], { runStatus: 'succeeded', status: 'rolled_back' })
      const rb2 = rel(f, d, [entry('s1', { deployedCommit: SA })], { kind: 'rollback', runStatus: 'rolled_back' })
      const r3 = rel(f, d, [entry('s1', { deployedCommit: SB })], { runStatus: 'succeeded', status: 'rolled_back' })
      const rb3 = rel(f, d, [entry('s1', { deployedCommit: SA })], { kind: 'rollback', runStatus: 'rolled_back' })
      const setOf = (id: string, of: string) => f.db.prepare('UPDATE releases SET rollback_of = ? WHERE id = ?').run(of, id)
      setOf(rb2.id, r2.id)
      setOf(rb3.id, r3.id)
      expect(f.releases.previousTouching('s1', r3.id)).toEqual({ releaseId: rb2.id, commit: SA, rollbackOf: r2.id })
      expect(f.releases.previousRelease('s1', r3.id)).toBe(r1.id)
      // Rollbacks all the way down: the one after rb3 resolves through rb3 and rb2 to r1.
      const r4 = rel(f, d, [entry('s1')], { runStatus: 'succeeded' })
      expect(f.releases.previousRelease('s1', r4.id)).toBe(r1.id)
      expect(f.releases.previousRelease('s1', r1.id)).toBeNull()
      expect(f.releases.previousRelease('s2', r4.id)).toBeNull()
    })

    it('previousRelease gives null on a rollback that claims to undo a newer release', { timeout: 2000 }, async () => {
      const { f, d } = await release()
      rel(f, d, [entry('s1', { deployedCommit: SA })], { runStatus: 'succeeded' })
      const rb = rel(f, d, [entry('s1', { deployedCommit: SA })], { kind: 'rollback', runStatus: 'rolled_back' })
      const r3 = rel(f, d, [entry('s1')], { runStatus: 'succeeded' })
      // Only a corrupt row (or a clock gone backwards) can do this; the app never writes it. rb is the newest deploy
      // before r3, so following its rollback_of finds rb again.
      f.db.prepare('UPDATE releases SET rollback_of = ? WHERE id = ?').run(r3.id, rb.id)
      expect(f.releases.previousRelease('s1', r3.id)).toBeNull()
    })
  })
})
