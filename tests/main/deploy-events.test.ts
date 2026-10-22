import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CALLBACK_PLUGIN_SOURCE } from '../../src/main/deploy/callback-plugin'
import { EventTranslator, parseDeps, parsePreflight, parseStreamLine } from '../../src/main/deploy/events'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { MARK, parseMarker, parsePfLine, parsePrev } from '../../src/main/deploy/markers'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { MAX_LOG_LINE, type RunEventBody } from '../../src/shared/deploy'
import { FIX, planFixture, stepFixture } from './deploy-helpers'

const FIXTURES = join(__dirname, 'fixtures/ansible')
const NOW = Date.parse('2026-10-19T10:00:00.000Z')
const R1 = '0190a1b2-c3d4-7e5f-8a6b-000000000001'
const R2 = '0190a1b2-c3d4-7e5f-8a6b-000000000002'
const R3 = '0190a1b2-c3d4-7e5f-8a6b-000000000003'

function clock(): { t: number; now: () => number } {
  const c = { t: NOW, now: () => c.t }
  return c
}

/** Feeds each fixture line, advancing the clock 500 ms per line so durations are exact. */
function replay(file: string, plan: DeployPlan = planFixture(), secrets: string[] = []) {
  const c = clock()
  const tr = new EventTranslator({ plan, secrets: () => secrets, now: c.now })
  const events: RunEventBody[] = []
  for (const line of readFileSync(join(FIXTURES, file), 'utf8').split('\n')) {
    c.t += 500
    events.push(...tr.feed(line))
  }
  return { tr, events, c }
}
const of = <T extends RunEventBody['type']>(events: RunEventBody[], type: T): Extract<RunEventBody, { type: T }>[] =>
  events.filter((e): e is Extract<RunEventBody, { type: T }> => e.type === type)

describe('EventTranslator', () => {
  it('ok run yields started/done per step with durations and deployment.updated commits', () => {
    const { events } = replay('release-ok.jsonl')
    const started = of(events, 'step.started').map((e) => e.stepId)
    expect(started).toEqual([
      `host:host-od-1:lock`,
      `${R2}:record`, `${R2}:fetch`, `${R2}:checkout`, `${R2}:build`, `${R2}:up`, `${R2}:health`, `${R2}:tag`,
      `host:host-od-1:unlock`,
    ])
    const done = of(events, 'step.done')
    expect(done.map((e) => e.stepId)).toEqual(started)
    expect(done.every((e) => e.state === 'ok' && e.durationMs === 500)).toBe(true)
    expect(of(events, 'step.started')[1]).toMatchObject({ kind: 'record', name: 'Record dep2', hostId: 'host-od-1', deploymentRunId: R2 })
    expect(of(events, 'step.started')[0]).toMatchObject({ kind: 'lock', name: 'Lock label od-1', hostId: 'host-od-1', deploymentRunId: null })
    const upd = of(events, 'deployment.updated')
    expect(upd).toContainEqual({ type: 'deployment.updated', deploymentRunId: R2, status: 'running', previousCommit: 'b'.repeat(40) })
    expect(upd).toContainEqual({ type: 'deployment.updated', deploymentRunId: R2, status: 'running', deployedCommit: 'd'.repeat(40) })
    expect(upd.at(-1)).toEqual({ type: 'deployment.updated', deploymentRunId: R2, status: 'succeeded' })
    // the health marker is a log line; lock and prev/head markers are consumed
    const logs = of(events, 'log').map((l) => l.line)
    expect(logs).toContain('OD-HEALTH ok 200')
    expect(logs.some((l) => l.startsWith('OD-PREV') || l.startsWith('OD-LOCK ') || l.startsWith('OD-HEAD'))).toBe(false)
    expect(logs).toContain('OD-UNLOCK released /srv/apps/alpha2')
  })

  it('health failure yields step.failed with the last log lines and a redacted error', () => {
    const { events, tr } = replay('release-health-fail.jsonl', planFixture(), ['hunter2-secret'])
    const failed = of(events, 'step.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].stepId).toBe(`${R2}:health`)
    expect(failed[0].durationMs).toBe(500)
    expect(failed[0].error).toContain('Health dep2 failed with exit code 1')
    expect(failed[0].error).toContain('OD-HEALTH timeout last=503')
    expect(failed[0].error).not.toContain('hunter2-secret')
    expect(JSON.stringify(events)).not.toContain('hunter2-secret')
    expect(of(events, 'deployment.updated').at(-1)).toMatchObject({ deploymentRunId: R2, status: 'failed' })
    // the untagged rescue bookkeeping is not a step
    expect(of(events, 'step.started').map((s) => s.kind)).not.toContain('fail')
    expect(tr.finish(2, null)).toEqual([])
  })

  it('no_log results never produce log lines', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const tags = ['od_step=env', `od_run=${R1}`]
    const out = [
      ...tr.feed(JSON.stringify({ event: 'task_start', name: 'env dep1', tags })),
      ...tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'env dep1', tags, no_log: true, rc: 1, stdout: 'API_KEY=abc123xyz', stderr: 'abc123xyz', msg: 'abc123xyz' })),
    ]
    expect(of(out, 'log')).toEqual([])
    const f = of(out, 'step.failed')[0]
    expect(f.error).toBe('Write .env dep1 failed (output hidden)')
    expect(JSON.stringify(out)).not.toContain('abc123xyz')
  })

  it('a line echoing a run secret is redacted', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['s3cr3t-value'], now: clock().now })
    const tags = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'build dep1', tags, rc: 2, stdout: 'login s3cr3t-value ok', stderr: 'bad s3cr3t-value', msg: 'non-zero return code' }))
    const text = JSON.stringify(out)
    expect(text).not.toContain('s3cr3t-value')
    expect(of(out, 'log').map((l) => l.line)).toEqual(['login ‹redacted› ok', 'bad ‹redacted›'])
    expect(of(out, 'log').map((l) => l.stream)).toEqual(['out', 'err'])
    // non-JSON and unreachable text too
    expect(JSON.stringify(tr.feed('boom s3cr3t-value'))).not.toContain('s3cr3t-value')
    const un = tr.feed(JSON.stringify({ event: 'unreachable', host: 'od-1', task: 'x', tags, msg: 'dial s3cr3t-value' }))
    expect(JSON.stringify(un)).not.toContain('s3cr3t-value')
  })

  it('cuts long log lines at MAX_LOG_LINE after redacting', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['longsecret-9999'], now: clock().now })
    const tags = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'build dep1', tags, rc: 0, stdout: `${'x'.repeat(MAX_LOG_LINE - 5)}longsecret-9999${'y'.repeat(100)}` }))
    const line = of(out, 'log')[0].line
    expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE)
    expect(line).not.toContain('longsecret')
  })

  it('lock-busy yields lock.busy with holder text and stale flag', () => {
    const { events } = replay('lock-busy.jsonl')
    const busy = of(events, 'lock.busy')
    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ hostId: 'host-od-1', stale: true })
    expect(busy[0].holder).toMatchObject({ user: 'bob', machine: 'srv9', releaseId: '0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa' })
    expect(busy[0].text).toBe('bob@srv9 is deploying v1.2.3 since 2026-10-19T07:00:00.000Z')
    const f = of(events, 'step.failed')[0]
    expect(f.stepId).toBe('host:host-od-1:lock')
    expect(f.error).toBe('label od-1 is locked: bob@srv9 is deploying v1.2.3 since 2026-10-19T07:00:00.000Z')
  })

  it('a fresh holder is not stale', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: () => NOW })
    const tags = ['od_step=lock', 'od_run=host:host-od-1']
    tr.feed(JSON.stringify({ event: 'task_start', name: 'lock od-1', tags }))
    const holder = JSON.stringify({ releaseId: 'r', user: 'u', machine: 'm', environment: 'e', version: null, startedAt: '2026-10-19T09:30:00.000Z' })
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'lock od-1', tags, rc: 42, stdout: `OD-LOCK ${holder}` }))
    expect(of(out, 'lock.busy')[0]).toMatchObject({ stale: false, text: 'u@m is deploying release since 2026-10-19T09:30:00.000Z' })
  })

  it('lock exit 2 and break-lock exit 43 are plain failures', () => {
    const tr = new EventTranslator({ plan: planFixture({ kind: 'break-lock' }), secrets: () => [], now: () => NOW })
    const t1 = ['od_step=lock', 'od_run=host:host-od-1']
    tr.feed(JSON.stringify({ event: 'task_start', name: 'lock od-1', tags: t1 }))
    const a = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'lock od-1', tags: t1, rc: 2, stdout: 'OD-LOCK-ERROR cannot create the lock in /srv/apps/alpha1' }))
    expect(of(a, 'lock.busy')).toEqual([])
    expect(of(a, 'step.failed')[0].error).toContain('OD-LOCK-ERROR cannot create the lock in /srv/apps/alpha1')
    const t2 = ['od_step=unlock', 'od_run=host:host-od-1']
    tr.feed(JSON.stringify({ event: 'task_start', name: 'unlock od-1', tags: t2 }))
    const b = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'unlock od-1', tags: t2, rc: 43, stdout: 'OD-UNLOCK kept /srv/apps/alpha1' }))
    expect(of(b, 'step.failed')[0].error).toContain('lock changed since the check')
  })

  it('skipped tasks give step.done skipped; a failed tag step gives warn', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const sk = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags: sk }))
    expect(of(tr.feed(JSON.stringify({ event: 'skipped', host: 'od-1', task: 'build dep1', tags: sk })), 'step.done')[0]).toMatchObject({ state: 'skipped' })
    const tg = ['od_step=tag', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'tag dep1', tags: tg }))
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'tag dep1', tags: tg, rc: 1, stderr: 'remote: denied' }))
    expect(of(out, 'step.done')[0]).toMatchObject({ stepId: `${R1}:tag`, state: 'warn' })
    expect(of(out, 'step.done')[0].message).toContain('remote: denied')
    expect(of(out, 'step.failed')).toEqual([])
  })

  it('an unreachable result is step.failed with the host label', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['pw-12345'], now: clock().now })
    const tags = ['od_step=fetch', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'fetch dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'unreachable', host: 'od-1', task: 'fetch dep1', tags, msg: 'ssh: connect to host 10.0.0.1 port 22: Connection refused pw-12345' }))
    expect(of(out, 'step.failed')[0].error).toBe('label od-1 is unreachable: ssh: connect to host 10.0.0.1 port 22: Connection refused ‹redacted›')
  })

  it('a preflight task that is unreachable is a blocking reachable check', () => {
    const tr = new EventTranslator({ plan: planFixture({ kind: 'preflight' }), secrets: () => [], now: clock().now })
    const tags = ['od_step=preflight', `od_run=${R1}`]
    const out = tr.feed(JSON.stringify({ event: 'unreachable', host: 'od-1', task: 'preflight tools dep1', tags, msg: 'timed out' }))
    expect(of(out, 'preflight.check')[0].check).toMatchObject({ id: 'reachable', level: 'block', hostId: 'host-od-1', message: 'label od-1 is unreachable: timed out' })
  })

  it('surfaces a rescued rollback failure to the consumer', () => {
    const plan = planFixture({ kind: 'rollback' })
    const c = clock()
    const tr = new EventTranslator({ plan, secrets: () => [], now: c.now })
    const tags = ['od_step=rb_up', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'rb_up dep1', tags }))
    const failed = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'rb_up dep1', tags, rc: 1, stderr: 'compose exploded' }))
    expect(of(failed, 'step.failed')[0].stepId).toBe(`${R1}:rb_up`)
    expect(of(failed, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R1, status: 'rollback_failed' }])
    const rescued = tr.feed(JSON.stringify({ event: 'rescued', host: 'od-1', count: 1 }))
    expect(of(rescued, 'log')[0]).toMatchObject({ stream: 'ansible', line: 'label od-1: 1 failed step was rescued' })
    expect(tr.rescued()).toEqual({ 'host-od-1': 1 })
  })

  it('a successful rollback ends rolled_back', () => {
    const tr = new EventTranslator({ plan: planFixture({ kind: 'rollback' }), secrets: () => [], now: clock().now })
    const tags = ['od_step=rb_tag', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'rb_tag dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'rb_tag dep1', tags, rc: 0 }))
    expect(of(out, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R1, status: 'rolled_back' }])
  })

  it('OD-PREV unknown is neither a commit nor a first deploy', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const tags = ['od_step=record', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'record dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'record dep1', tags, rc: 0, stdout: 'OD-PREV unknown' }))
    expect(of(out, 'deployment.updated')).toEqual([])
    expect(of(out, 'step.done')[0]).toMatchObject({ state: 'warn', message: 'The previous commit could not be read from origin' })
    expect(tr.previousUnknown()).toEqual([R1])
    // none: first deploy, no commit
    const n = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    n.feed(JSON.stringify({ event: 'task_start', name: 'record dep1', tags }))
    const o2 = n.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'record dep1', tags, rc: 0, stdout: 'OD-PREV none' }))
    expect(of(o2, 'deployment.updated')).toEqual([])
    expect(of(o2, 'step.done')[0].state).toBe('ok')
    expect(n.previousUnknown()).toEqual([])
  })

  it('OD-BACKUP carries the final file path and OD-ENV lines are logs', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const tags = ['od_step=backup', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'backup dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'backup dep1', tags, rc: 0, stdout: `OD-BACKUP /var/backups/app/alpha-${R1}.dump` }))
    expect(of(out, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R1, status: 'running', backupFile: `/var/backups/app/alpha-${R1}.dump` }])
    const e = ['od_step=rb_env', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'rb_env dep1', tags: e }))
    const o2 = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'rb_env dep1', tags: e, rc: 0, stdout: 'OD-ENV skipped: .env was not written by this release' }))
    expect(of(o2, 'log').map((l) => l.line)).toEqual(['OD-ENV skipped: .env was not written by this release'])
  })

  it("the tail of a failed streamed step is error context, not duplicate log lines", () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const tags = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'build dep1', tags, rc: 1, stdout: `${R1}:build\tstep 3 failed\n${R1}:build\tno space left`, msg: 'non-zero return code' }))
    expect(of(out, 'log')).toEqual([])
    const err = of(out, 'step.failed')[0].error
    expect(err).toContain('no space left')
    expect(err).not.toContain(`${R1}:build`)
  })

  it('a non-JSON line is an ansible log line; warnings too', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    expect(tr.feed('ERROR! Syntax Error while loading YAML.')).toEqual([{ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: 'ERROR! Syntax Error while loading YAML.' }])
    expect(tr.feed('')).toEqual([])
    expect(of(tr.feed(JSON.stringify({ event: 'warning', msg: 'Platform linux on host od-1 is using the discovered Python interpreter' })), 'log')[0].stream).toBe('ansible')
    expect(tr.feed(JSON.stringify({ event: 'stats', hosts: {} }))).toEqual([])
  })

  it('finish closes steps that never ended', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags: ['od_step=build', `od_run=${R1}`] }))
    const out = tr.finish(null, 'SIGTERM')
    expect(of(out, 'step.failed')[0]).toMatchObject({ stepId: `${R1}:build`, error: 'Ansible was stopped (SIGTERM) before this step finished' })
    expect(of(out, 'deployment.updated')[0]).toMatchObject({ status: 'failed' })
    const none = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    expect(of(none.finish(4, null), 'log')[0].line).toBe('ansible-playbook exited with code 4')
    expect(none.finish(0, null)).toEqual([])
  })

  it('several health URLs make one health step', () => {
    const plan = planFixture()
    plan.deployments[0].urls = [{ url: 'http://a/', from: 'host' }, { url: 'http://b/', from: 'host' }]
    const tr = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    const tags = ['od_step=health', `od_run=${R1}`]
    const out: RunEventBody[] = []
    for (const n of [0, 1]) {
      out.push(...tr.feed(JSON.stringify({ event: 'task_start', name: `health dep1 ${n}`, tags })))
      out.push(...tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: `health dep1 ${n}`, tags, rc: 0 })))
    }
    expect(of(out, 'step.started')).toHaveLength(1)
    expect(of(out, 'step.done')).toHaveLength(1)
  })
})

