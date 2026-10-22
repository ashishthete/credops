import { describe, expect, it } from 'vitest'
import { etaMs, initialPipeline, originMoved, reducePipeline, type PipelineState } from '../../src/renderer/src/deploy/pipeline'
import { taskRows } from '../../src/renderer/src/deploy/task-rows'
import { ORIGIN_MOVED_MESSAGE } from '../../src/shared/deploy'
import { playbookSteps } from '../../src/shared/playbook-steps'
import { events, flowDetail, flowPlaybookOf, healthFailure, OK_RUN, releaseDetail } from './fixtures/release-events'

const chipsOf = (s: PipelineState, runId: string) => s.lanes.flatMap((l) => l.runs).find((r) => r.runId === runId)!.chips
const states = (s: PipelineState, runId: string) => Object.fromEntries(chipsOf(s, runId).map((c) => [c.kind, c.state]))

describe('pipeline reducer', () => {
  it('fixture ok run ends with every chip ok and result succeeded', () => {
    const start = initialPipeline(releaseDetail())
    expect(start.lanes.map((l) => [l.hostLabel, l.runs.map((r) => r.name)])).toEqual([
      ['app1', ['core', 'web']],
      ['app2', ['site']],
    ])
    expect(start.lanes.flatMap((l) => l.runs.flatMap((r) => r.chips)).every((c) => c.state === 'pending')).toBe(true)

    const s = reducePipeline(start, events(OK_RUN))
    const all = [...s.lanes.flatMap((l) => [l.lock!, ...l.runs.flatMap((r) => r.chips), l.unlock!]), ...s.release]
    expect(all.every((c) => c.state === 'ok')).toBe(true)
    expect(all.every((c) => c.durationMs === 1000)).toBe(true)
    expect(s.lanes.flatMap((l) => l.runs.map((r) => r.status))).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(s.lanes[0].runs[0].deployedCommit).toBe('b'.repeat(40))
    expect(s.result).toEqual({ status: 'succeeded' })
    expect(s.status).toBe('succeeded')
    expect(s.version).toEqual({ from: 'v1.4.0', to: 'v1.5.0' })
    expect(s.lastSeq).toBe(events(OK_RUN).length)
    expect(s.gap).toBe(false)
    // Pure: the input is untouched.
    expect(start.lanes.flatMap((l) => l.runs.flatMap((r) => r.chips)).every((c) => c.state === 'pending')).toBe(true)
  })

  it('lane rows name their services or whole checkout', () => {
    const s = initialPipeline(releaseDetail())
    const rows = s.lanes.flatMap((l) => l.runs.map((r) => ({ name: r.name, services: r.services, whole: r.wholeCheckout })))
    expect(rows).toEqual([
      { name: 'core', services: ['api', 'worker'], whole: false },
      { name: 'web', services: [], whole: true },
      { name: 'site', services: ['site'], whole: false },
    ])
  })

  it('health failure marks the chip failed and later chips stay pending', () => {
    const s = reducePipeline(initialPipeline(releaseDetail()), events(healthFailure(false)))
    const r3 = chipsOf(s, 'r3')
    expect(r3.find((c) => c.kind === 'health')).toMatchObject({ state: 'failed', error: 'health check failed on app2', durationMs: 5000 })
    expect(states(s, 'r3')).toMatchObject({ up: 'ok', health: 'failed', tag: 'pending' })
    expect(states(s, 'r2')).toEqual(Object.fromEntries(chipsOf(s, 'r2').map((c) => [c.kind, 'pending'])))
    expect(s.result).toEqual({ status: 'failed', error: 'health check failed on app2' })
    expect(s.rollback.active).toBe(false)
  })

  it('auto-rollback marks earlier chips rolled_back', () => {
    const s = reducePipeline(initialPipeline(releaseDetail()), events(healthFailure(true)))
    expect(states(s, 'r1')).toMatchObject({ record: 'rolled_back', build: 'rolled_back', tag: 'rolled_back', rb_checkout: 'ok', rb_up: 'ok' })
    expect(s.rollback).toEqual({ active: false, runIds: ['r1'], ok: true })
    expect(s.lanes[0].runs[0].status).toBe('rolled_back')
    expect(s.status).toBe('rolled_back')
    // The failed run is not rolled back.
    expect(states(s, 'r3').health).toBe('failed')
  })

  it('lock.busy is surfaced with holder text', () => {
    const holder = { releaseId: 'other', user: 'ana', machine: 'mbp', environment: 'staging', version: 'v1.5.0', startedAt: '10:42' }
    const s = reducePipeline(initialPipeline(releaseDetail()), events([{ type: 'lock.busy', hostId: 'h1', holder, stale: false, text: 'ana@mbp is deploying v1.5.0 since 10:42' }]))
    expect(s.lockBusy).toEqual([{ hostId: 'h1', text: 'ana@mbp is deploying v1.5.0 since 10:42', stale: false }])
  })

  it('replay equals live, including after a seq gap refetch', () => {
    const all = events(healthFailure(true))
    const start = initialPipeline(releaseDetail())
    const batch = reducePipeline(start, all)
    const single = all.reduce((s, e) => reducePipeline(s, [e]), start)
    expect(single).toEqual(batch)

    // Live: the first part arrives, a batch is missed, the next one shows the gap; the refetch fills it in.
    const cut = 10
    let live = reducePipeline(start, all.slice(0, cut))
    live = reducePipeline(live, all.slice(cut + 5, cut + 8))
    expect(live.gap).toBe(true)
    expect(live.lastSeq).toBe(cut)
    live = reducePipeline(live, all.filter((e) => e.seq > live.lastSeq))
    // A late duplicate changes nothing.
    live = reducePipeline(live, all.slice(cut + 5, cut + 8))
    expect(live).toEqual(batch)
  })

  it('etaMs uses the median of history', () => {
    const detail = releaseDetail({ runs: [releaseDetail().runs[2]] })
    const start = initialPipeline(detail)
    // One lane: lock, seven run steps, unlock, then the version step.
    const history = { build: [10_000, 30_000, 20_000], up: [4_000, 6_000], lock: [1_000] }
    expect(etaMs(start, history, 0)).toBe(1_000 + 20_000 + 5_000)
    // A running build has used 15 s of its 20 s median.
    const t0 = Date.parse(events([{ type: 'run.started', kind: 'release', version: null }])[0].at)
    const s = reducePipeline(start, events([
      { type: 'run.started', kind: 'release', version: null },
      { type: 'step.started', stepId: 'host:h2:lock', kind: 'lock', name: 'lock', hostId: 'h2', deploymentRunId: null },
      { type: 'step.done', stepId: 'host:h2:lock', state: 'ok', durationMs: 900 },
      { type: 'step.started', stepId: 'r3:build', kind: 'build', name: 'build', hostId: 'h2', deploymentRunId: 'r3' },
    ]))
    const buildStart = t0 + 3_000
    expect(etaMs(s, history, buildStart + 15_000)).toBe(5_000 + 5_000)
    expect(etaMs(s, {}, 0)).toBeNull()
  })

  it('a run.started after a finished run (retry tagging) clears the result and starts the version tag over', () => {
    const upTo = OK_RUN.findIndex((e) => e.type === 'step.started' && e.stepId === 'release:version')
    const first = events([
      ...OK_RUN.slice(0, upTo),
      { type: 'step.started', stepId: 'release:version', kind: 'version', name: 'version', hostId: null, deploymentRunId: null },
      { type: 'step.failed', stepId: 'release:version', error: 'push rejected', durationMs: 1000 },
      { type: 'run.finished', status: 'failed' },
    ])
    const done = reducePipeline(initialPipeline(releaseDetail()), first)
    expect(done.result).toEqual({ status: 'failed' })
    const again = reducePipeline(done, events([{ type: 'run.started', kind: 'release', version: 'v1.5.0' }], first.length + 1))
    expect(again.status).toBe('running')
    expect(again.result).toBeNull()
    expect(again.release.find((c) => c.stepId === 'release:version')).toMatchObject({ state: 'pending', error: null, durationMs: null, startedAt: null })
    // The steps of the first run keep what they did
    expect(again.lanes[0]!.runs[0]!.chips.every((c) => c.state === 'ok')).toBe(true)
  })
})

