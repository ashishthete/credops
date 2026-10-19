import { describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase } from '../../src/main/db/connection'
import { buildContext, explain, ExplainMemory, recordCommand, EXPLAIN_SYSTEM, type ExplainSources } from '../../src/main/ai/explain'
import { createAiHandlers } from '../../src/main/ipc/handlers/ai'
import { VALIDATORS } from '../../src/main/ipc/validators'
import type { PromptRedactionContext } from '../../src/main/ai/prompt-redact'
import { AiFailure, MAX_COMMANDS, type ExplainSubject } from '../../src/shared/ai'
import type { ReleaseDetail, RunEvent, RunEventBody } from '../../src/shared/deploy'
import type { SessionMeta } from '../../src/shared/ssh'
import type { TunnelMeta, TunnelRuntime } from '../../src/shared/tunnels'

const REL = '44444444-4444-4444-8444-444444444444'
const ENV = '33333333-3333-4333-8333-333333333333'
const HOST = '22222222-2222-4222-8222-222222222222'
const SES = '55555555-5555-4555-8555-555555555555'
const TUN = '66666666-6666-4666-8666-666666666666'
const REQ = '77777777-7777-4777-8777-777777777777'
const SECRET = 'hunter2-super-secret'
const CTX: PromptRedactionContext = { knownSecrets: [SECRET], usernames: ['deploy'], hostAddresses: ['web1.internal.example'] }

function releaseEvents(): RunEvent[] {
  const bodies: RunEventBody[] = [
    { type: 'step.started', stepId: 'other', kind: 'fetch', name: 'git fetch', hostId: HOST, deploymentRunId: null },
    { type: 'log', stepId: 'other', hostId: HOST, stream: 'out', line: 'OTHER-STEP-LINE' },
    { type: 'step.started', stepId: 's-build', kind: 'build', name: 'docker compose build', hostId: HOST, deploymentRunId: null },
  ]
  for (let i = 0; i < 300; i++) bodies.push({ type: 'log', stepId: 's-build', hostId: HOST, stream: 'out', line: `line ${i}` })
  bodies.push({ type: 'log', stepId: 's-build', hostId: HOST, stream: 'err', line: `auth to 10.1.2.3 with ${SECRET} failed` })
  bodies.push({ type: 'step.failed', stepId: 's-build', error: 'build exited 1', durationMs: 5 })
  return bodies.map((b, i) => ({ id: `e${i}`, runId: REL, seq: i + 1, at: '2026-10-19T12:00:00Z', ...b }) as unknown as RunEvent)
}

function sources(over: Partial<ExplainSources> = {}): ExplainSources & { pages: number[] } {
  const all = releaseEvents()
  const pages: number[] = []
  return {
    pages,
    release: {
      detail: () => ({ id: REL, environmentId: ENV, environmentName: 'prod' }) as ReleaseDetail,
      events: (_id: string, after: number, limit: number) => {
        pages.push(after)
        return all.filter((e) => e.seq > after).slice(0, Math.min(limit, 100))
      },
    },
    sessions: { list: () => [] },
    tunnels: {
      get: () => ({ id: TUN, label: 'db', hostId: HOST, environmentId: ENV, type: 'L', bindAddress: '127.0.0.1', bindPort: 5432, targetHost: '10.9.8.7', targetPort: 5433 }) as TunnelMeta,
      runtime: () => ({ id: TUN, state: 'failed', error: { code: 'remote-refused', message: 'connect to 10.9.8.7:5433 refused' }, failures: 5, liveness: 'probe' }) as TunnelRuntime,
    },
    host: () => ({ label: 'web-1', os: 'ubuntu' }),
    environment: () => ({ name: 'prod', protected: true }),
    sessionAuth: () => ({ auth: 'key', port: 2222, identityLabel: 'prod-deploy-key', username: 'deploy' }),
    ...over,
  }
}

const GOOD = {
  summary: 'The build failed.',
  cause: 'Registry auth.',
  confidence: 'high',
  steps: ['Log in to the registry'],
  commands: [{ title: 'Check login', command: 'docker login registry', where: 'host', risk: 'read-only' }],
}