describe('preflight parsing', () => {
  const plan = planFixture({ kind: 'preflight' })
  const parsed = () => {
    const { tr } = replay('preflight.jsonl', plan)
    return parsePreflight(plan, tr.preflightOutput(), { now: NOW + 60_000, cut: tr.preflightCut() })
  }
  const msg = (r: ReturnType<typeof parsed>, id: string, dep: string | null) => r.checks.filter((c) => c.id === id && (dep === null || c.deploymentId === dep)).map((c) => `${c.level}: ${c.message}`)

  it('builds checks, commits (reverts filtered), docker modes and blocked', () => {
    const r = parsed()
    expect(r.blocked).toBe(true)
    expect(r.dockerModes).toEqual({ 'dep-1': 'sudo-password', 'dep-2': 'sudo' })
    // newest first; the revert and its original are hidden
    expect(r.commits['dep-1'].commits.map((c) => c.sha[0])).toEqual(['1', '4'])
    expect(r.commits['dep-1'].commits[0]).toEqual({ sha: '1'.repeat(40), subject: 'Add search', author: 'ana', date: '2026-10-18T09:00:00+00:00', deploymentId: 'dep-1' })
    expect(r.commits['dep-1']).toMatchObject({ hiddenPairs: 1, truncated: 0, firstDeploy: false, head: '1'.repeat(40) })
    expect(r.commits['dep-3']).toMatchObject({ firstDeploy: true, hiddenPairs: 0, tagCommit: null })
    expect(r.commits['dep-3'].commits).toHaveLength(2)
    expect(r.commitsTotal).toBe(4)
    expect(msg(r, 'docker', 'dep-3')).toEqual(['block: docker needs sudo on label od-2 and no sudo password is set'])
    expect(msg(r, 'clean', 'dep-3')).toEqual(['block: /srv/apps/alpha3 has uncommitted changes (3 files)'])
    expect(msg(r, 'branch', 'dep-3')).toEqual([`block: branch ${FIX.branch} not found on origin`])
    expect(msg(r, 'disk', 'dep-3')).toEqual(['warn: only 1.2 GB free on label od-2 (warning below 2 GB)'])
    expect(msg(r, 'version-tag', null)).toEqual(['block: Tag v1.2.3 already exists in dep1'])
    expect(msg(r, 'tools', 'dep-3')).toEqual(['block: missing tools on label od-2: pg_dump'])
    expect(msg(r, 'tools', 'dep-1')[0]).toMatch(/^ok:/)
    expect(msg(r, 'tag', 'dep-1')).toEqual([`ok: last deployed commit ${'a'.repeat(7)}`])
  })

  it('a missing repo is a clear block and the checks inside it are not reported clean', () => {
    const r = parsed()
    expect(msg(r, 'repo', 'dep-2')).toEqual(['block: /srv/apps/alpha2 does not exist on label od-1'])
    for (const id of ['clean', 'branch', 'compose', 'disk', 'tag', 'commits']) expect(msg(r, id, 'dep-2')).toEqual([])
    expect(r.commits['dep-2']).toBeUndefined()
    expect(r.checks.filter((c) => c.deploymentId === 'dep-2' && c.level === 'ok').map((c) => c.id)).toEqual(['tools', 'docker'])
  })

  it('reports the lock holder with a stale flag per host', () => {
    const r = parsed()
    expect(r.locks['host-od-2']).toBeNull()
    const l = r.locks['host-od-1']!
    expect(l.stale).toBe(true)
    expect(l.holder).toMatchObject({ user: 'bob', machine: 'srv9' })
    expect(JSON.parse(l.raw)).toMatchObject({ user: 'bob' })
    expect(msg(r, 'lock', null).filter((m) => m.startsWith('block'))).toHaveLength(1)
    expect(msg(r, 'lock', null).find((m) => m.startsWith('block'))).toContain('bob@srv9 is deploying v1.2.3')
  })

  it('a preflight task that failed outright names its error instead of "no result"', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const tr = new EventTranslator({ plan: p, secrets: () => ['hunter2'], now: clock().now })
    const fail = (task: string, run: string, extra: Record<string, unknown>) => {
      const tags = ['od_step=preflight', `od_run=${run}`]
      tr.feed(JSON.stringify({ event: 'task_start', name: task, tags }))
      return tr.feed(JSON.stringify({ event: 'failed', host: 'od-2', task, tags, ...extra }))
    }
    const logged = [
      ...fail('preflight tools dep3', R3, { msg: 'MODULE FAILURE\nSee stdout/stderr for the exact error', stderr: '/bin/sh: 1: /usr/bin/python3: not found\n' }),
      ...fail('preflight docker dep3', R3, { msg: 'The shell action failed to execute in the expected time frame (30) and was terminated' }),
      ...fail('preflight lock od-2', 'host:host-od-2', { msg: 'Incorrect sudo password hunter2' }),
      ...fail('preflight repo dep3', R3, { msg: 'secret', no_log: true }),
    ]
    const r = parsePreflight(p, tr.preflightOutput(), { now: NOW, errors: tr.preflightErrors(), secrets: ['hunter2'] })
    const m = (id: string) => r.checks.filter((c) => c.id === id).map((c) => `${c.level}: ${c.message}`)
    expect(m('tools')).toEqual(['block: The tools check failed on label od-2: MODULE FAILURE: /bin/sh: 1: /usr/bin/python3: not found'])
    expect(m('docker')).toEqual(['block: The docker check failed on label od-2: The shell action failed to execute in the expected time frame (30) and was terminated'])
    expect(m('lock')).toEqual(['block: The lock check failed on label od-2: Incorrect sudo password ‹redacted›'])
    // a no_log failure keeps its text hidden: still "no result"
    expect(m('repo')).toEqual(['block: The repository check gave no result on label od-2'])
    // the failures reach the run log too, redacted, so the reason is visible there as well
    const lines = logged.filter((b) => b.type === 'log').map((b) => (b as { line: string }).line)
    expect(lines).toContain('label od-2: preflight tools dep3 failed: MODULE FAILURE: /bin/sh: 1: /usr/bin/python3: not found')
    expect(lines.join('\n')).not.toContain('hunter2')
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('zero commits gives commitsTotal 0 and firstDeploy false', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const out = {
      [R3]: ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', `tag exists=1 commit=${'c'.repeat(40)}`, 'version-tag exists=0', 'commits log_b64='].map((l) => `OD-PF ${l}`).join('\n'),
      'host:host-od-2': 'OD-PF lock repo=/srv/apps/alpha3 held=0 raw_b64=',
    }
    const r = parsePreflight(p, out, { now: NOW })
    expect(r.commitsTotal).toBe(0)
    expect(r.commits['dep-3']).toMatchObject({ commits: [], firstDeploy: false, truncated: 0, head: null, tagCommit: 'c'.repeat(40) })
    expect(r.blocked).toBe(false)
  })

  it('unknown tag or commits is a block and never a first deploy', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const out = {
      [R3]: ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', 'tag exists=unknown commit=', 'version-tag exists=0', 'commits unknown'].map((l) => `OD-PF ${l}`).join('\n'),
      'host:host-od-2': 'OD-PF lock repo=/srv/apps/alpha3 held=0 raw_b64=',
    }
    const r = parsePreflight(p, out, { now: NOW })
    expect(r.commits['dep-3'].firstDeploy).toBe(false)
    expect(r.checks.filter((c) => c.level === 'block').map((c) => c.id).sort()).toEqual(['commits', 'tag'])
    expect(r.blocked).toBe(true)
  })

  it('a 64 KiB cut of the commits line keeps only whole records and says so', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const rec = (i: number) => `${String(i).padStart(2, '0').repeat(20)}\x1fsubject ${i}\x1fana\x1f2026-10-18T09:00:00+00:00\x1e\n`
    const full = Buffer.from([1, 2, 3].map(rec).join('')).toString('base64')
    const cutAt = full.slice(0, full.length - 30)
    const head = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', `tag exists=1 commit=${'c'.repeat(40)}`, 'version-tag exists=0'].map((l) => `OD-PF ${l}`).join('\n')
    const out = { [R3]: `${head}\nOD-PF commits log_b64=${cutAt}`, 'host:host-od-2': 'OD-PF lock repo=/srv/apps/alpha3 held=0 raw_b64=' }
    const r = parsePreflight(p, out, { now: NOW, cut: [R3] })
    expect(r.commits['dep-3'].commits.map((c) => c.subject)).toEqual(['subject 1', 'subject 2'])
    expect(r.commits['dep-3'].truncated).toBeGreaterThanOrEqual(1)
    expect(r.checks.find((c) => c.id === 'commits')).toMatchObject({ level: 'warn' })
    // an uncut line with the same content has no warning
    const whole = parsePreflight(p, { ...out, [R3]: `${head}\nOD-PF commits log_b64=${full}` }, { now: NOW })
    expect(whole.commits['dep-3'].commits).toHaveLength(3)
    expect(whole.checks.find((c) => c.id === 'commits')).toBeUndefined()
  })

  it("reports origin's head per checkout; a missing, malformed or disagreeing head is null", () => {
    const p = planFixture({ kind: 'preflight' })
    const head = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', `tag exists=1 commit=${'c'.repeat(40)}`, 'version-tag exists=0'].map((l) => `OD-PF ${l}`).join('\n')
    const H = 'd'.repeat(40)
    const out = (fields: string) => `${head}\nOD-PF commits log_b64= ${fields}`
    const parse = (o: Record<string, string>) => parsePreflight(p, o, { now: NOW }).commits
    const runs = p.deployments.map((d) => d.runId)
    const one = { [runs[0]]: out(`origin_head=${H}`), [runs[1]]: out('origin_head='), [runs[2]]: out('origin_head=nope') }
    const c = parse(one)
    expect([c['dep-1'].originHead, c['dep-2'].originHead, c['dep-3'].originHead]).toEqual([H, null, null])
    // an older host script without the field
    expect(parse({ [runs[0]]: `${head}\nOD-PF commits log_b64=` })['dep-1'].originHead).toBeNull()
    // a failed fetch leaves the last fetched copy: its head may be stale, so it is not one
    const stale = `${head.replace('branch fetched=1 exists=1', 'branch fetched=0 exists=1')}\nOD-PF commits log_b64= origin_head=${H}`
    expect(parse({ [runs[0]]: stale })['dep-1'].originHead).toBeNull()
    // one checkout reported by two hosts that disagree: no head
    const twice = planFixture({ kind: 'preflight' })
    twice.deployments = [twice.deployments[0], { ...twice.deployments[2], deploymentId: 'dep-1' }]
    const both = (a: string, b: string) => parsePreflight(twice, { [twice.deployments[0].runId]: out(`origin_head=${a}`), [twice.deployments[1].runId]: out(`origin_head=${b}`) }, { now: NOW }).commits['dep-1'].originHead
    expect(both(H, 'e'.repeat(40))).toBeNull()
    expect(both(H, H)).toBe(H)
  })

  it('only a cut commits task marks the commit list as cut; a cut deps task does not', () => {
    const p = planFixture({ kind: 'preflight' })
    const tags = ['od_step=preflight', `od_run=${R3}`]
    const feed = (task: string) => {
      const tr = new EventTranslator({ plan: p, secrets: () => [], now: clock().now })
      tr.feed(JSON.stringify({ event: 'task_start', name: task, tags }))
      tr.feed(JSON.stringify({ event: 'ok', host: 'od-2', task, tags, rc: 0, stdout: 'OD-PF deps config_b64=abc', truncated: ['stdout'] }))
      return tr.preflightCut()
    }
    expect(feed('preflight deps dep3')).toEqual([])
    expect(feed('preflight commits dep3')).toEqual([R3])
    // a task whose check can't be read is treated as possibly the commits one
    expect(feed('something else')).toEqual([R3])
    // end to end: the cut list from a cut deps task leaves an uncut commit list without a truncation warning
    const one = planFixture({ kind: 'preflight' })
    one.deployments = [one.deployments[2]]
    one.hosts = [one.hosts[1]]
    const rec = `${'1'.repeat(40)}\x1fsubject\x1fana\x1f2026-10-18T09:00:00+00:00\x1e\n`
    const lines = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', `tag exists=1 commit=${'c'.repeat(40)}`, 'version-tag exists=0', `commits log_b64=${Buffer.from(rec).toString('base64')}`]
    const out = { [R3]: lines.map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': 'OD-PF lock repo=/srv/apps/alpha3 held=0 raw_b64=' }
    const r = parsePreflight(one, out, { now: NOW, cut: feed('preflight deps dep3') })
    expect(r.commits['dep-3']).toMatchObject({ truncated: 0 })
    expect(r.checks.find((c) => c.id === 'commits')).toBeUndefined()
  })

  it('caps commits at MAX_COMMITS and reports the rest as truncated', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const rec = (i: number) => `${i.toString(16).padStart(40, '0')}\x1fs${i}\x1fa\x1f2026-10-18T09:00:00+00:00\x1e\n`
    const log = Buffer.from(Array.from({ length: 501 }, (_, i) => rec(i)).join('')).toString('base64')
    const lines = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', 'tag exists=0 commit=', 'version-tag exists=0', `commits log_b64=${log}`]
    const r = parsePreflight(p, { [R3]: lines.map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': 'OD-PF lock repo=/x held=0 raw_b64=' }, { now: NOW })
    expect(r.commits['dep-3'].commits).toHaveLength(500)
    expect(r.commits['dep-3'].truncated).toBe(1)
    expect(r.commitsTotal).toBe(500)
  })

  it('a missing result is a block, never clean', () => {
    const p = planFixture({ kind: 'preflight' })
    const r = parsePreflight(p, {}, { now: NOW })
    expect(r.blocked).toBe(true)
    expect(r.checks.every((c) => c.level === 'block')).toBe(true)
    expect(r.commitsTotal).toBe(0)
  })
})

