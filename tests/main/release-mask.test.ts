import { describe, expect, it } from 'vitest'
import { maskDetail, maskEvents, maskSummary } from '../../src/main/deploy/mask'
import type { CommitInfo, PreflightReport, ReleaseDetail, ReleaseSummary, RunEvent, RunEventBody } from '../../src/shared/deploy'

const SECRET = 'hunter2-secret-value'
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'
const check = { id: 'auth', deploymentId: null, hostId: 'h1', label: 'auth', level: 'block' as const, message: `auth ${SECRET} refused` }

const at = (bodies: RunEventBody[]): RunEvent[] => bodies.map((b, i) => ({ id: `e${i}`, runId: 'rel', seq: i + 1, at: '2026-10-21T00:00:00.000Z', ...b }) as RunEvent)

describe('masking release text in main', () => {
  it('masks every text field of the events, and leaves ids and states alone', () => {
    const raw = at([
      { type: 'log', stepId: 'r1:health', hostId: 'h1', stream: 'out', line: `GET /?t=${SECRET}`, task: `health ${SECRET}` },
      { type: 'log', stepId: 'r1:build', hostId: 'h1', stream: 'err', line: KEY },
      { type: 'task.done', stepId: 'r1:health', task: `health ${SECRET}`, hostId: 'h1', state: 'failed', rc: 1, attempts: null, durationMs: 5 },
      { type: 'step.failed', stepId: 'r1:health', error: `503 for ${SECRET}`, durationMs: 5 },
      { type: 'step.done', stepId: 'r1:up', state: 'warn', durationMs: 5, message: `warned ${SECRET}` },
      { type: 'lock.busy', hostId: 'h1', holder: { releaseId: 'x', actor: 'a', since: 'b' } as never, stale: false, text: `held ${SECRET}` },
      { type: 'run.finished', status: 'failed', error: `failed ${SECRET}` },
      { type: 'preflight.check', check },
      { type: 'preflight.done', report: { releaseId: 'rel', checks: [check] } as never },
    ])
    const out = maskEvents(raw, [SECRET])
    expect(JSON.stringify(raw)).toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain('b3BlbnNzaC1rZXk')
    expect(out[0]).toEqual({ ...raw[0], line: 'GET /?t=‹redacted›', task: 'health ‹redacted›' })
    expect(out[2]).toMatchObject({ stepId: 'r1:health', state: 'failed', task: 'health ‹redacted›' })
    expect(out.map((e) => [e.seq, e.type])).toEqual(raw.map((e) => [e.seq, e.type]))
  })

  it('masks the playbook, the error and the check messages of a detail', () => {
    const d = { id: 'rel', playbook: `[{"name": "${SECRET}"}]`, error: `x ${SECRET}`, preflight: { releaseId: 'rel', checks: [check] }, runs: [] } as unknown as ReleaseDetail
    const out = maskDetail(d, [SECRET])
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(out.playbook).toBe('[{"name": "‹redacted›"}]')
    expect(maskDetail({ ...d, playbook: null, error: null, preflight: null }, [SECRET])).toMatchObject({ playbook: null, error: null, preflight: null })
  })
  it('masks a secret a step echoes as base64, with or without a newline, at the start of a line or inside it', () => {
    const b = (x: string) => Buffer.from(x).toString('base64')
    const lines = [`${SECRET} ${b(SECRET)}`, b(`${SECRET}\n`), `token=${b(SECRET)}`]
    const raw = at(lines.map((line) => ({ type: 'log' as const, stepId: 'r1:c_0', hostId: 'h1', stream: 'out' as const, line })))
    const out = maskEvents(raw, [SECRET]).map((e) => (e as { line: string }).line)
    expect(out).toEqual(['‹redacted› ‹redacted›', '‹redacted›', 'token=‹redacted›'])
    for (const l of out) expect(l).not.toContain(b(SECRET).slice(0, 8))
    // a 5-byte secret still has its full encodings masked (8 characters), though its prefix is too short
    expect(maskEvents(at([{ type: 'log', stepId: 'r1:c_0', hostId: 'h1', stream: 'out', line: `x ${b('k3y99')} ${b('k3y99\n')}` }]), ['k3y99']).map((e) => (e as { line: string }).line)).toEqual(['x ‹redacted› ‹redacted›'])
    // a short secret has no base64 form worth masking, and plain text stays as it was
    expect(maskEvents(at([{ type: 'log', stepId: 'r1:c_0', hostId: 'h1', stream: 'out', line: `x ${b('pin')}` }]), ['pin']).map((e) => (e as { line: string }).line)).toEqual([`x ${b('pin')}`])
  })

  it('masks a secret with quotes or backslashes as it appears in the stored JSON playbook', () => {
    const odd = 'p@ss"w\\rd9-long'
    const playbook = JSON.stringify([{ name: 'health', vars: { url: `https://x/?t=${odd}` } }], null, 2)
    expect(playbook).not.toContain(odd)
    const out = maskDetail({ id: 'rel', playbook, error: null, preflight: null, runs: [] } as unknown as ReleaseDetail, [odd])
    expect(out.playbook).toBe(JSON.stringify([{ name: 'health', vars: { url: 'https://x/?t=‹redacted›' } }], null, 2))
    expect(JSON.parse(out.playbook!)).toBeTruthy()
  })

  it('masks every free text of a detail: release notes, step errors and commit messages', () => {
    const d = {
      id: 'rel',
      playbook: null,
      error: null,
      preflight: null,
      releaseNotes: `see https://x/?t=${SECRET}`,
      runs: [{ id: 'run1', steps: [{ stepId: 's1', error: `boom ${SECRET}` }], commits: [{ sha: 'abc', subject: `fix ${SECRET}` }] }],
    } as unknown as ReleaseDetail
    const out = maskDetail(d, [SECRET])
    expect(JSON.stringify(d)).toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(out.runs[0]).toMatchObject({ id: 'run1', steps: [{ stepId: 's1', error: 'boom ‹redacted›' }], commits: [{ sha: 'abc', subject: 'fix ‹redacted›' }] })
  })
})

