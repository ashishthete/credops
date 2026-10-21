import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ReleaseService } from '../../src/main/deploy/release-service'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { PLAYBOOK_CHANGED_MESSAGE } from '../../src/main/deploy/release-service'
import { REVIEW_REQUIRED_MESSAGE } from '../../src/main/ipc/handlers/deploy'
import { MAX_EVENTS_PAGE, PLAYBOOK_NOT_STORED_MESSAGE, type ReleaseDetail } from '../../src/shared/deploy'
import { MAX_SERVICES } from '../../src/shared/services'
import { DeployError } from '../../src/shared/deploy-error'
import { RunbookStore } from '../../src/main/deploy/runbook-store'
import { makeDeployFixture } from './deploy-helpers'

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const check = (channel: string, args: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](args)
const OPTS = { backup: true, notify: false, qa: false }
const HASH = 'a'.repeat(64)

describe('release:* validators', () => {
  it('accept well-formed arguments', () => {
    expect(() => check('release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'minor', options: OPTS }])).not.toThrow()
    expect(() => check('release:preflight', [{ environmentId: ID, serviceIds: [], checkoutIds: [ID], bump: 'minor', options: OPTS }])).not.toThrow()
    expect(() => check('release:start', [ID, { typedName: 'prod', redeploy: true }])).not.toThrow()
    expect(() => check('release:start', [ID, { playbookSha256: HASH }])).not.toThrow()
    expect(() => check('deploy:previewPlaybook', [ID])).not.toThrow()
    expect(() => check('release:start', [ID, { playbookSha256: HASH, forceServiceIds: [ID] }])).not.toThrow()
    expect(() => check('deploy:savePlaybook', [ID, HASH])).not.toThrow()
    expect(() => check('release:savePlaybook', [ID])).not.toThrow()
    expect(() => check('release:break-lock', [ID, ID, { typedLabel: 'app1' }])).not.toThrow()
    expect(() => check('release:list', [{ environmentId: ID, limit: 10 }])).not.toThrow()
    expect(() => check('release:events', [ID, 0, 5000])).not.toThrow()
    expect(() => check('release:active', [])).not.toThrow()
    expect(() => check('release:latest', [])).not.toThrow()
  })

  const bad: [string, unknown[], RegExp][] = [
    ['release:preflight', [{ environmentId: 'x', serviceIds: [ID], bump: 'minor', options: OPTS }], /environmentId/],
    ['release:preflight', [{ environmentId: ID, bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: ['nope'], bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [], checkoutIds: ['nope'], bump: 'minor', options: OPTS }], /checkoutIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: Array(MAX_SERVICES + 1).fill(ID), bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], deploymentIds: [ID], bump: 'minor', options: OPTS }], /deploymentIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'huge', options: OPTS }], /bump/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'none', options: { backup: 1, notify: false, qa: false } }], /options/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'none', options: OPTS, releaseNotes: 5 }], /releaseNotes/],
    ['release:preflight', ['x'], /./],
    ['release:start', ['x', {}], /./],
    ['release:start', [ID, { typedName: 5 }], /typedName/],
    ['release:start', [ID, { redeploy: 'yes' }], /redeploy/],
    ['release:start', [ID, { playbookSha256: 'A'.repeat(64) }], /playbookSha256/],
    ['release:start', [ID, { playbookSha256: 'a'.repeat(63) }], /playbookSha256/],
    ['deploy:previewPlaybook', ['x'], /./],
    ['release:start', [ID, { forceServiceIds: ['x'] }], /forceServiceIds/],
    ['deploy:savePlaybook', [ID, 'nope'], /./],
    ['deploy:savePlaybook', [ID], /./],
    ['release:savePlaybook', ['x'], /./],
    ['release:savePlaybook', [], /./],
    ['release:cancel', [], /./],
    ['release:rollback', [ID, { typedName: {} }], /typedName/],
    ['release:break-lock', [ID, ID, {}], /typedLabel/],
    ['release:break-lock', [ID, 'x', { typedLabel: 'a' }], /./],
    ['release:discard', [5], /./],
    ['release:retry-version', ['x'], /./],
    ['release:list', [{ limit: 0 }], /limit/],
    ['release:list', [{ before: 'x' }], /before/],
    ['release:get', ['x'], /./],
    ['release:events', [ID, -1], /./],
    ['release:events', [ID, 0, 5001], /./],
    ['release:events', [ID, 0, 0], /./],
  ]
  it.each(bad)('%s rejects bad shapes and names the path', (channel, args, path) => {
    expect(() => check(channel, args)).toThrow(path)
  })
})