describe('fix round 1', () => {
  const one = (extra: string[]) => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    p.deployments[0].useSudo = 'no'
    const base = ['tools missing=', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', 'tag exists=0 commit=', 'version-tag exists=0', 'commits log_b64=']
    return parsePreflight(p, { [R3]: [...extra, ...base].map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': 'OD-PF lock repo=/x held=0 raw_b64=' }, { now: NOW })
  }

  it('use_sudo no never resolves to sudo mode', () => {
    const r = one(['docker plain=fail sudo=ok mode=plain use=no'])
    expect(r.dockerModes).toEqual({})
    expect(r.checks.find((c) => c.id === 'docker')).toMatchObject({ level: 'block' })
    expect(r.checks.find((c) => c.id === 'docker')!.message).toContain('sudo is turned off')
    expect(one(['docker plain=fail sudo=skip mode=plain use=no']).dockerModes).toEqual({})
  })

  it('a failed version step is a release step and never fails a deployment', () => {
    const plan = planFixture({ kind: 'version' })
    const tr = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    const tags = ['od_step=version', `od_run=${R1}`]
    const out = [
      ...tr.feed(JSON.stringify({ event: 'task_start', name: 'version dep1', tags })),
      ...tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'version dep1', tags, rc: 1, stderr: 'remote rejected' })),
    ]
    expect(of(out, 'step.started')[0]).toMatchObject({ stepId: 'release:version', deploymentRunId: null, hostId: null })
    expect(of(out, 'step.failed')[0].stepId).toBe('release:version')
    expect(of(out, 'deployment.updated')).toEqual([])
    // a stopped run: finish() does not touch the deployment either
    const tr2 = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    tr2.feed(JSON.stringify({ event: 'task_start', name: 'version dep1', tags }))
    const fin = tr2.finish(null, 'SIGTERM')
    expect(of(fin, 'step.failed')[0].stepId).toBe('release:version')
    expect(of(fin, 'deployment.updated')).toEqual([])
  })

  it('a tag failure (marker, rc 0) is a warning; the next deployment still runs and nothing rolls back', () => {
    const plan = planFixture()
    const c = clock()
    const tr = new EventTranslator({ plan, secrets: () => [], now: c.now })
    const events: RunEventBody[] = []
    const run = (id: string, kind: string, res: Record<string, unknown> = {}) => {
      const tags = [`od_step=${kind}`, `od_run=${id}`]
      events.push(...tr.feed(JSON.stringify({ event: 'task_start', name: `${kind} x`, tags })))
      events.push(...tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: `${kind} x`, tags, rc: 0, ...res })))
    }
    run(R1, 'up')
    run(R1, 'tag', { stdout: 'fatal: remote denied\nOD-TAG failed rc=128', stderr: 'permission denied' })
    run(R2, 'record', { stdout: 'OD-PREV none' })
    run(R2, 'tag')
    const done = of(events, 'step.done').filter((e) => e.stepId.endsWith(':tag'))
    expect(done[0]).toMatchObject({ stepId: `${R1}:tag`, state: 'warn' })
    expect(done[0].message).toContain('exit code 128')
    expect(done[1]).toMatchObject({ stepId: `${R2}:tag`, state: 'ok' })
    expect(of(events, 'step.failed')).toEqual([])
    expect(of(events, 'deployment.updated').filter((u) => 'status' in u).map((u) => [u.deploymentRunId, u.status])).toEqual([[R1, 'succeeded'], [R2, 'running'], [R2, 'succeeded']])
    expect(of(events, 'log').some((l) => l.line.includes('OD-TAG'))).toBe(false)
  })

  it('an rb_tag marker failure still ends rolled_back', () => {
    const tr = new EventTranslator({ plan: planFixture({ kind: 'rollback' }), secrets: () => [], now: clock().now })
    const tags = ['od_step=rb_tag', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'rb_tag x', tags }))
    const out = tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'rb_tag x', tags, rc: 0, stdout: 'OD-TAG failed rc=1' }))
    expect(of(out, 'step.done')[0].state).toBe('warn')
    expect(of(out, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R1, status: 'rolled_back' }])
  })

  it('cuts at MAX_LOG_LINE with the (cut) suffix', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    expect(tr.feed('x'.repeat(MAX_LOG_LINE + 50))[0]).toMatchObject({ line: expect.stringMatching(/ …\(cut\)$/) })
    expect((tr.feed('x'.repeat(MAX_LOG_LINE + 50))[0] as { line: string }).line.length).toBeLessThanOrEqual(MAX_LOG_LINE)
  })

  it('preflight warnings carry a null stepId', () => {
    const tr = new EventTranslator({ plan: planFixture({ kind: 'preflight' }), secrets: () => [], now: clock().now })
    tr.feed(JSON.stringify({ event: 'task_start', name: 'preflight tools dep1', tags: ['od_step=preflight', `od_run=${R1}`] }))
    expect(of(tr.feed(JSON.stringify({ event: 'warning', msg: 'w' })), 'log')[0].stepId).toBeNull()
  })

  it('stream lines of another run or kind stay in the log', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: clock().now })
    const tags = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags }))
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'build dep1', tags, rc: 1, stdout: `${R2}:build\tother run\n${R1}:up\tother kind\n${R1}:build\town` }))
    expect(of(out, 'log').map((l) => l.line)).toEqual([`${R2}:build\tother run`, `${R1}:up\tother kind`])
  })

  it('commit text and lock holder fields are redacted; head is the newest commit even when reverted; a cut always warns', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const rec = (sha: string, s: string, a: string) => `${sha.repeat(40)}\x1f${s}\x1f${a}\x1f2026-10-18T09:00:00+00:00\x1e\n`
    const log = Buffer.from(rec('2', 'Revert "Add x"', 'ana') + rec('1', 'Add x token-9999', 'bob-9999')).toString('base64')
    const holder = Buffer.from(JSON.stringify({ releaseId: 'r-9999', user: 'u', machine: 'm', environment: 'env-9999', version: null, startedAt: '2026-10-19T09:30:00.000Z' })).toString('base64')
    const lines = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', 'tag exists=0 commit=', 'version-tag exists=0', `commits log_b64=${log}`]
    const out = { [R3]: lines.map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': `OD-PF lock repo=/x held=1 raw_b64=${holder}` }
    const r = parsePreflight(p, out, { now: NOW, cut: [R3], secrets: ['9999'] })
    // raw is the exact lock file text, kept verbatim for the break-lock compare
    expect(JSON.stringify({ ...r, locks: {} })).not.toContain('9999')
    expect(JSON.stringify(r.locks['host-od-2']!.holder)).not.toContain('9999')
    expect(r.commits['dep-3'].head).toBe('2'.repeat(40))
    expect(r.commits['dep-3'].truncated).toBeGreaterThanOrEqual(1)
    expect(r.checks.find((c) => c.id === 'commits')).toMatchObject({ level: 'warn' })
    // lock.busy holder too
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['9999'], now: () => NOW })
    const tags = ['od_step=lock', 'od_run=host:host-od-1']
    tr.feed(JSON.stringify({ event: 'task_start', name: 'lock od-1', tags }))
    const ev = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'lock od-1', tags, rc: 42, stdout: `OD-LOCK ${JSON.stringify({ releaseId: 'r-9999', user: 'u', machine: 'm', environment: 'env-9999', version: null, startedAt: '2026-10-19T09:30:00.000Z' })}` }))
    expect(JSON.stringify(ev)).not.toContain('9999')
  })

  it('a cut and more than MAX_COMMITS commits warns with the count', () => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [p.deployments[2]]
    p.hosts = [p.hosts[1]]
    const rec = (i: number) => `${i.toString(16).padStart(40, '0')}\x1fs${i}\x1fa\x1f2026-10-18T09:00:00+00:00\x1e\n`
    const log = Buffer.from(Array.from({ length: 501 }, (_, i) => rec(i)).join('')).toString('base64')
    const lines = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'compose exists=1', 'disk avail_kb=9999999', 'tag exists=0 commit=', 'version-tag exists=0', `commits log_b64=${log}`]
    const r = parsePreflight(p, { [R3]: lines.map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': 'OD-PF lock repo=/x held=0 raw_b64=' }, { now: NOW })
    expect(r.checks.find((c) => c.id === 'commits')).toMatchObject({ level: 'warn' })
    expect(r.checks.find((c) => c.id === 'commits')!.message).toContain('at least 1')
  })

  it('each step task yields task.done with its own state, rc, attempts and duration', () => {
    const { events } = replay('release-ok.jsonl')
    const tasks = of(events, 'task.done')
    // the lock prep helper belongs to the lock step and is not a task row
    expect(tasks.map((t) => t.task)).toEqual(['lock od-1', 'record dep2', 'fetch dep2', 'checkout dep2', 'build dep2', 'up dep2', 'health dep2 0', 'tag dep2', 'unlock od-1'])
    expect(tasks[0]).toEqual({ type: 'task.done', stepId: 'host:host-od-1:lock', task: 'lock od-1', hostId: 'host-od-1', state: 'ok', rc: 0, attempts: null, durationMs: 500 })
    expect(tasks.every((t) => t.durationMs === 500)).toBe(true)

    const c = clock()
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => [], now: c.now })
    const tags = ['od_step=health', `od_run=${R1}`]
    const out: RunEventBody[] = []
    const run = (task: string, result: Record<string, unknown>) => {
      out.push(...tr.feed(JSON.stringify({ event: 'task_start', name: task, tags })))
      c.t += 3000
      out.push(...tr.feed(JSON.stringify({ host: 'od-1', task, tags, no_log: false, truncated: [], ...result })))
    }
    run('health dep1 0', { event: 'ok', changed: false, attempts: 4, rc: null })
    expect(of(out, 'task.done')).toEqual([{ type: 'task.done', stepId: `${R1}:health`, task: 'health dep1 0', hostId: 'host-od-1', state: 'ok', rc: null, attempts: 4, durationMs: 3000 }])
    const up = ['od_step=up', `od_run=${R1}`]
    out.push(...tr.feed(JSON.stringify({ event: 'task_start', name: 'up dep1', tags: up })))
    out.push(...tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'up dep1', tags: up, changed: true, rc: 0 })))
    expect(of(out, 'task.done').at(-1)).toMatchObject({ task: 'up dep1', state: 'changed', attempts: null })
  })

  it('a failed task is a failed task.done with its rc, and its secret stays out', () => {
    const { events } = replay('release-health-fail.jsonl', planFixture(), ['hunter2-secret'])
    const failed = of(events, 'task.done').filter((t) => t.state === 'failed')
    expect(failed).toEqual([{ type: 'task.done', stepId: `${R2}:health`, task: 'health dep2 0', hostId: 'host-od-1', state: 'failed', rc: 1, attempts: null, durationMs: 500 }])
    // the untagged rescue tasks are no step's
    expect(of(events, 'task.done').map((t) => t.task)).not.toContain('fail dep2')
    expect(JSON.stringify(events)).not.toContain('hunter2-secret')
  })

  it('skipped and unreachable tasks, and a task name carrying a secret', () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['n4me-secret'], now: clock().now })
    const tags = ['od_step=backup', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'backup n4me-secret', tags }))
    const skipped = tr.feed(JSON.stringify({ event: 'skipped', host: 'od-1', task: 'backup n4me-secret', tags }))
    expect(of(skipped, 'task.done')[0]).toMatchObject({ state: 'skipped', task: 'backup ‹redacted›' })
    const t2 = ['od_step=fetch', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'fetch dep1', tags: t2 }))
    const un = tr.feed(JSON.stringify({ event: 'unreachable', host: 'od-1', task: 'fetch dep1', tags: t2, msg: 'timed out' }))
    expect(of(un, 'task.done')[0]).toMatchObject({ state: 'failed', task: 'fetch dep1', rc: null })
    expect(JSON.stringify([skipped, un])).not.toContain('n4me-secret')
  })

  it("a task's output lines carry its task name, redacted, so each task shows its own output", () => {
    const tr = new EventTranslator({ plan: planFixture(), secrets: () => ['n4me-secret'], now: clock().now })
    const tags = ['od_step=health', `od_run=${R1}`]
    const out: RunEventBody[] = []
    for (const [task, stdout] of [
      ['health dep1 0', 'GET /a 200'],
      ['health dep1 n4me-secret', 'GET /b?k=n4me-secret 503'],
    ]) {
      out.push(...tr.feed(JSON.stringify({ event: 'task_start', name: task, tags })))
      out.push(...tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task, tags, no_log: false, rc: 0, stdout, truncated: ['stdout'] })))
    }
    const logs = of(out, 'log').filter((l) => l.stepId === `${R1}:health`)
    expect(logs.map((l) => [l.task, l.line])).toEqual([
      ['health dep1 0', 'GET /a 200'],
      ['health dep1 0', 'Output of this step was cut (stdout)'],
      ['health dep1 ‹redacted›', 'GET /b?k=‹redacted› 503'],
      ['health dep1 ‹redacted›', 'Output of this step was cut (stdout)'],
    ])
    // the same name as the task's task.done, so the view can pair them
    expect(of(out, 'task.done').map((t) => t.task)).toEqual(['health dep1 0', 'health dep1 ‹redacted›'])
    expect(JSON.stringify(out)).not.toContain('n4me-secret')
  })

  it('the plugin reports changed and attempts', () => {
    expect(CALLBACK_PLUGIN_SOURCE).toContain('"changed": bool(res.get("changed"))')
    expect(CALLBACK_PLUGIN_SOURCE).toContain('"attempts": res.get("attempts") if isinstance(res.get("attempts"), int) else None')
  })

  it('the plugin tolerates extra Display arguments and non-string messages', () => {
    expect(CALLBACK_PLUGIN_SOURCE).toContain('def _warning(self, msg, *args, **kwargs):')
    expect(CALLBACK_PLUGIN_SOURCE).toContain('json.dumps(value, default=str)')
  })
})