// Short secrets: a PIN equal to the year, and a hex fragment that is also a uuid segment.
const SHORT = ['2026', 'c3d4']
const UUID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const RUN = '0190a1b2-c3d4-7e5f-8a6b-000000000001'
const AT = '2026-10-21T18:00:00.000Z'
/** Every string field filled: ids and times hold the short secrets, and each text field says them too. */
const TEXT = 'pin 2026 and c3d4'
const commit = (): CommitInfo => ({ sha: 'c3d4c3d4c3d4c3d4c3d4c3d4c3d4c3d4c3d4c3d4', subject: TEXT, author: 'Ana', date: AT, deploymentId: UUID })
const report = (): PreflightReport => ({
  releaseId: UUID,
  checks: [{ id: 'auth', deploymentId: UUID, hostId: UUID, label: 'auth', level: 'block', message: TEXT }],
  commits: { d1: { commits: [commit()], hiddenPairs: 0, truncated: 0, firstDeploy: false, head: 'c3d4', tagCommit: 'c3d4' } },
  dockerModes: { d1: 'plain' },
  composeServices: { d1: ['web'] },
  composeDatabases: { d1: ['db'] },
  serviceCommits: { s1: { since: 'c3d4', count: 1, known: true } },
  locks: { h1: { holder: { releaseId: UUID, user: 'ana', machine: 'mbp', environment: 'staging', version: '2026.1', startedAt: AT }, stale: false, raw: '{"startedAt":"2026-10-21"}' } },
  commitsTotal: 1,
  blocked: true,
})
const summary = (): Required<ReleaseSummary> => ({
  id: UUID, environmentId: UUID, environmentName: 'staging', kind: 'release', status: 'failed', version: '2026.1', previousVersion: '2025.9', redeploy: false,
  rollbackOf: UUID, triggeredBy: 'ana@mbp', createdAt: AT, startedAt: AT, finishedAt: AT, deploymentCount: 1, hostCount: 1, serviceIds: [UUID], serviceCount: 1,
  error: TEXT, unpublished: false, operation: null, playbookSource: 'generated',
})
const detail = (): Required<ReleaseDetail> => ({
  ...summary(),
  options: { backup: true, notify: true, qa: false },
  releaseNotes: TEXT,
  playbook: JSON.stringify([{ name: 'od-1', hosts: 'od-1', tasks: [{ name: `health ${TEXT}` }] }], null, 2),
  playbookHidden: false,
  playbookGenerated: null,
  runs: [{
    id: RUN, releaseId: UUID, deploymentId: UUID, deploymentName: 'core', hostId: UUID, hostLabel: 'app1', position: 0, branch: 'main', previousCommit: 'c3d4', deployedCommit: 'c3d4',
    commits: [commit()], status: 'failed', rolledBack: false, backupFile: '/srv/b/2026-10-21.tgz', startedAt: AT, finishedAt: AT,
    steps: [{ stepId: `${RUN}:build`, kind: 'build', state: 'failed', startedAt: AT, finishedAt: AT, error: TEXT }],
    services: [{ id: UUID, name: 'web', composeService: 'web', previousCommit: 'c3d4', previousReleaseId: UUID, deployedCommit: 'c3d4' }], wholeCheckout: false,
  }],
  preflight: report(),
  lastSeq: 9,
  regions: [{ id: UUID, code: 'eu-west-1', displayName: 'Ireland' }],
})
const allEvents = (): RunEvent[] => {
  const step = `${RUN}:build`
  const bodies: RunEventBody[] = [
    { type: 'run.started', kind: 'release', version: '2026.1' },
    { type: 'preflight.check', check: report().checks[0]! },
    { type: 'preflight.done', report: report() },
    { type: 'step.started', stepId: step, kind: 'build', name: TEXT, hostId: UUID, deploymentRunId: RUN },
    { type: 'step.done', stepId: step, state: 'warn', durationMs: 2026, message: TEXT },
    { type: 'step.failed', stepId: step, error: TEXT, durationMs: 2026 },
    { type: 'task.done', stepId: step, task: TEXT, hostId: UUID, state: 'failed', rc: 1, attempts: 2, durationMs: 2026 },
    { type: 'log', stepId: step, hostId: UUID, stream: 'out', line: TEXT, task: TEXT },
    { type: 'log.truncated', dropped: 2026 },
    { type: 'lock.busy', hostId: UUID, holder: report().locks.h1!.holder, stale: false, text: TEXT },
    { type: 'rollback.started', deploymentRunIds: [RUN] },
    { type: 'rollback.done', ok: true },
    { type: 'deployment.updated', deploymentRunId: RUN, status: 'failed', previousCommit: 'c3d4', deployedCommit: 'c3d4', backupFile: '/srv/b/2026-10-21.tgz' },
    { type: 'version.bumped', from: '2025.9', to: '2026.1' },
    { type: 'run.finished', status: 'failed', error: TEXT },
  ]
  return bodies.map((b, i) => ({ id: `${UUID.slice(0, -1)}${i}`, runId: UUID, seq: i + 1, at: AT, ...b }) as RunEvent)
}

