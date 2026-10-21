import { describe, expect, it } from 'vitest'
import { maskDetail, maskEvents } from '../../src/main/deploy/mask'
import type { ReleaseDetail, RunEvent, RunEventBody } from '../../src/shared/deploy'

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
      runs: [{ id: 'run1', steps: [{ id: 's1', error: `boom ${SECRET}` }], commits: [{ sha: 'abc', message: `fix ${SECRET}` }] }],
    } as unknown as ReleaseDetail
    const out = maskDetail(d, [SECRET])
    expect(JSON.stringify(d)).toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(out.runs[0]).toMatchObject({ id: 'run1', steps: [{ id: 's1', error: 'boom ‹redacted›' }] })
  })
})