describe('compose services and dependencies', () => {
  const b64 = (t: string): string => Buffer.from(t).toString('base64')
  const CONFIG = JSON.stringify({
    name: 'shop',
    services: {
      web: { image: 'web', depends_on: { api: { condition: 'service_started' }, cache: { condition: 'service_healthy' } } },
      api: { image: 'api', depends_on: ['db'] },
      worker: { image: 'w', depends_on: ['db', 'queue'] },
      db: { image: 'pg' },
      cache: { image: 'redis' },
      queue: { image: 'q' },
      solo: { image: 's' },
    },
  })
  const PS_ARRAY = JSON.stringify([{ Service: 'db', State: 'running' }, { Service: 'cache', State: 'running' }])
  const PS_NDJSON = [{ Service: 'db', State: 'running' }, { Service: 'cache', State: 'running' }].map((r) => JSON.stringify(r)).join('\n')

  /** dep 3 alone on od-2, with a passing base and the given extra OD-PF lines. */
  const one = (services: string[] | null, extra: string[]) => {
    const p = planFixture({ kind: 'preflight' })
    p.deployments = [{ ...p.deployments[2], services }]
    p.hosts = [p.hosts[1]]
    const base = ['tools missing=', 'docker plain=ok sudo=ok mode=plain use=auto', 'repo exists=1 git=1', 'clean ok=1', 'branch fetched=1 exists=1', 'disk avail_kb=9999999', 'tag exists=0 commit=', 'version-tag exists=0', 'commits log_b64=']
    return parsePreflight(p, { [R3]: [...base, ...extra].map((l) => `OD-PF ${l}`).join('\n'), 'host:host-od-2': 'OD-PF lock repo=/x held=0 raw_b64=' }, { now: NOW })
  }
  const COMPOSE_OK = `compose exists=1 services_b64=${b64('web\napi\n')}`

  it('parseDeps reads depends_on in array and map form and running names from array or NDJSON', () => {
    for (const ps of [PS_ARRAY, PS_NDJSON, `${PS_NDJSON}\n`]) {
      expect(parseDeps(CONFIG, ps, ['web', 'worker', 'solo'])).toEqual([
        { service: 'web', missing: ['api'] },
        { service: 'worker', missing: ['queue'] },
      ])
    }
    // a dependency that is itself selected is started by the same up
    expect(parseDeps(CONFIG, PS_ARRAY, ['web', 'api'])).toEqual([])
    expect(parseDeps(CONFIG, '', ['api'])).toEqual([{ service: 'api', missing: ['db'] }])
    expect(parseDeps(CONFIG, '[]', ['solo'])).toEqual([])
  })

  it('parseDeps skips one-shot dependencies and drops names that are not service names', () => {
    const config = JSON.stringify({
      services: {
        web: { depends_on: { migrate: { condition: 'service_completed_successfully' }, cache: { condition: 'service_started' }, 'bad name;rm': {} } },
        api: { depends_on: ['$(x)', 'queue'] },
      },
    })
    expect(parseDeps(config, '[]', ['web', 'api'])).toEqual([
      { service: 'web', missing: ['cache'] },
      { service: 'api', missing: ['queue'] },
    ])
    expect(parseDeps(JSON.stringify({ services: { web: { depends_on: { migrate: { condition: 'service_completed_successfully' } } } } }), '[]', ['web'])).toEqual([])
  })

  it("parseDeps failure gives the couldn't check warn and no deps warning", () => {
    expect(() => parseDeps('{not json', PS_ARRAY, ['web'])).toThrow()
    expect(() => parseDeps(CONFIG, '{"Service": ', ['web'])).toThrow()
    expect(() => parseDeps('[]', PS_ARRAY, ['web'])).toThrow()
    for (const deps of [`deps config_b64=${b64('{oops')} ps_b64=${b64(PS_ARRAY)}`, `deps config_b64= ps_b64=`, null]) {
      const r = one(['web'], [COMPOSE_OK, ...(deps ? [deps] : [])])
      expect(r.checks.filter((c) => c.id === 'deps').map((c) => `${c.level}: ${c.message}`)).toEqual(["warn: Couldn't check compose dependencies on label od-2"])
      expect(r.blocked).toBe(false)
    }
  })

  it('parsePreflight fills composeServices from services_b64, null when missing', () => {
    const plan = planFixture({ kind: 'preflight' })
    const { tr } = replay('preflight.jsonl', plan)
    const r = parsePreflight(plan, tr.preflightOutput(), { now: NOW + 60_000, cut: tr.preflightCut() })
    expect(r.composeServices).toEqual({ 'dep-1': ['web', 'worker'], 'dep-2': null, 'dep-3': ['api'] })
    expect(one(null, ['compose exists=1']).composeServices).toEqual({ 'dep-3': null })
    expect(one(null, ['compose exists=1 services_b64=']).composeServices).toEqual({ 'dep-3': null })
    expect(one(null, [`compose exists=1 services_b64=${b64('web\n--rm\n')}`]).composeServices).toEqual({ 'dep-3': null })
    expect(one(null, ['compose exists=0']).composeServices).toEqual({ 'dep-3': null })
    expect(one(null, [COMPOSE_OK]).composeServices).toEqual({ 'dep-3': ['web', 'api'] })
    expect(parsePreflight(planFixture({ kind: 'preflight' }), {}, { now: NOW }).composeServices).toEqual({ 'dep-1': null, 'dep-2': null, 'dep-3': null })
  })

  it('deps warnings are warn checks, never blocks', () => {
    const r = one(['web', 'worker'], [COMPOSE_OK, `deps config_b64=${b64(CONFIG)} ps_b64=${b64(PS_NDJSON)}`])
    expect(r.checks.filter((c) => c.id === 'deps')).toEqual([
      { id: 'deps', deploymentId: 'dep-3', hostId: 'host-od-2', label: 'dep3', level: 'warn', message: "web depends on api, which isn't running. --no-deps won't start it" },
      { id: 'deps', deploymentId: 'dep-3', hostId: 'host-od-2', label: 'dep3', level: 'warn', message: "worker depends on queue, which isn't running. --no-deps won't start it" },
    ])
    expect(r.blocked).toBe(false)
    const two = one(['web'], [COMPOSE_OK, `deps config_b64=${b64(CONFIG)} ps_b64=`])
    expect(two.checks.find((c) => c.id === 'deps')?.message).toBe("web depends on api and cache, which aren't running. --no-deps won't start them")
    const three = one(['worker', 'api'], [COMPOSE_OK, `deps config_b64=${b64(JSON.stringify({ services: { worker: { depends_on: ['a', 'b', 'c'] } } }))} ps_b64=`])
    expect(three.checks.find((c) => c.id === 'deps')?.message).toBe("worker depends on a, b and c, which aren't running. --no-deps won't start them")
    // all running: no deps check at all; a whole checkout never gets one
    expect(one(['api'], [COMPOSE_OK, `deps config_b64=${b64(CONFIG)} ps_b64=${b64(PS_ARRAY)}`]).checks.filter((c) => c.id === 'deps')).toEqual([])
    expect(one(null, [COMPOSE_OK]).checks.filter((c) => c.id === 'deps')).toEqual([])
  })
})

