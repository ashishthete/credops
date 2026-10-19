import { describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { AiRequests, type ClaudeClient } from '../../src/main/ai/claude'
import type { PromptRedactionContext } from '../../src/main/ai/prompt-redact'
import { fallbackNotes, generateNotes, notesPrompt, releaseNotesFinalizeStep } from '../../src/main/ai/release-notes'
import { openDatabase } from '../../src/main/db/connection'
import type { FinalizeContext, ReleaseRunMeta } from '../../src/main/deploy/finalize'
import { createAiHandlers } from '../../src/main/ipc/handlers/ai'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { AiFailure, type ReleaseNotesRequest } from '../../src/shared/ai'
import type { CommitInfo } from '../../src/shared/deploy'

const API = '11111111-1111-4111-8111-111111111111'
const WEB = '22222222-2222-4222-8222-222222222222'
const ENV = '33333333-3333-4333-8333-333333333333'
const NO_REDACTION: PromptRedactionContext = { knownSecrets: [], usernames: [], hostAddresses: [] }

function commit(subject: string, deploymentId = API, i = 0): CommitInfo {
  return { sha: `abc123${i}`.padEnd(40, '0'), subject, author: 'Dana Example <dana@example.com>', date: '2026-10-18T10:00:00Z', deploymentId }
}

const FOUR: CommitInfo[] = [
  commit('feat: refunds from the order page', API, 1),
  commit('fix(api): totals off by one cent', API, 2),
  commit('chore: bump deps', WEB, 3),
  commit('perf: faster checkout page', WEB, 4),
]

function request(over: Partial<ReleaseNotesRequest> = {}): ReleaseNotesRequest {
  return {
    environmentId: ENV,
    productName: 'Payments',
    deployments: [
      { id: API, name: 'api' },
      { id: WEB, name: 'web' },
    ],
    version: '1.4.0',
    commits: FOUR,
    ...over,
  }
}

function fakeClaude(text = '## Features\n- Refunds', over: { fail?: AiFailure; stopReason?: string } = {}) {
  const stream = vi.fn(async (req: Parameters<ClaudeClient['stream']>[0]) => {
    if (over.fail) throw over.fail
    for (const part of text.match(/.{1,5}/gs) ?? []) req.onText(part)
    return { text, model: 'claude-opus-5-5', stopReason: over.stopReason ?? 'end_turn' }
  })
  return { stream }
}

function audit() {
  const db = openDatabase(':memory:')
  return new AuditLog(db, { actor: { osUser: 'tester', machine: 'box' } })
}

function deps(claude: ReturnType<typeof fakeClaude>, log = audit(), redaction = NO_REDACTION) {
  return { claude, audit: log, redaction: () => redaction, environmentName: () => 'staging' }
}

describe('notesPrompt', () => {
  it('prompt orders sections and excludes authors', () => {
    const { system, user } = notesPrompt(request(), { redaction: NO_REDACTION, environmentName: 'staging' })
    const order = ['## Features', '## Enhancements', '## Fixes', '## Hotfixes'].map((h) => system.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(system).toMatch(/sales and marketing/)
    expect(system).toMatch(/‹redacted›/)
    expect(user).toBe(
      [
        'Product: Payments',
        'Environment: staging',
        'Version: 1.4.0',
        '',
        'Commits:',
        '### api',
        '- feat: refunds from the order page',
        '- fix(api): totals off by one cent',
        '### web',
        '- chore: bump deps',
        '- perf: faster checkout page',
      ].join('\n'),
    )
    for (const t of [system, user]) {
      expect(t).not.toMatch(/Dana|dana@example\.com|abc123|2026-10-18/)
    }
  })

  it('one deployment → no grouping headings', () => {
    const { user } = notesPrompt(request({ deployments: [{ id: API, name: 'api' }], commits: FOUR.slice(0, 2) }), {
      redaction: NO_REDACTION,
      environmentName: 'staging',
    })
    expect(user).not.toMatch(/###/)
    expect(user).toContain('Commits:\n- feat: refunds from the order page\n- fix(api): totals off by one cent')
  })

  it('commit text is redacted before sending', () => {
    const r = notesPrompt(
      request({ commits: [commit('fix: rotate token=abc123def456ghi and hunter22secretvalue')] }),
      { redaction: { ...NO_REDACTION, knownSecrets: ['hunter22secretvalue'] }, environmentName: 'staging' },
    )
    expect(r.user).not.toContain('abc123def456ghi')
    expect(r.user).not.toContain('hunter22secretvalue')
    expect(r.user).toContain('‹redacted›')
    expect(Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0)).toBeGreaterThanOrEqual(2)
  })
})

describe('generateNotes', () => {
  it('streams via claude and returns text', async () => {
    const claude = fakeClaude('## Features\n- Refunds from the order page')
    const deltas: string[] = []
    const res = await generateNotes(request(), {
      ...deps(claude),
      requestId: 'req-1',
      trigger: 'editor',
      signal: new AbortController().signal,
      onText: (t) => void deltas.push(t),
    })
    expect(deltas.join('')).toBe('## Features\n- Refunds from the order page')
    expect(res).toEqual({
      requestId: 'req-1',
      text: '## Features\n- Refunds from the order page',
      model: 'claude-opus-5-5',
      source: 'claude',
      truncated: false,
      redactions: {},
    })
    const sent = claude.stream.mock.calls[0]![0]
    expect(sent.effort).toBe('medium')
    expect(sent.user).toContain('- feat: refunds from the order page')
  })

  it('max_tokens keeps the partial text and marks it truncated', async () => {
    const res = await generateNotes(request(), {
      ...deps(fakeClaude('## Features\n- Ref', { stopReason: 'max_tokens' })),
      trigger: 'editor',
      signal: new AbortController().signal,
    })
    expect([res.source, res.truncated, res.text]).toEqual(['claude', true, '## Features\n- Ref'])
  })

  it('an AiError falls back to the commit list', async () => {
    const res = await generateNotes(request(), {
      ...deps(fakeClaude('', { fail: new AiFailure('auth', 'Anthropic rejected the API key') })),
      trigger: 'editor',
      signal: new AbortController().signal,
    })
    expect(res.source).toBe('fallback')
    expect(res.model).toBeNull()
    expect(res.error).toEqual({ code: 'auth', message: 'Anthropic rejected the API key' })
    expect(res.text).toBe(fallbackNotes(FOUR))
  })

  it('no commits → empty fallback without calling claude', async () => {
    const claude = fakeClaude()
    const res = await generateNotes(request({ commits: [] }), { ...deps(claude), trigger: 'editor', signal: new AbortController().signal })
    expect(claude.stream).not.toHaveBeenCalled()
    expect([res.source, res.text]).toEqual(['fallback', ''])
  })

  it('audit ai.release_notes has counts but no content', async () => {
    const log = audit()
    await generateNotes(
      request({ commits: [...FOUR, commit('fix: drop hunter22secretvalue from logs', API, 5)] }),
      {
        ...deps(fakeClaude('## Fixes\n- Totals are right'), log, { ...NO_REDACTION, knownSecrets: ['hunter22secretvalue'] }),
        trigger: 'finalize',
        signal: new AbortController().signal,
      },
    )
    await generateNotes(request(), {
      ...deps(fakeClaude('', { fail: new AiFailure('network', "Can't reach the Anthropic API") }), log),
      trigger: 'editor',
      signal: new AbortController().signal,
    })
    const rows = log.list({ actions: ['ai.release_notes'] }).reverse()
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'failure'])
    expect(rows[0]!.details).toEqual({ model: 'claude-opus-5-5', commits: 5, redactions: 1, trigger: 'finalize', source: 'claude' })
    expect(rows[1]!.details).toEqual({ model: null, commits: 4, redactions: 0, trigger: 'editor', source: 'fallback', code: 'network' })
    expect([rows[0]!.targetType, rows[0]!.targetId]).toEqual(['environment', ENV])
    const all = JSON.stringify(rows)
    for (const s of ['refunds', 'Totals', 'hunter22', 'Dana', 'feat:']) expect(all).not.toContain(s)
  })
})