describe('release handlers', () => {
  it('release:events caps limit at 5000 and defaults to 1000', () => {
    const events = vi.fn(() => [])
    const handlers = createDeployHandlers({ deploys: {} as never, releases: { events } as unknown as ReleaseService, tooling: async () => ({}) as never })
    const h = (handlers as Record<string, unknown>)['release:events'] as (id: string, after: number, limit?: number) => unknown
    h(ID, 3, 5000)
    h(ID, 3, 999999)
    h(ID, 3)
    expect(events.mock.calls).toEqual([
      [ID, 3, MAX_EVENTS_PAGE],
      [ID, 3, MAX_EVENTS_PAGE],
      [ID, 3, 1000],
    ])
    expect(MAX_EVENTS_PAGE).toBe(5000)
  })

  it('release:latest answers from the local releases, and with none when nothing provides them', async () => {
    const row = { id: ID, environmentId: ID, previousCommit: 'a', deployedCommit: 'b' }
    const base = { deploys: {} as never, releases: {} as unknown as ReleaseService, tooling: async () => ({}) as never }
    const h = (x: ReturnType<typeof createDeployHandlers>) => (x as Record<string, unknown>)['release:latest'] as () => unknown
    expect(await h(createDeployHandlers({ ...base, lastReleases: () => [row as never] }))()).toEqual([row])
    expect(await h(createDeployHandlers(base))()).toEqual([])
  })
})