describe('markers and the generator agree', () => {
  it('parses marker lines', () => {
    expect(parseMarker('OD-PREV none')).toEqual({ mark: 'OD-PREV', rest: 'none' })
    expect(parseMarker('OD-LOCK-ERROR cannot create the lock in /a')).toEqual({ mark: 'OD-LOCK-ERROR', rest: 'cannot create the lock in /a' })
    expect(parseMarker('OD-NOPE x')).toBeNull()
    expect(parseMarker('hello OD-PREV')).toBeNull()
    expect(parsePrev('unknown')).toEqual({ kind: 'unknown' })
    expect(parsePrev('none')).toEqual({ kind: 'none' })
    expect(parsePrev('zzz')).toBeNull()
    expect(parsePfLine('lock repo=/a held=1 raw_b64=QQ==')).toEqual({ check: 'lock', fields: { repo: '/a', held: '1', raw_b64: 'QQ==' } })
    expect(parsePfLine('commits unknown')).toEqual({ check: 'commits', fields: { unknown: '' } })
    expect(parsePfLine('tag exists=0 commit=')).toEqual({ check: 'tag', fields: { exists: '0', commit: '' } })
  })

  it('every OD- marker in generated shell is in MARK, and every MARK is generated', () => {
    const names = new Set(Object.values(MARK))
    const seen = new Set<string>()
    for (const kind of ['release', 'rollback', 'preflight', 'version', 'unlock', 'break-lock'] as const) {
      const text = generatePlaybook(planFixture({ kind, lock: { expectRaw: { 'host-od-1': '{}', 'host-od-2': '{}' } } }))
      for (const m of text.matchAll(/OD-[A-Z]+(?:-[A-Z]+)*/g)) seen.add(m[0])
    }
    // a step that continues on failure reports OD-STEP; one whose `when` finds nothing changed reports OD-SKIP
    const plan = planFixture()
    plan.deployments[2] = { ...plan.deployments[2], steps: [stepFixture(0, 'after_up', { onFailure: 'continue', when: { kind: 'changed' } })] }
    for (const m of generatePlaybook(plan).matchAll(/OD-[A-Z]+(?:-[A-Z]+)*/g)) seen.add(m[0])
    for (const s of seen) expect(names.has(s as never), s).toBe(true)
    for (const n of names) expect(seen.has(n), n).toBe(true)
  })

  it('every generated preflight check name is one parsePreflight knows (fields are covered by the fixtures)', () => {
    const text = generatePlaybook(planFixture({ kind: 'preflight' }))
    const checks = new Set([...text.matchAll(/OD-PF ([a-z-]+)/g)].map((m) => m[1]))
    expect([...checks].sort()).toEqual(['branch', 'clean', 'commits', 'compose', 'disk', 'docker', 'lock', 'repo', 'tag', 'tools', 'version-tag'])
  })
})