describe('fallbackNotes', () => {
  it('fallback groups conventional commits deterministically', () => {
    const commits = [
      commit('hotfix: stop double charge'),
      commit('fix(ui): button overlap'),
      commit('feat!: new dashboard'),
      commit('Merge pull request #12 from x/y'),
      commit("Merge branch 'main' into dev"),
      commit('ci: cache pnpm'),
      commit('docs: readme'),
      commit('test: more cases'),
      commit('build: electron 40'),
      commit('chore(deps): bump'),
      commit('refactor: split store'),
      commit('Tidy the login page'),
      commit('enh: faster search'),
      commit('feat: new dashboard'),
    ]
    const want = [
      '## Features',
      '- New dashboard',
      '',
      '## Enhancements',
      '- Split store',
      '- Tidy the login page',
      '- Faster search',
      '',
      '## Fixes',
      '- Button overlap',
      '',
      '## Hotfixes',
      '- Stop double charge',
    ].join('\n')
    expect(fallbackNotes(commits)).toBe(want)
    expect(fallbackNotes([...commits].reverse())).toBe(fallbackNotes([...commits].reverse()))
    expect(fallbackNotes([commit('chore: x')])).toBe('')
  })
})

function meta(over: Partial<ReleaseRunMeta> = {}): ReleaseRunMeta {
  return {
    id: 'rel-1',
    releaseId: 'rel-1',
    kind: 'release',
    status: 'succeeded',
    environmentId: ENV,
    environmentName: 'staging',
    productId: null,
    productName: 'Payments',
    deployments: [
      { id: API, name: 'api', hostId: null, hostLabel: 'h1', status: 'succeeded', previousCommit: null, deployedCommit: null },
      { id: WEB, name: 'web', hostId: null, hostLabel: 'h2', status: 'succeeded', previousCommit: null, deployedCommit: null },
    ],
    hostIds: [],
    version: '1.4.0',
    previousVersion: null,
    commits: FOUR,
    options: {} as ReleaseRunMeta['options'],
    releaseNotes: null,
    redeploy: false,
    startedAt: null,
    finishedAt: null,
    actor: { osUser: 'tester', machine: 'box' } as ReleaseRunMeta['actor'],
    urls: [],
    ...over,
  }
}