function fakeClaude(json: unknown = GOOD, fail?: AiFailure) {
  return { complete: vi.fn(async () => (fail ? Promise.reject(fail) : { json, model: 'claude-opus-5-5', stopReason: 'end_turn' })) }
}
function audit() {
  return new AuditLog(openDatabase(':memory:'), { actor: { osUser: 'tester', machine: 'box' } })
}
const deps = (claude = fakeClaude(), log = audit(), src = sources()) => ({ claude, audit: log, redaction: () => CTX, sources: src, signal: new AbortController().signal })
const subject: ExplainSubject = { kind: 'release', releaseId: REL, stepId: 's-build' }

describe('buildContext', () => {
  it('release context has step, last 200 lines of that step only, redacted', async () => {
    const src = sources()
    const c = buildContext(subject, src)
    expect(src.pages.length).toBeGreaterThan(1)
    expect(c.parts.step).toContain('Build')
    expect(c.parts.step).toContain('docker compose build')
    expect(c.parts.error).toBe('build exited 1')
    const lines = c.parts.log.split('\n')
    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe('line 101')
    expect(c.parts.log).not.toContain('OTHER-STEP-LINE')
    expect(c.parts.host).toContain('web-1')
    expect(c.target).toEqual({ hostId: HOST, hostLabel: 'web-1', environmentId: ENV, environmentName: 'prod', protected: true })

    const claude = fakeClaude()
    const out = await explain(REQ, subject, deps(claude))
    const sent = (claude.complete.mock.calls[0] as unknown as [{ user: string; system: string }])[0]
    expect(sent.user).not.toContain(SECRET)
    expect(sent.user).not.toContain('10.1.2.3')
    expect(out.sentContext).toBe(sent.user)
    expect(out.redactions.secret).toBe(1)
    expect(out.redactions.ip).toBe(1)
  })

  it('compose snippets go through the env-block redactor', () => {
    const c = buildContext(subject, sources({ composeSnippet: () => 'DB_PASSWORD=plain\n' }))
    expect(c.envBlocks.has('compose')).toBe(true)
  })

  it('session context never includes usernames or key names', async () => {
    const meta = {
      id: SES, kind: 'ssh', hostId: HOST, environmentId: ENV, label: 'web-1', state: 'failed',
      hops: [{ label: 'bastion', state: 'up' }, { label: 'web-1', state: 'failed' }],
      error: { code: 'auth', message: 'Permission denied for deploy' }, readyAt: null,
    } as unknown as SessionMeta
    const src = sources({ sessions: { list: () => [meta] } })
    const c = buildContext({ kind: 'session', sessionId: SES }, src)
    const all = Object.values(c.parts).join('\n')
    expect(all).toContain('bastion → web-1')
    expect(all).toContain('auth: key')
    expect(all).toContain('2222')
    expect(all).not.toContain('prod-deploy-key')
    const claude = fakeClaude()
    await explain(REQ, { kind: 'session', sessionId: SES }, deps(claude, audit(), src))
    const sent = (claude.complete.mock.calls[0] as unknown as [{ user: string }])[0].user
    expect(sent).not.toMatch(/\bdeploy\b/)
    expect(sent).not.toContain('prod-deploy-key')
  })

  it('tunnel context keeps loopback, redacts target host', async () => {
    const claude = fakeClaude()
    const out = await explain(REQ, { kind: 'tunnel', tunnelId: TUN }, deps(claude))
    expect(out.sentContext).toContain('127.0.0.1:5432')
    expect(out.sentContext).not.toContain('10.9.8.7')
    expect(out.sentContext).toContain('5433')
    expect(out.sentContext).toContain('failures: 5')
    expect(out.sentContext).toContain('liveness: probe')
    expect(out.target.hostLabel).toBe('web-1')
  })
})