describe('EventTranslator custom steps and hosts', () => {
  const customPlan = (): DeployPlan => {
    const plan = planFixture()
    plan.deployments[1].steps = [
      stepFixture(0, 'after_up', {}, { label: 'Migrate db' }),
      stepFixture(1, 'after_tag', { onFailure: 'continue' }, { label: 'Notify team' }),
    ]
    return plan
  }
  const tagsOf = (kind: string, run = R2): string[] => [`od_step=${kind}`, `od_run=${run}`]
  const start = (tr: EventTranslator, kind: string, run = R2): RunEventBody[] => tr.feed(JSON.stringify({ event: 'task_start', name: `${kind} x`, tags: tagsOf(kind, run) }))
  const result = (tr: EventTranslator, kind: string, over: Record<string, unknown> = {}, run = R2): RunEventBody[] =>
    tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: `${kind} x`, tags: tagsOf(kind, run), rc: 0, ...over }))
  const make = (secrets: string[] = []) => new EventTranslator({ plan: customPlan(), secrets: () => secrets, now: clock().now })

  it('a custom step settles ok under its own label', () => {
    const tr = make()
    const began = start(tr, 'c_0')
    expect(of(began, 'step.started')[0]).toMatchObject({ stepId: `${R2}:c_0`, kind: 'custom', name: 'Migrate db', hostId: 'host-od-1', deploymentRunId: R2 })
    const out = result(tr, 'c_0')
    expect(of(out, 'step.done')[0]).toMatchObject({ stepId: `${R2}:c_0`, state: 'ok' })
  })

  it('OD-STEP rc=3 settles warn, whether it comes on stdout, as a stream line, or both', () => {
    for (const via of ['stdout', 'stream', 'both'] as const) {
      const tr = make()
      start(tr, 'c_0')
      if (via !== 'stdout') tr.observeStreamLine(`${R2}:c_0\tOD-STEP rc=3`)
      const out = result(tr, 'c_0', { rc: 3, ...(via !== 'stream' ? { stdout: 'OD-STEP rc=3' } : { no_log: true }) })
      const done = of(out, 'step.done')
      expect(done, via).toHaveLength(1)
      expect(done[0], via).toMatchObject({ state: 'warn' })
      expect(done[0].message, via).toContain('exit code 3')
      expect(of(out, 'log').some((l) => l.line.startsWith('OD-STEP')), via).toBe(false)
    }
  })

  it('OD-SKIP settles skipped, from stdout or from the stream line under no_log', () => {
    const a = make()
    start(a, 'c_0')
    expect(of(result(a, 'c_0', { stdout: 'OD-SKIP' }), 'step.done')[0]).toMatchObject({ state: 'skipped' })
    const b = make()
    start(b, 'c_0')
    b.observeStreamLine(`${R2}:c_0\tOD-SKIP`)
    expect(of(result(b, 'c_0', { no_log: true }), 'step.done')[0]).toMatchObject({ state: 'skipped' })
  })

  it('a marker in a settled step or in another run is ignored', () => {
    const tr = make()
    start(tr, 'c_0')
    result(tr, 'c_0')
    tr.observeStreamLine(`${R2}:c_0\tOD-SKIP`)
    tr.observeStreamLine(`${R1}:c_0\tOD-SKIP`)
    tr.observeStreamLine(`${R2}:build\tOD-SKIP`)
    start(tr, 'c_1')
    expect(of(result(tr, 'c_1'), 'step.done')[0]).toMatchObject({ state: 'ok' })
    // c_0 stayed settled as ok: nothing re-settled it
    expect(tr.finish(0, null)).toEqual([])
  })

  it('a no_log step with a when holds its settle for a late OD-SKIP', () => {
    const plan = customPlan()
    plan.deployments[1].steps[0].step.when = { kind: 'changed' }
    plan.deployments[1].steps[0].step.secrets = [{ envName: 'TOKEN', secretId: 's' }]
    const mk = () => new EventTranslator({ plan, secrets: () => [], now: clock().now })
    // the marker lands after the result and before the host's next result
    const tr = mk()
    start(tr, 'c_0')
    const held = result(tr, 'c_0', { no_log: true })
    expect(of(held, 'step.done')).toEqual([])
    tr.observeStreamLine(`${R2}:c_0\tOD-SKIP`)
    start(tr, 'c_1')
    const next = result(tr, 'c_1', { stdout: 'x' })
    expect(of(next, 'step.done').map((e) => [e.stepId, e.state])).toEqual([[`${R2}:c_0`, 'skipped'], [`${R2}:c_1`, 'ok']])
    // no marker by finish(): the step settles ok
    const quiet = mk()
    start(quiet, 'c_0')
    result(quiet, 'c_0', { no_log: true })
    expect(of(quiet.finish(0, null), 'step.done')).toMatchObject([{ stepId: `${R2}:c_0`, state: 'ok' }])
    // a marker before the result needs no hold
    const early = mk()
    start(early, 'c_0')
    early.observeStreamLine(`${R2}:c_0\tOD-SKIP`)
    expect(of(result(early, 'c_0', { no_log: true }), 'step.done')[0]).toMatchObject({ state: 'skipped' })
  })

  it("a held settle is flushed only by its own host's next result", () => {
    const plan = customPlan()
    const held = { when: { kind: 'changed' as const }, secrets: [{ envName: 'TOKEN', secretId: 's' }] }
    Object.assign(plan.deployments[1].steps[0].step, held)
    plan.deployments[2].steps = [stepFixture(0, 'after_up', held, { label: 'Warm cache' })]
    const tr = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    const on = (host: string, kind: string, run: string, over: Record<string, unknown> = {}): RunEventBody[] =>
      tr.feed(JSON.stringify({ event: 'ok', host, task: `${kind} x`, tags: tagsOf(kind, run), rc: 0, ...over }))
    start(tr, 'c_0', R2)
    expect(of(on('od-1', 'c_0', R2, { no_log: true }), 'step.done')).toEqual([])
    start(tr, 'c_0', R3)
    expect(of(on('od-2', 'c_0', R3, { no_log: true }), 'step.done')).toEqual([])
    // a result with no host, or from an alias the plan does not have, flushes nothing
    expect(of(tr.feed(JSON.stringify({ event: 'ok', task: 'gather', rc: 0 })), 'step.done')).toEqual([])
    expect(of(tr.feed(JSON.stringify({ event: 'ok', host: 'od-9', task: 'gather', rc: 0 })), 'step.done')).toEqual([])
    // od-2's next result settles od-2's step only
    start(tr, 'up', R3)
    expect(of(on('od-2', 'up', R3), 'step.done').map((e) => e.stepId)).toEqual([`${R3}:c_0`, `${R3}:up`])
    expect(of(tr.finish(0, null), 'step.done').map((e) => [e.stepId, e.state])).toEqual([[`${R2}:c_0`, 'ok']])
  })

  it('markers count only in the step that prints them', () => {
    const tr = make()
    start(tr, 'c_0')
    const out = result(tr, 'c_0', { stdout: `OD-PREV ${'e'.repeat(40)}\nOD-HEAD ${'f'.repeat(40)}\nOD-BACKUP /tmp/x.dump` })
    expect(of(out, 'deployment.updated')).toEqual([])
    expect(of(out, 'log').map((l) => l.line)).toContain(`OD-PREV ${'e'.repeat(40)}`)
    // a tag note from a build step does not turn a later tag into a warning
    start(tr, 'build')
    result(tr, 'build', { stdout: 'OD-TAG failed rc=1' })
    start(tr, 'tag')
    expect(of(result(tr, 'tag'), 'step.done')[0]).toMatchObject({ state: 'ok' })
  })

  it('the deployment succeeds on the last step of its block, after an after_tag step', () => {
    const tr = make()
    start(tr, 'tag')
    const tagged = result(tr, 'tag')
    expect(of(tagged, 'step.done')[0]).toMatchObject({ state: 'ok' })
    expect(of(tagged, 'deployment.updated')).toEqual([])
    start(tr, 'c_1')
    const out = result(tr, 'c_1', { stdout: 'OD-SKIP' })
    expect(of(out, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R2, status: 'succeeded' }])
  })

  it('a failed middle custom step fails the deployment and it never succeeds', () => {
    const tr = make()
    start(tr, 'c_0')
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'c_0 x', tags: tagsOf('c_0'), rc: 2, stdout: 'boom' }))
    expect(of(out, 'step.failed')[0]).toMatchObject({ stepId: `${R2}:c_0` })
    expect(of(out, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R2, status: 'failed' }])
    start(tr, 'c_1')
    expect(of(result(tr, 'c_1'), 'deployment.updated')).toEqual([])
  })

  it('two hosts in one play keep separate step state and drop results from the other host', () => {
    const plan = planFixture()
    plan.deployments[1].urls = [{ url: 'http://127.0.0.1:8080/a', from: 'host' }, { url: 'http://127.0.0.1:8080/b', from: 'host' }]
    plan.deployments[2].urls = [{ url: 'http://127.0.0.1:8080/c', from: 'host' }, { url: 'http://127.0.0.1:8080/d', from: 'host' }]
    const tr = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    const health = (run: string, host: string, extra: Record<string, unknown> = {}): RunEventBody[] =>
      tr.feed(JSON.stringify({ event: 'ok', host, task: 'health x', tags: tagsOf('health', run), rc: 0, ...extra }))
    start(tr, 'health', R2)
    start(tr, 'health', R3)
    // the other host's skipped copies of each task are dropped
    expect(health(R2, 'od-2', { event: 'skipped' })).toEqual([])
    expect(health(R3, 'od-1', { event: 'skipped' })).toEqual([])
    const events = [...health(R2, 'od-1'), ...health(R3, 'od-2')]
    expect(of(events, 'step.done')).toEqual([])
    const second = [...health(R3, 'od-2'), ...health(R2, 'od-1')]
    expect(of(second, 'step.done').map((e) => e.stepId)).toEqual([`${R3}:health`, `${R2}:health`])
    // a failure on one host does not touch the other's step
    start(tr, 'build', R2)
    start(tr, 'build', R3)
    const fail = tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'build x', tags: tagsOf('build', R2), rc: 1 }))
    expect(of(fail, 'step.failed').map((e) => e.stepId)).toEqual([`${R2}:build`])
    expect(of(result(tr, 'build', { host: 'od-2' }, R3), 'step.done')[0]).toMatchObject({ stepId: `${R3}:build`, state: 'ok' })
  })

  it('a stored event never holds a secret or its base64 form', () => {
    const secret = 'sup3r-s3cret-value'
    const tr = make([secret])
    start(tr, 'c_0')
    const b64 = Buffer.from(secret).toString('base64')
    const out = result(tr, 'c_0', { rc: 1, stdout: `token ${secret}\nenc ${b64}\nenc2 ${Buffer.from(`${secret}\n`).toString('base64')}` })
    const text = JSON.stringify(out)
    expect(text).not.toContain(secret)
    expect(text).not.toContain(b64)
  })
})