function ctx(run: ReleaseRunMeta): FinalizeContext & { lines: string[] } {
  const lines: string[] = []
  return { run, lines, log: (l) => void lines.push(l), signal: new AbortController().signal }
}

describe('releaseNotesFinalizeStep', () => {
  it('finalize keeps edited notes', async () => {
    const claude = fakeClaude()
    const c = ctx(meta({ releaseNotes: '## Features\n- Edited by hand' }))
    expect(await releaseNotesFinalizeStep(deps(claude))(c)).toBe('## Features\n- Edited by hand')
    expect(claude.stream).not.toHaveBeenCalled()
  })

  it('finalize redeploy → null, no claude call', async () => {
    const claude = fakeClaude()
    const c = ctx(meta({ redeploy: true }))
    expect(await releaseNotesFinalizeStep(deps(claude))(c)).toBeNull()
    expect(claude.stream).not.toHaveBeenCalled()
    expect(c.lines).toEqual(['Release notes: skipped (no new commits)'])
  })

  it('finalize writes notes with claude', async () => {
    const claude = fakeClaude('## Features\n- Refunds')
    const c = ctx(meta())
    expect(await releaseNotesFinalizeStep(deps(claude))(c)).toBe('## Features\n- Refunds')
    expect(claude.stream.mock.calls[0]![0].user).toContain('Environment: staging')
    expect(c.lines).toEqual(['Release notes: written by Claude (claude-opus-5-5)'])
  })

  it('finalize uses fallback when claude errors and never throws', async () => {
    const c = ctx(meta())
    const out = await releaseNotesFinalizeStep(deps(fakeClaude('', { fail: new AiFailure('rate-limit', 'x') })))(c)
    expect(out).toBe(fallbackNotes(FOUR))
    expect(c.lines).toEqual(['Release notes: Claude unavailable (rate-limit); used commit list'])
    const boom = { stream: vi.fn(async () => Promise.reject(new Error('kaput'))) }
    const c2 = ctx(meta())
    await expect(releaseNotesFinalizeStep({ ...deps(fakeClaude()), claude: boom })(c2)).resolves.toBe(fallbackNotes(FOUR))
    expect(c2.lines).toEqual(['Release notes: Claude unavailable (api); used commit list'])
  })
})