describe('explain', () => {
  it('parses structured output and caps commands', async () => {
    const many = { ...GOOD, commands: Array.from({ length: 12 }, (_, i) => ({ title: `c${i}`, command: `echo ${i}`, where: 'local', risk: 'read-only' })) }
    const claude = fakeClaude(many)
    const out = await explain(REQ, subject, deps(claude))
    expect(out.commands).toHaveLength(MAX_COMMANDS)
    expect(out.model).toBe('claude-opus-5-5')
    expect(out.requestId).toBe(REQ)
    const req = (claude.complete.mock.calls[0] as unknown as [{ effort: string; system: string; schema: unknown }])[0]
    expect(req.effort).toBe('high')
    expect(req.system).toBe(EXPLAIN_SYSTEM)
    expect(EXPLAIN_SYSTEM).toMatch(/placeholder/)
  })

  it('bad output → bad-output error', async () => {
    await expect(explain(REQ, subject, deps(fakeClaude({ nope: true })))).rejects.toMatchObject({ code: 'bad-output' })
    await expect(explain(REQ, subject, deps(fakeClaude(GOOD, new AiFailure('refused', 'no'))))).rejects.toMatchObject({ code: 'refused' })
  })

  it('audit ai.explain has no content', async () => {
    const log = audit()
    await explain(REQ, subject, deps(fakeClaude(), log))
    await explain(REQ, subject, deps(fakeClaude({ bad: 1 }), log)).catch(() => undefined)
    const rows = log.list({ actions: ['ai.explain'] })
    expect(rows.map((r) => r.outcome).sort()).toEqual(['failure', 'success'])
    const text = JSON.stringify(rows)
    for (const s of ['docker login', 'line 1', 'Registry auth', 'The build failed', SECRET, 'build exited']) expect(text).not.toContain(s)
    const ok = rows.find((r) => r.outcome === 'success')!
    expect(ok.details).toMatchObject({ subject: 'release', commands: 1, model: 'claude-opus-5-5' })
  })
})

describe('ai:command', () => {
  it("ai:command reads the command from main's copy and audits it redacted", async () => {
    const log = audit()
    const memory = new ExplainMemory()
    const cmd = { ...GOOD, commands: [{ title: 't', command: `curl -H "token: ${SECRET}" 10.4.4.4`, where: 'host', risk: 'changes-state' }] }
    memory.remember(await explain(REQ, subject, deps(fakeClaude(cmd), log)))
    recordCommand({ memory, audit: log, redaction: () => CTX }, REQ, 0, 'run')
    const [row] = log.list({ actions: ['ai.command'] })
    expect(row.details).toMatchObject({ mode: 'run', risk: 'changes-state', where: 'host' })
    expect(String(row.details?.command)).toContain('curl')
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(JSON.stringify(row)).not.toContain('10.4.4.4')
    expect(row.targetId).toBe(HOST)
    expect(() => recordCommand({ memory, audit: log, redaction: () => CTX }, REQ, 5, 'copy')).toThrow(/no longer/)
    expect(() => recordCommand({ memory, audit: log, redaction: () => CTX }, '88888888-8888-4888-8888-888888888888', 0, 'copy')).toThrow(/no longer/)
  })

  it('memory keeps the last 20 explanations', async () => {
    const memory = new ExplainMemory()
    const base = await explain(REQ, subject, deps())
    for (let i = 0; i < 21; i++) memory.remember({ ...base, requestId: `r${i}` })
    expect(memory.get('r0')).toBeNull()
    expect(memory.get('r20')).not.toBeNull()
  })

  it('handlers wire ai:explain and ai:command, validators check them', async () => {
    const log = audit()
    const memory = new ExplainMemory()
    const requests = { start: vi.fn((id: string) => ({ id, signal: new AbortController().signal })), finish: vi.fn(), cancel: vi.fn() }
    const h = createAiHandlers({
      settings: { status: () => ({ ai: { configured: true, model: 'm' } }) as never },
      requests,
      notes: {} as never,
      onDelta: () => undefined,
      explain: { claude: fakeClaude(), audit: log, redaction: () => CTX, sources: sources(), memory },
    })
    const out = await h['ai:explain'](REQ, subject)
    expect(requests.finish).toHaveBeenCalledWith(REQ)
    expect(memory.get(REQ)?.summary).toBe(out.summary)
    await h['ai:command'](REQ, 0, 'copy')
    expect(log.list({ actions: ['ai.command'] })).toHaveLength(1)
    expect(() => VALIDATORS['ai:explain']([REQ, { kind: 'release', releaseId: REL, stepId: 's-build' }])).not.toThrow()
    expect(() => VALIDATORS['ai:explain']([REQ, { kind: 'host', hostId: HOST }])).toThrow()
    expect(() => VALIDATORS['ai:command']([REQ, 0, 'copy'])).not.toThrow()
    expect(() => VALIDATORS['ai:command']([REQ, 0, 'exec'])).toThrow()
    expect(() => VALIDATORS['ai:command']([REQ, MAX_COMMANDS, 'run'])).toThrow()
  })
})