describe('playbook review handlers', () => {
  const PLAYBOOK = '[{"hosts":"od-1"}]'
  /** As `release:get` reads it: redacted again on read. */
  const STORED = '[\n  {\n    "hosts": "od-1",\n    "vars": { "token": "‹redacted›" }\n  }\n]'
  const setup = (over: { path?: string; stored?: string | null; preview?: string; secrets?: string[] } = {}) => {
    const releases = {
      previewPlaybook: vi.fn(async () => ({ playbook: over.preview ?? PLAYBOOK, sha256: HASH })),
      discard: vi.fn(async () => undefined),
      detail: vi.fn(async () => ({ id: ID, playbook: over.stored === undefined ? STORED : over.stored })),
      start: vi.fn(async () => undefined),
    }
    const writes: [string, string][] = []
    const saveDialog = vi.fn(async () => over.path)
    const handlers = createDeployHandlers({
      deploys: {} as never,
      releases: releases as unknown as ReleaseService,
      tooling: async () => ({}) as never,
      playbookFile: { saveDialog, write: async (path, text) => void writes.push([path, text]) },
      knownSecrets: () => over.secrets ?? [],
    })
    return { releases, writes, saveDialog, h: handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> }
  }

  it('release:start refuses a start without a reviewed hash and forwards one with it', async () => {
    const { releases, h } = setup()
    await expect(h['release:start'](ID, {})).rejects.toThrow(REVIEW_REQUIRED_MESSAGE)
    await expect(h['release:start'](ID, { typedName: 'prod' })).rejects.toThrow(REVIEW_REQUIRED_MESSAGE)
    expect(releases.start).not.toHaveBeenCalled()
    await h['release:start'](ID, { playbookSha256: HASH, redeploy: true })
    expect(releases.start).toHaveBeenCalledWith(ID, { playbookSha256: HASH, redeploy: true })
  })

  it('a start refused for another reason keeps the review, so it can still be saved', async () => {
    const { releases, h, writes } = setup({ path: '/tmp/x/review.yml' })
    releases.start.mockRejectedValueOnce(new Error('This release is busy'))
    await h['deploy:previewPlaybook'](ID)
    await expect(h['release:start'](ID, { playbookSha256: HASH })).rejects.toThrow('busy')
    expect(await h['deploy:savePlaybook'](ID, HASH)).toEqual({ path: '/tmp/x/review.yml' })
    expect(writes).toEqual([['/tmp/x/review.yml', PLAYBOOK]])
    await h['release:start'](ID, { playbookSha256: HASH })
    await expect(h['deploy:savePlaybook'](ID, HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
  })

  it('deploy:previewPlaybook returns the preview; deploy:savePlaybook writes only that text where the dialog says', async () => {
    const { h, writes, saveDialog } = setup({ path: '/tmp/x/review.yml' })
    expect(await h['deploy:previewPlaybook'](ID)).toEqual({ playbook: PLAYBOOK, sha256: HASH })
    expect(await h['deploy:savePlaybook'](ID, HASH)).toEqual({ path: '/tmp/x/review.yml' })
    expect(saveDialog).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([['/tmp/x/review.yml', PLAYBOOK]])
  })

  it('the preview and its saved file mask a known secret, also inside a base64 hook off a 3-byte boundary, and keep the reviewed hash', async () => {
    const SECRET = 'hunter2-secret-value'
    const hook = `curl -H "Api-X: ${SECRET}" https://x.example\n`
    expect(hook.indexOf(SECRET) % 3).not.toBe(0)
    const encoded = Buffer.from(hook).toString('base64')
    const preview = JSON.stringify([{ hosts: 'od-1', vars: { url: `https://x.example/?t=${SECRET}` }, tasks: [{ vars: { d: { pre_hook: encoded } } }] }], null, 2)
    const { h, writes, releases } = setup({ path: '/tmp/x/review.yml', preview, secrets: [SECRET] })
    const got = (await h['deploy:previewPlaybook'](ID)) as { playbook: string; sha256: string }
    // The hash stays the one of the text main generated, which start checks against a fresh generation
    expect(got.sha256).toBe(HASH)
    expect(await h['deploy:savePlaybook'](ID, HASH)).toEqual({ path: '/tmp/x/review.yml' })
    expect(writes).toHaveLength(1)
    expect(writes[0]![1]).toBe(got.playbook)
    for (const text of [got.playbook, writes[0]![1]]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(encoded)
      const plays = JSON.parse(text)
      expect(plays[0].vars.url).toBe('https://x.example/?t=‹redacted›')
      expect(Buffer.from(plays[0].tasks[0].vars.d.pre_hook, 'base64').toString('utf8')).toBe('curl -H "Api-X: ‹redacted›" https://x.example\n')
    }
    expect(releases.previewPlaybook).toHaveBeenCalledTimes(1)
  })

  it('a discarded release forgets its review: its preview can no longer be saved', async () => {
    const { h, releases, saveDialog } = setup({ path: '/tmp/x/review.yml' })
    await h['deploy:previewPlaybook'](ID)
    await h['release:discard'](ID)
    expect(releases.discard).toHaveBeenCalledWith(ID)
    await expect(h['deploy:savePlaybook'](ID, HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    expect(saveDialog).not.toHaveBeenCalled()
  })

  it('deploy:savePlaybook refuses a playbook that was not the last one reviewed, and a cancelled dialog writes nothing', async () => {
    const { h, writes, saveDialog } = setup()
    await expect(h['deploy:savePlaybook'](ID, HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    await h['deploy:previewPlaybook'](ID)
    await expect(h['deploy:savePlaybook'](ID, 'b'.repeat(64))).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    await expect(h['deploy:savePlaybook']('0190a1b2-c3d4-7e5f-8a6b-1234567890ac', HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    expect(saveDialog).not.toHaveBeenCalled()
    expect(await h['deploy:savePlaybook'](ID, HASH)).toBeNull()
    expect(writes).toEqual([])
  })

  it('release:savePlaybook writes the stored playbook, as read, where the dialog says', async () => {
    const { h, writes, saveDialog, releases } = setup({ path: '/tmp/x/release.yml' })
    expect(await h['release:savePlaybook'](ID)).toEqual({ path: '/tmp/x/release.yml' })
    expect(releases.detail).toHaveBeenCalledWith(ID)
    expect(saveDialog).toHaveBeenCalledWith(ID)
    expect(writes).toEqual([['/tmp/x/release.yml', STORED]])
  })

  it('release:savePlaybook refuses a release with no stored playbook, and a cancelled dialog writes nothing', async () => {
    const none = setup({ path: '/tmp/x/release.yml', stored: null })
    await expect(none.h['release:savePlaybook'](ID)).rejects.toThrow(PLAYBOOK_NOT_STORED_MESSAGE)
    expect(none.saveDialog).not.toHaveBeenCalled()
    const cancelled = setup()
    expect(await cancelled.h['release:savePlaybook'](ID)).toBeNull()
    expect(cancelled.writes).toEqual([])
  })
  it('release:savePlaybook redacts in main before writing: no known secret or key block reaches the file', async () => {
    const SECRET = 'hunter2-secret-value'
    const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'
    // as a Hub release's detail arrives: nothing on the way redacted it
    const stored = JSON.stringify([{ hosts: 'od-1', tasks: [{ name: `curl https://x.example/?t=${SECRET}` }, { name: 'key', copy: { content: KEY } }] }], null, 2)
    const dir = await mkdtemp(join(tmpdir(), 'opsdeck-save-'))
    try {
      const path = join(dir, 'release.yml')
      const detail = vi.fn(async () => ({ id: ID, playbook: stored }))
      const handlers = createDeployHandlers({
        deploys: {} as never,
        releases: { detail } as unknown as ReleaseService,
        tooling: async () => ({}) as never,
        knownSecrets: () => [SECRET],
        playbookFile: { saveDialog: async () => path, write: (p, text) => writeFile(p, text, 'utf8') },
      })
      const h = handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      expect(await h['release:savePlaybook'](ID)).toEqual({ path })
      const written = await readFile(path, 'utf8')
      expect(written).not.toContain(SECRET)
      expect(written).not.toContain('b3BlbnNzaC1rZXk')
      expect(written).toContain('‹redacted›')
      expect(written).toContain('"hosts": "od-1"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('release:get masks known secret values in main: the stored playbook, the error and the check messages', async () => {
    const SECRET = 'hunter2-secret-value'
    const detail = vi.fn(async () => ({
      id: ID,
      playbook: JSON.stringify([{ hosts: 'od-1', tasks: [{ name: `curl https://x.example/?t=${SECRET}` }] }], null, 2),
      error: `health check failed: GET /?t=${SECRET} 503`,
      preflight: { releaseId: ID, checks: [{ id: 'ssh', label: 'ssh', level: 'block', message: `auth ${SECRET} refused` }] },
      runs: [],
    }))
    const handlers = createDeployHandlers({ deploys: {} as never, releases: { detail } as unknown as ReleaseService, tooling: async () => ({}) as never, knownSecrets: () => [SECRET] })
    const got = (await (handlers as unknown as Record<string, (id: string) => Promise<ReleaseDetail>>)['release:get'](ID))
    expect(JSON.stringify(got)).not.toContain(SECRET)
    expect(got.playbook).toContain('"name": "curl https://x.example/?t=‹redacted›"')
    expect(got.error).toBe('health check failed: GET /?t=‹redacted› 503')
    expect(got.preflight!.checks[0].message).toBe('auth ‹redacted› refused')
    expect(got.id).toBe(ID)
  })
  it('a known secret holding a quote and a backslash is masked as the stored JSON escapes it, in release:get and the saved file', async () => {
    const SECRET = 'p@ss"w\\rd-9x'
    const stored = JSON.stringify([{ hosts: 'od-1', tasks: [{ name: 'health', uri: { url: `https://x.example/?t=${SECRET}` } }] }], null, 2)
    // JSON escapes both characters, so the raw form is not in the text at all
    expect(stored).not.toContain(SECRET)
    expect(stored).toContain('p@ss\\"w\\\\rd-9x')
    const dir = await mkdtemp(join(tmpdir(), 'opsdeck-save-'))
    try {
      const path = join(dir, 'release.yml')
      const handlers = createDeployHandlers({
        deploys: {} as never,
        releases: { detail: vi.fn(async () => ({ id: ID, playbook: stored, error: `GET /?t=${SECRET} 503`, preflight: null, runs: [] })) } as unknown as ReleaseService,
        tooling: async () => ({}) as never,
        knownSecrets: () => [SECRET],
        playbookFile: { saveDialog: async () => path, write: (p, text) => writeFile(p, text, 'utf8') },
      })
      const h = handlers as unknown as Record<string, (id: string) => Promise<unknown>>
      const got = (await h['release:get'](ID)) as ReleaseDetail
      const escaped = JSON.stringify(SECRET).slice(1, -1)
      for (const text of [got.playbook!, JSON.stringify(got)]) {
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain(escaped)
      }
      expect(got.error).toBe('GET /?t=‹redacted› 503')
      expect(JSON.parse(got.playbook!)[0].tasks[0].uri.url).toBe('https://x.example/?t=‹redacted›')
      await h['release:savePlaybook'](ID)
      const written = await readFile(path, 'utf8')
      expect(written).not.toContain(SECRET)
      expect(written).not.toContain(escaped)
      expect(written).toBe(got.playbook)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('a known secret inside a base64 hook, off a 3-byte boundary, is masked in release:get and the saved file', async () => {
    const SECRET = 'hunter2-secret-value'
    const hook = `curl -H "Api-X: ${SECRET}" https://x.example\n`
    const at = hook.indexOf(SECRET)
    expect(at % 3).not.toBe(0)
    const encoded = Buffer.from(hook).toString('base64')
    // Encoding the secret on its own does not find it inside the hook
    expect(encoded).not.toContain(Buffer.from(SECRET).toString('base64'))
    const stored = JSON.stringify([{ hosts: 'od-1', tasks: [{ name: 'pre-hook', vars: { d: { pre_hook: encoded } } }] }], null, 2)
    const dir = await mkdtemp(join(tmpdir(), 'opsdeck-save-'))
    try {
      const path = join(dir, 'release.yml')
      const handlers = createDeployHandlers({
        deploys: {} as never,
        releases: { detail: vi.fn(async () => ({ id: ID, playbook: stored, error: null, preflight: null, runs: [] })) } as unknown as ReleaseService,
        tooling: async () => ({}) as never,
        knownSecrets: () => [SECRET],
        playbookFile: { saveDialog: async () => path, write: (p, text) => writeFile(p, text, 'utf8') },
      })
      const h = handlers as unknown as Record<string, (id: string) => Promise<unknown>>
      const got = (await h['release:get'](ID)) as ReleaseDetail
      await h['release:savePlaybook'](ID)
      const written = await readFile(path, 'utf8')
      expect(written).toBe(got.playbook)
      for (const text of [got.playbook!, written]) {
        expect(text).not.toContain(encoded)
        const b64 = JSON.parse(text)[0].tasks[0].vars.d.pre_hook as string
        expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('curl -H "Api-X: ‹redacted›" https://x.example\n')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('release:events masks known secret values in main, as a Hub release sends its events unmasked', async () => {
    const SECRET = 'hunter2-secret-value'
    const raw = [{ id: 'e1', runId: ID, seq: 1, at: 'now', type: 'log', stepId: 'r1:health', hostId: 'h1', stream: 'out', line: `GET /?t=${SECRET}` }]
    const handlers = createDeployHandlers({ deploys: {} as never, releases: { events: vi.fn(async () => raw) } as unknown as ReleaseService, tooling: async () => ({}) as never, knownSecrets: () => [SECRET] })
    const got = await (handlers as unknown as Record<string, (id: string, after: number) => Promise<unknown>>)['release:events'](ID, 0)
    expect(got).toEqual([{ ...raw[0], line: 'GET /?t=‹redacted›' }])
  })
  it('release:list and release:active mask a known secret in a Hub summary error, and leave its ids and times', async () => {
    const SECRET = 'hunter2-secret-value'
    const hub = { id: ID, environmentId: ID, status: 'failed', startedAt: '2026-10-21T18:00:00.000Z', error: `health failed: GET /?t=${SECRET} 503` }
    const handlers = createDeployHandlers({
      deploys: {} as never,
      releases: { list: vi.fn(async () => [hub]), listActive: vi.fn(async () => [hub]) } as unknown as ReleaseService,
      tooling: async () => ({}) as never,
      knownSecrets: () => [SECRET],
    })
    const h = handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const want = [{ ...hub, error: 'health failed: GET /?t=‹redacted› 503' }]
    expect(await h['release:list']({})).toEqual(want)
    expect(await h['release:active']()).toEqual(want)
  })
})

describe('runbook and operation channels', () => {
  const RB = { environmentId: ID, name: 'Bounce', description: '', targetServiceIds: [ID], items: [{ type: 'builtin', builtin: 'logs', tail: 50 }], params: [], lock: false, notify: false }
  const OP = { environmentId: ID, runbookId: ID, serviceIds: [ID], params: { target: 'blue' } }

  it('validators accept well-formed arguments', () => {
    expect(() => check('runbook:list', [ID])).not.toThrow()
    expect(() => check('runbook:save', [RB])).not.toThrow()
    expect(() => check('runbook:save', [{ ...RB, id: ID }])).not.toThrow()
    expect(() => check('runbook:delete', [ID])).not.toThrow()
    expect(() => check('release:preflightOperation', [OP])).not.toThrow()
    expect(() => check('release:preflightOperation', [{ ...OP, params: {} }])).not.toThrow()
    expect(() => check('release:list', [{ operations: 'only' }])).not.toThrow()
    expect(() => check('release:list', [{ operations: 'exclude' }])).not.toThrow()
  })

  const bad: [string, unknown[], RegExp][] = [
    ['runbook:list', ['x'], /./],
    ['runbook:delete', [], /./],
    ['runbook:save', [{ ...RB, environmentId: 'x' }], /environmentId/],
    ['runbook:save', [{ ...RB, id: 'x' }], /id/],
    ['runbook:save', [{ ...RB, name: 5 }], /name/],
    ['runbook:save', [{ ...RB, targetServiceIds: ['x'] }], /targetServiceIds/],
    ['runbook:save', [{ ...RB, items: 'restart' }], /items/],
    ['runbook:save', [{ ...RB, lock: 'no' }], /lock/],
    ['runbook:save', [{ ...RB, script: 'rm -rf /' }], /script/],
    ['release:preflightOperation', [{ ...OP, runbookId: 'x' }], /runbookId/],
    ['release:preflightOperation', [{ ...OP, serviceIds: ['x'] }], /serviceIds/],
    ['release:preflightOperation', [{ ...OP, params: { 'Bad-Name': 'x' } }], /params/],
    ['release:preflightOperation', [{ ...OP, params: { target: 5 } }], /params/],
    ['release:preflightOperation', [{ ...OP, params: { target: 'x'.repeat(1001) } }], /params/],
    ['release:list', [{ operations: 'some' }], /operations/],
  ]
  it.each(bad)('%s rejects bad shapes and names the path', (channel, args, path) => {
    expect(() => check(channel, args)).toThrow(path)
  })

  it('runbook:save creates or updates through the store and refuses an invalid runbook with VALIDATION', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input({ name: 'api', repoPath: '/srv/api', deployTag: 'deploy_api' }))
    const s = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'api', deploymentId: d.id })
    const runbooks = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
    const preflightOperation = vi.fn(async () => ({ releaseId: ID }))
    const h = createDeployHandlers({ deploys: {} as never, releases: { preflightOperation } as unknown as ReleaseService, tooling: async () => ({}) as never, runbooks }) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const input = { ...RB, environmentId: f.staging.id, targetServiceIds: [s.id] }
    const made = (await h['runbook:save'](input)) as { id: string; name: string }
    expect(made.name).toBe('Bounce')
    const renamed = (await h['runbook:save']({ ...input, id: made.id, name: 'Logs' })) as { id: string; name: string }
    expect(renamed).toMatchObject({ id: made.id, name: 'Logs' })
    expect(((await h['runbook:list'](f.staging.id)) as { id: string }[]).map((x) => x.id)).toEqual([made.id])
    for (const wrong of [{ ...input, name: '' }, { ...input, items: [] }, { ...input, items: [{ type: 'builtin', builtin: 'explode' }] }]) {
      const err = await h['runbook:save'](wrong).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('VALIDATION')
    }
    expect(await h['release:preflightOperation'](OP)).toEqual({ releaseId: ID })
    expect(preflightOperation).toHaveBeenCalledWith(OP)
    await h['runbook:delete'](made.id)
    expect(await h['runbook:list'](f.staging.id)).toEqual([])
  })
})