describe('ai:releaseNotes handler', () => {
  it('streams deltas under the request id and validates the request', async () => {
    const requests = new AiRequests()
    const deltas: { requestId: string; text: string }[] = []
    const claude = fakeClaude('## Fixes\n- Totals')
    const h = createAiHandlers({
      settings: { status: () => ({ ai: { configured: true, model: 'm' } }) as never },
      requests,
      notes: deps(claude),
      explain: {} as never,
      onDelta: (d) => void deltas.push(d),
    })
    const id = '44444444-4444-4444-8444-444444444444'
    const res = await h['ai:releaseNotes'](id, request())
    expect(res.requestId).toBe(id)
    expect(deltas.map((d) => d.requestId)).toEqual(deltas.map(() => id))
    expect(deltas.map((d) => d.text).join('')).toBe('## Fixes\n- Totals')
    expect(() => VALIDATORS['ai:releaseNotes']([id, request()])).not.toThrow()
    expect(() => VALIDATORS['ai:releaseNotes']([id, request({ commits: [commit('x'.repeat(301))] })])).toThrow(/subject/)
    expect(() => VALIDATORS['ai:releaseNotes']([id, request({ commits: Array.from({ length: 501 }, () => commit('a')) })])).toThrow()
    expect(() => VALIDATORS['ai:releaseNotes'](['nope', request()])).toThrow()
  })

  it('a second live request with the same id is rejected', async () => {
    const requests = new AiRequests()
    const id = '55555555-5555-4555-8555-555555555555'
    requests.start(id)
    expect(() => requests.start(id)).toThrow(/already running/)
  })
})

describe('release:set-notes', () => {
  it('release:set-notes is refused unless the release is ready or blocked', async () => {
    const { rig, ready } = await import('./release-rig')
    const { createDeployHandlers } = await import('../../src/main/ipc/handlers/deploy')
    const r = await rig()
    const id = await ready(r)
    const before = r.f.audit.list({}).length
    const h = createDeployHandlers({ deploys: r.f.deploys, releases: r.svc, tooling: async () => ({}) as never })
    await h['release:set-notes'](id, '## Features\n- Refunds')
    expect(r.svc.detail(id).releaseNotes).toBe('## Features\n- Refunds')
    // An empty string clears the notes so finalize writes them again.
    r.svc.setNotes(id, '')
    expect(r.svc.detail(id).releaseNotes).toBeNull()
    expect(r.f.audit.list({}).length).toBe(before)
    r.f.vault.lock('manual')
    expect(() => r.svc.setNotes(id, 'x')).toThrow('vault locked')
  })

  it('notes cannot change once a release left ready or blocked', async () => {
    const { rig, ready } = await import('./release-rig')
    const r = await rig()
    const id = await ready(r)
    await r.svc.discard(id)
    expect(() => r.svc.setNotes(id, 'late')).toThrow('A discarded release cannot take notes')
    expect(r.svc.detail(id).releaseNotes).toBeNull()
  })

  it('validator caps notes and needs a uuid', () => {
    const check = VALIDATORS['release:set-notes']
    expect(() => check(['nope', 'x'])).toThrow()
    expect(() => check([API, 'x'.repeat(20001)])).toThrow()
    expect(check([API, '## Fixes'])).toEqual([API, '## Fixes'])
  })
})
