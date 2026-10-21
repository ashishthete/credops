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
import { FIX, planFixture } from './deploy-helpers'

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
    for (const s of seen) expect(names.has(s as never), s).toBe(true)
    for (const n of names) expect(seen.has(n), n).toBe(true)
  })

  it('every generated preflight check name is one parsePreflight knows (fields are covered by the fixtures)', () => {
    const text = generatePlaybook(planFixture({ kind: 'preflight' }))
    const checks = new Set([...text.matchAll(/OD-PF ([a-z-]+)/g)].map((m) => m[1]))
    expect([...checks].sort()).toEqual(['branch', 'clean', 'commits', 'compose', 'disk', 'docker', 'lock', 'repo', 'tag', 'tools', 'version-tag'])
  })
})

describe('parseStreamLine', () => {
  it('splits prefix and text', () => {
    expect(parseStreamLine(`${R1}:build\tStep 1/9 : FROM node`)).toEqual({ runId: R1, kind: 'build', text: 'Step 1/9 : FROM node' })
    expect(parseStreamLine(`${R1}:up\t`)).toEqual({ runId: R1, kind: 'up', text: '' })
    expect(parseStreamLine(`${R1}:pre_hook\ta\tb`)).toEqual({ runId: R1, kind: 'pre_hook', text: 'a\tb' })
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