describe('a release flow', () => {
  // stage 0 runs r1's up on app1 and r3's up and health on app2 in one play; stage 1 is r1's migrate; stage 2 the rest
  const STAGES: Record<string, string[]>[] = [{ r1: ['up'], r3: ['up', 'health'] }, { r1: ['c_21'] }, { r1: ['health'], r2: ['up', 'health'] }]

  it('a two-host stage play gives one lane per host, each with its own blocks gathered across the plays in order', () => {
    const detail = flowDetail()
    const plays = playbookSteps(flowPlaybookOf(detail, STAGES))
    expect(plays.map((p) => [p.name, p.hosts])).toEqual([
      ['release prepare', ['od-1', 'od-2']],
      ['release stage 0', ['od-1', 'od-2']],
      ['release stage 1', ['od-1']],
      ['release stage 2', ['od-1']],
      ['release tag', ['od-1', 'od-2']],
    ])
    const { hosts } = taskRows(initialPipeline(detail), plays)
    expect(hosts.map((h) => h.hostLabel)).toEqual(['app1', 'app2'])
    const [app1, app2] = hosts
    // each lane's lock only, never the other host's, and no gate or marker
    expect(app1.before.map((r) => r.name)).toEqual(['lock od-1'])
    expect(app2.before.map((r) => r.name)).toEqual(['lock od-2'])
    const names = (h: (typeof hosts)[number]) => Object.fromEntries(h.runs.map((r) => [r.runId, r.rows.map((x) => x.name)]))
    expect(names(app1)).toEqual({
      r1: ['record core', 'fetch core', 'checkout core', 'build core', 'up core', 'c_21 core', 'health core', 'tag core'],
      r2: ['record web', 'fetch web', 'checkout web', 'build web', 'up web', 'health web', 'tag web'],
    })
    expect(names(app2)).toEqual({ r3: ['record site', 'fetch site', 'checkout site', 'build site', 'up site', 'health site', 'tag site'] })
    expect(app1.runs[0].rows.find((r) => r.name === 'c_21 core')?.label).toBe('migrate')
    expect(app1.runs.map((r) => r.title)).toEqual(['core', 'web'])
  })

  it('a custom step that warns keeps its label and carries the message', () => {
    const s = reducePipeline(
      initialPipeline(flowDetail()),
      events([
        { type: 'step.started', stepId: 'r1:c_21', kind: 'custom', name: 'migrate', hostId: 'h1', deploymentRunId: 'r1' },
        { type: 'step.done', stepId: 'r1:c_21', state: 'warn', durationMs: 10, message: 'migration took long' },
      ]),
    )
    const c = s.lanes[0].runs[0].chips.find((x) => x.stepId === 'r1:c_21')!
    expect(c).toMatchObject({ label: 'migrate', state: 'warn', error: 'migration took long' })
  })

  it('originMoved: a step that failed because origin moved since the preview', () => {
    const base = initialPipeline(releaseDetail())
    const failed = (error: string) =>
      reducePipeline(base, events([
        { type: 'step.started', stepId: 'r1:fetch', kind: 'fetch', name: 'fetch', hostId: 'h1', deploymentRunId: 'r1' },
        { type: 'step.failed', stepId: 'r1:fetch', error, durationMs: 5 },
      ]))
    expect(originMoved(base)).toBe(false)
    expect(originMoved(failed('could not reach origin'))).toBe(false)
    expect(originMoved(failed(`fetch failed: ${ORIGIN_MOVED_MESSAGE}\nlast lines`))).toBe(true)
  })
})
