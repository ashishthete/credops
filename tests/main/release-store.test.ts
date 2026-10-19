import { describe, expect, it } from 'vitest'
import { uuidv7Time } from '../../src/main/deploy/uuidv7'
import { DEFAULT_RELEASE_OPTIONS, type RunEventBody } from '../../src/shared/deploy'
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
    f.releases.appendEvents(r.id, [{ type: 'run.finished', status: 'failed' }])
    const all = f.releases.events(r.id, 0, 100)
    expect(all.filter((e) => e.type === 'log')).toHaveLength(5)
    expect(all.filter((e) => e.type === 'log.truncated')).toHaveLength(1)
    expect(all.at(-1)).toMatchObject({ type: 'run.finished' })
    expect(out.some((e) => e.type === 'log.truncated')).toBe(true)
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1))
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
      },
    ])
    expect(run).toMatchObject({ status: 'pending', rolledBack: false, previousCommit: null, commits: [] })
    expect(run.steps).toEqual([
      { stepId: 'X:record', kind: 'record', state: 'pending', startedAt: null, finishedAt: null },
      { stepId: 'X:fetch', kind: 'fetch', state: 'pending', startedAt: null, finishedAt: null },
    ])
    expect(f.releases.get(r.id)).toMatchObject({ deploymentCount: 1, hostCount: 1 })
  })

  it('detail joins runs with parsed steps and commits', async () => {
    const { f, d, r } = await release()
    const [run] = f.releases.createRuns(r.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [{ stepId: 's1', kind: 'record' }] },
    ])
    const commits = [{ sha: 'abc', subject: 's', author: 'a', date: 'd', deploymentId: d.id }]
    const steps = [{ stepId: 's1', kind: 'record' as const, state: 'ok' as const, startedAt: 't0', finishedAt: 't1' }]
    f.releases.updateRun(run.id, { status: 'running', previousCommit: 'p1', deployedCommit: 'd1', commits, steps, backupFile: '/b/x.sql', startedAt: 't0' })
    f.releases.updateRun(run.id, { rolledBack: true })
    const report = { releaseId: r.id, checks: [], commits: {}, dockerModes: {}, locks: {}, commitsTotal: 0, blocked: false }
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
        versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m',
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

  it('failInterrupted marks running and rolling_back as failed', async () => {
    const { f, d, r } = await release()
    const mk = () =>
      f.releases.createRelease({
        environmentId: f.prod.id, kind: 'release', status: 'running', version: null, previousVersion: null,
        versionBump: 'none', redeploy: false, rollbackOf: null, options: DEFAULT_RELEASE_OPTIONS, triggeredBy: 'u@m',
      })
    const run = mk()
    const rb = mk()
    f.releases.setStatus(rb.id, 'rolling_back')
    const [dr] = f.releases.createRuns(run.id, [
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [] },
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
      { deploymentId: d.id, deploymentName: 'api', hostId: d.hostId, hostLabel: 'app1', position: 0, branch: 'main', steps: [] },
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
})