describe('parseStreamLine', () => {
  it('splits prefix and text', () => {
    expect(parseStreamLine(`${R1}:build\tStep 1/9 : FROM node`)).toEqual({ runId: R1, kind: 'build', text: 'Step 1/9 : FROM node' })
    expect(parseStreamLine(`${R1}:up\t`)).toEqual({ runId: R1, kind: 'up', text: '' })
    expect(parseStreamLine(`${R1}:pre_hook\ta\tb`)).toEqual({ runId: R1, kind: 'pre_hook', text: 'a\tb' })
    expect(parseStreamLine(`${R1}:c_12\tmigrating`)).toEqual({ runId: R1, kind: 'c_12', text: 'migrating' })
    expect(parseStreamLine('no prefix here')).toBeNull()
    expect(parseStreamLine(`${R1}:build no tab`)).toBeNull()
  })
})

describe('callback plugin source', () => {
  it('is valid Python and declares the events the translator reads', () => {
    const py = spawnSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: CALLBACK_PLUGIN_SOURCE, encoding: 'utf8' })
    if (py.error) return // no python3 on this machine
    expect(py.stderr).toBe('')
    expect(py.status).toBe(0)
    for (const ev of ['task_start', 'rescued', 'stats', 'warning', '"ok"', '"failed"', '"skipped"', '"unreachable"']) expect(CALLBACK_PLUGIN_SOURCE).toContain(ev)
    expect(CALLBACK_PLUGIN_SOURCE).toContain('CALLBACK_NAME = "opsdeck_jsonl"')
    expect(CALLBACK_PLUGIN_SOURCE).toContain('65536')
    expect(CALLBACK_PLUGIN_SOURCE).toContain('flush()')
    // output is only read when the task is not no_log
    expect(CALLBACK_PLUGIN_SOURCE.indexOf('if not no_log')).toBeLessThan(CALLBACK_PLUGIN_SOURCE.indexOf('res.get(key)'))
  })
})