/** The paths (array indices as `[]`) whose string the masking changed; it also fails on any changed key or non-string. */
function changed(a: unknown, b: unknown, path = ''): string[] {
  if (typeof a === 'string') return a === b ? [] : [path]
  if (Array.isArray(a)) return a.flatMap((x, i) => changed(x, (b as unknown[])[i], `${path}[]`))
  if (a !== null && typeof a === 'object') {
    expect(Object.keys(b as object)).toEqual(Object.keys(a))
    return [...new Set(Object.entries(a).flatMap(([k, v]) => changed(v, (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k)))]
  }
  expect(b).toBe(a)
  return []
}

describe('masking only the text fields', () => {
  it('keeps ids, timestamps and step ids that hold a short secret, and still masks it inside text', () => {
    const d = maskDetail(detail(), SHORT)
    expect(d.id).toBe(UUID)
    expect(d.startedAt).toBe(AT)
    expect(d.finishedAt).toBe(AT)
    expect(d.runs[0]!.steps[0]).toMatchObject({ stepId: `${RUN}:build`, startedAt: AT, finishedAt: AT, error: 'pin ‹redacted› and ‹redacted›' })
    expect(d.releaseNotes).toBe('pin ‹redacted› and ‹redacted›')
    const ev = maskEvents(allEvents(), SHORT)
    for (const [i, e] of ev.entries()) expect([e.id, e.runId, e.at]).toEqual([allEvents()[i]!.id, UUID, AT])
    expect(ev.find((e) => e.type === 'log')).toMatchObject({ stepId: `${RUN}:build`, hostId: UUID, line: 'pin ‹redacted› and ‹redacted›' })
    expect(maskSummary(summary(), SHORT)).toEqual({ ...summary(), error: 'pin ‹redacted› and ‹redacted›' })
  })

  it('masks exactly these fields: a new text field has to be added on purpose', () => {
    expect(changed(summary(), maskSummary(summary(), SHORT))).toEqual(['error'])
    expect(changed(detail(), maskDetail(detail(), SHORT)).sort()).toEqual(
      [
        'error',
        'releaseNotes',
        'playbook',
        'runs[].commits[].subject',
        'runs[].steps[].error',
        'preflight.checks[].message',
        'preflight.commits.d1.commits[].subject',
      ].sort(),
    )
    const events = allEvents()
    const masked = maskEvents(events, SHORT)
    expect([...new Set(events.flatMap((e, i) => changed(e, masked[i]).map((p) => `${e.type}:${p}`)))].sort()).toEqual(
      [
        'log:line',
        'log:task',
        'task.done:task',
        'step.started:name',
        'step.done:message',
        'step.failed:error',
        'lock.busy:text',
        'run.finished:error',
        'preflight.check:check.message',
        'preflight.done:report.checks[].message',
        'preflight.done:report.commits.d1.commits[].subject',
      ].sort(),
    )
  })

  it('masks a known secret inside a base64 hook in the playbook, at any alignment, and keeps other base64 as it was', () => {
    for (const pad of ['', 'x', 'xy']) {
      const hook = `${pad}curl -H "Authorization: Bearer ${SECRET}" https://x.example\n`
      const lock = Buffer.from('{"releaseId":"r1"}').toString('base64')
      const playbook = JSON.stringify([{ hosts: 'od-1', vars: { od: { lock_b64: lock } }, tasks: [{ block: [{ name: 'pre-hook' }], vars: { d: { pre_hook: Buffer.from(hook).toString('base64') } } }] }], null, 2)
      const out = maskDetail({ ...detail(), playbook }, [SECRET]).playbook!
      const plays = JSON.parse(out) as { vars: { od: { lock_b64: string } }; tasks: { vars: { d: { pre_hook: string } } }[] }[]
      const decoded = Buffer.from(plays[0]!.tasks[0]!.vars.d.pre_hook, 'base64').toString('utf8')
      expect(decoded).toBe(`${pad}curl -H "Authorization: Bearer ‹redacted›" https://x.example\n`)
      expect(plays[0]!.vars.od.lock_b64).toBe(lock)
      expect(out).not.toContain(Buffer.from(hook).toString('base64'))
    }
  })
  it('replaces a hook or lock payload that does not decode cleanly with its size, and keeps an empty hook', () => {
    const bad = { pre_hook: 'not base64 at all!', post_hook: Buffer.from([0xff, 0xfe, 0x41]).toString('base64'), none: '' }
    const playbook = JSON.stringify([{ hosts: 'od-1', tasks: [{ vars: { d: { ...bad, other_hook: '', pre: 'x' } } }], vars: { od: { expect_b64: 'bad' } } }], null, 2)
    const plays = JSON.parse(maskDetail({ ...detail(), playbook }, [SECRET]).playbook!)
    expect(plays[0].tasks[0].vars.d).toEqual({ pre_hook: '‹hook, 18 bytes›', post_hook: '‹hook, 3 bytes›', none: '', other_hook: '', pre: 'x' })
    expect(plays[0].vars.od.expect_b64).toBe('‹lock data, 3 bytes›')
  })
})