describe('EventTranslator release flow', () => {
  // dep1 ups in two parts (stage 0 and stage 2), with a flow step between
  const flowPlan = (): DeployPlan => {
    const plan = planFixture()
    plan.deployments[0].urls = []
    plan.flow = {
      onFailure: 'stop-all',
      stages: [
        { kind: 'services', parts: [{ runId: R1, services: ['a'], urls: [] }] },
        { kind: 'step', runId: R1, step: stepFixture(21, 'after_up', { name: 'Migrate db' }, { label: 'Migrate db', anchor: null }) },
        { kind: 'services', parts: [{ runId: R1, services: ['b'], urls: [] }, { runId: R2, services: null, urls: [0] }, { runId: R3, services: null, urls: [] }] },
      ],
    }
    return plan
  }
  const feed = (tr: EventTranslator, kind: string, run: string, ev: 'task_start' | 'ok') =>
    tr.feed(JSON.stringify({ event: ev, host: 'od-1', name: `${kind} x`, task: `${kind} x`, tags: [`od_step=${kind}`, `od_run=${run}`], rc: 0 }))

  it('a run upped in two parts settles up only after both', () => {
    const tr = new EventTranslator({ plan: flowPlan(), secrets: () => [], now: clock().now })
    const out: RunEventBody[] = []
    out.push(...feed(tr, 'up', R1, 'task_start'), ...feed(tr, 'up', R1, 'ok'))
    expect(of(out, 'step.done')).toHaveLength(0)
    out.push(...feed(tr, 'up', R1, 'task_start'), ...feed(tr, 'up', R1, 'ok'))
    expect(of(out, 'step.done').map((e) => e.stepId)).toEqual([`${R1}:up`])
    // a run with one part settles on its one up
    const two = [...feed(tr, 'up', R2, 'task_start'), ...feed(tr, 'up', R2, 'ok')]
    expect(of(two, 'step.done').map((e) => e.stepId)).toEqual([`${R2}:up`])
  })

  it('under a flow a run settles on its last step in flow order: its after_tag step, not the flow step or tag', () => {
    const plan = flowPlan()
    Object.assign(plan.deployments[0], { preHookB64: null, postHookB64: null, steps: [stepFixture(0, 'after_tag')] })
    const tr = new EventTranslator({ plan, secrets: () => [], now: clock().now })
    const settled = (out: RunEventBody[]) => of(out, 'deployment.updated').filter((e) => e.status === 'succeeded').map((e) => e.deploymentRunId)
    for (const k of ['c_21', 'tag']) expect(settled([...feed(tr, k, R1, 'task_start'), ...feed(tr, k, R1, 'ok')]), k).toEqual([])
    expect(settled([...feed(tr, 'c_0', R1, 'task_start'), ...feed(tr, 'c_0', R1, 'ok')])).toEqual([R1])
  })

  it('a flow step settles under its label', () => {
    const tr = new EventTranslator({ plan: flowPlan(), secrets: () => [], now: clock().now })
    const began = feed(tr, 'c_21', R1, 'task_start')
    expect(of(began, 'step.started')[0]).toMatchObject({ stepId: `${R1}:c_21`, kind: 'custom', name: 'Migrate db', deploymentRunId: R1 })
    expect(of(feed(tr, 'c_21', R1, 'ok'), 'step.done')[0]).toMatchObject({ stepId: `${R1}:c_21`, state: 'ok' })
  })
})

describe('parallel prepare builds', () => {
  const tags = ['od_step=build', `od_run=${R1}`]
  const setup = () => {
    const c = clock()
    const tr = new EventTranslator({ plan: planFixture({ prepare: { cap: 2 } }), secrets: () => [], now: c.now })
    const feed = (o: Record<string, unknown>): RunEventBody[] => tr.feed(JSON.stringify({ tags, no_log: false, truncated: [], ...o }))
    return { c, tr, feed }
  }

  it('the launch starts the build step but its result does not settle it; the async_status ok does', () => {
    const { c, feed } = setup()
    const started = feed({ event: 'task_start', name: 'build launch dep1' })
    expect(started).toEqual([{ type: 'step.started', stepId: `${R1}:build`, kind: 'build', name: 'Build dep1', hostId: 'host-od-1', deploymentRunId: R1 }])
    c.t += 1000
    // the other host skips the launch (its block is bound to od-1): a foreign result, dropped
    expect(feed({ event: 'skipped', host: 'od-2', task: 'build launch dep1' })).toEqual([])
    const launched = feed({ event: 'ok', host: 'od-1', task: 'build launch dep1', changed: true, ansible_job_id: 'j1.1', started: 1, finished: 0 })
    expect(launched.filter((e) => e.type === 'step.done' || e.type === 'step.failed' || e.type === 'task.done')).toEqual([])
    c.t += 1000
    expect(feed({ event: 'task_start', name: 'build dep1' })).toEqual([])
    c.t += 8000
    const polled = feed({ event: 'ok', host: 'od-1', task: 'build dep1', changed: true, rc: 0, attempts: 3, stdout: '' })
    expect(of(polled, 'step.done')).toEqual([{ type: 'step.done', stepId: `${R1}:build`, state: 'ok', durationMs: 10000 }])
    expect(of(polled, 'task.done')).toMatchObject([{ task: 'build dep1', state: 'changed', attempts: 3 }])
  })

  it('a failed launch or a failed poll fails the build step', () => {
    const a = setup()
    a.feed({ event: 'task_start', name: 'build launch dep1' })
    const failed = a.feed({ event: 'failed', host: 'od-1', task: 'build launch dep1', rc: 1, msg: 'launch failed' })
    expect(of(failed, 'step.failed').map((e) => e.stepId)).toEqual([`${R1}:build`])

    const b = setup()
    b.feed({ event: 'task_start', name: 'build launch dep1' })
    b.feed({ event: 'ok', host: 'od-1', task: 'build launch dep1', changed: true })
    b.feed({ event: 'task_start', name: 'build dep1' })
    const out = b.feed({ event: 'failed', host: 'od-1', task: 'build dep1', rc: 17, stdout: 'compose build failed', attempts: 2 })
    expect(of(out, 'step.failed').map((e) => e.stepId)).toEqual([`${R1}:build`])
    expect(of(out, 'deployment.updated')).toContainEqual({ type: 'deployment.updated', deploymentRunId: R1, status: 'failed' })
  })

  it('the gate is a helper: its failure is a log line, no step', () => {
    const { tr } = setup()
    tr.feed(JSON.stringify({ event: 'task_start', name: 'od gate', tags: [] }))
    const out = tr.feed(JSON.stringify({ event: 'failed', host: 'od-2', task: 'od gate', msg: 'OpsDeck prepare stopped: a checkout did not prepare' }))
    expect(out.filter((e) => e.type !== 'log')).toEqual([])
  })
})

describe('parallel prepare build cleanup', () => {
  it('the untagged cleanup after a poll is no step and no task row', () => {
    const tr = new EventTranslator({ plan: planFixture({ prepare: { cap: 2 } }), secrets: () => [], now: () => NOW })
    const tags = ['od_step=build', `od_run=${R1}`]
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build launch dep1', tags }))
    tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'build launch dep1', tags, changed: true }))
    tr.feed(JSON.stringify({ event: 'task_start', name: 'build dep1', tags }))
    tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'build dep1', tags, changed: true, rc: 0 }))
    const out = [
      ...tr.feed(JSON.stringify({ event: 'task_start', name: 'build cleanup dep1', tags: [] })),
      ...tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: 'build cleanup dep1', tags: [], changed: false })),
      ...tr.feed(JSON.stringify({ event: 'failed', host: 'od-1', task: 'build cleanup dep1', tags: [], ignored: true, msg: 'gone' })),
    ]
    expect(out.filter((e) => e.type.startsWith('step.') || e.type === 'task.done' || e.type === 'deployment.updated')).toEqual([])
  })
})

describe('EventTranslator operations', () => {
  const opPlan = (lock = true): DeployPlan => {
    const base = planFixture()
    return {
      ...base,
      kind: 'operation',
      version: null,
      deployments: base.deployments.slice(0, 2),
      operation: {
        runbookId: 'rb-1',
        name: 'bounce',
        lock,
        items: [
          { type: 'builtin', builtin: 'restart' },
          { type: 'step', step: stepFixture(0, 'after_up', {}, { anchor: null, label: 'Warm cache' }) },
          { type: 'builtin', builtin: 'restart' },
          { type: 'builtin', builtin: 'backup-db' },
        ],
        targets: [{ runId: R1, services: [] }, { runId: R2, services: [] }],
      },
    }
  }
  const tagsOf = (kind: string, run: string): string[] => [`od_step=${kind}`, `od_run=${run}`]
  const start = (tr: EventTranslator, kind: string, run: string, name = `${kind} x`): RunEventBody[] => tr.feed(JSON.stringify({ event: 'task_start', name, tags: tagsOf(kind, run) }))
  const result = (tr: EventTranslator, kind: string, run: string, name = `${kind} x`): RunEventBody[] =>
    tr.feed(JSON.stringify({ event: 'ok', host: 'od-1', task: name, tags: tagsOf(kind, run), rc: 0 }))

  it('labels a built-in row by its name, a repeat under its own key, and a step by its label', () => {
    const tr = new EventTranslator({ plan: opPlan(), secrets: () => [], now: clock().now })
    const rows = [...start(tr, 'op_restart', R1), ...start(tr, 'c_0', R1), ...start(tr, 'op_restart_2', R1), ...start(tr, 'backup', R1)]
    expect(of(rows, 'step.started').map((e) => [e.stepId, e.kind, e.name])).toEqual([
      [`${R1}:op_restart`, 'op', 'Restart dep1'],
      [`${R1}:c_0`, 'custom', 'Warm cache'],
      [`${R1}:op_restart_2`, 'op', 'Restart dep1'],
      [`${R1}:backup`, 'backup', 'Backup DB dep1'],
    ])
    expect(JSON.stringify(rows)).not.toContain('Operation')
  })

  it('a target runs from its first item and succeeds on its last', () => {
    const tr = new EventTranslator({ plan: opPlan(), secrets: () => [], now: clock().now })
    const first = start(tr, 'op_restart', R2)
    expect(of(first, 'deployment.updated')).toEqual([{ type: 'deployment.updated', deploymentRunId: R2, status: 'running' }])
    const out = [...result(tr, 'op_restart', R2), ...start(tr, 'c_0', R2), ...result(tr, 'c_0', R2), ...start(tr, 'op_restart_2', R2), ...result(tr, 'op_restart_2', R2)]
    expect(of(out, 'deployment.updated').filter((e) => e.status === 'succeeded')).toEqual([])
    const last = [...start(tr, 'backup', R2), ...result(tr, 'backup', R2)]
    expect(of(last, 'deployment.updated').at(-1)).toEqual({ type: 'deployment.updated', deploymentRunId: R2, status: 'succeeded' })
  })

  it('a lock-free run shows no Lock row for its prep task', () => {
    const tr = new EventTranslator({ plan: opPlan(false), secrets: () => [], now: clock().now })
    const out = [...start(tr, 'lock', 'host:host-od-1', 'lock prep od-1'), ...result(tr, 'lock', 'host:host-od-1', 'lock prep od-1')]
    expect(of(out, 'step.started')).toEqual([])
    expect(of(out, 'step.done')).toEqual([])
  })
})
