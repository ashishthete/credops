import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnthropicLike } from '../../src/main/ai/claude'
import { FakeRunner, A } from '../../tests/main/fake-runner'
import { testHub, type TestHub } from './helpers'
import { ENV_ID, HOST_ID, DEP_WEB, SECRET_DB, deployment, manifest } from './manifest'

let hub: TestHub
afterEach(async () => hub?.close())

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob Builder' }
const SVC = '71111111-1111-4111-8111-111111111111'

const WEBHOOK = 'https://hooks.example.com/webhook/SECRET-WEBHOOK-TOKEN-8842'
const SENDGRID = 'SG.sendgrid-key-sentinel-77123'
const ANTHROPIC = 'sk-ant-api03-hubkeysentinel0123456789'
const ENV_VALUE = 'env-secret-sentinel-4455'
const GITHUB = 'ghp_hubgithubsentinel0123456789abcdef'

const call = (token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })

interface Posted {
  url: string
  body: string
}

function stubFetch(posts: Posted[], status = 200, onCall?: (url: string) => void) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    onCall?.(String(url))
    posts.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
    return new Response('ok', { status })
  }) as unknown as typeof fetch
}

const claudeStub = (text: string) => {
  const stream = vi.fn(() => {
    const final = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    return {
      on: () => undefined,
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
      },
      finalMessage: async () => final,
    }
  })
  return { stream, factory: () => ({ beta: { messages: { create: vi.fn(), stream } } }) as unknown as AnthropicLike }
}

async function setup(o: { env?: string; events?: string[]; webhook?: boolean; anthropic?: boolean; fetchStatus?: number; claude?: ReturnType<typeof claudeStub>; qa?: boolean; onFetch?: (url: string) => void } = {}) {
  const posts: Posted[] = []
  const fr = new FakeRunner()
  const claude = o.claude ?? claudeStub('Release notes written by the stub model.')
  hub = await testHub(
    { sendgridFrom: 'deploys@example.com' },
    { runner: fr, notify: { fetch: stubFetch(posts, o.fetchStatus, o.onFetch), sleep: async () => undefined, claudeFactory: claude.factory } },
  )
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const m = manifest()
  m.environment = { ...m.environment, name: o.env ?? 'prod', protected: false }
  m.deployments = [deployment(DEP_WEB, 'web', { envTemplate: `DB_PASSWORD=\${secret:${SECRET_DB}}\n` })]
  m.services = [{ id: SVC, name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: DEP_WEB, hostId: HOST_ID, viaHostId: null }]
  m.requiredSecrets = [{ secretId: SECRET_DB, name: 'DB_PASSWORD', usedBy: ['web'] }]
  m.integrations = { notifyEvents: o.events ?? ['release.succeeded', 'release.failed'], emailTo: ['ops@example.com'], emailCc: [], qaOnDeploy: o.qa === true, qa: o.qa ? { repo: 'acme/web', workflow: 'qa.yml', ref: 'main' } : null, qaWait: false }
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, m)).statusCode).toBe(200)
  expect((await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)).statusCode).toBe(200)
  const put = async (path: string, body: object) => expect((await call(admin, 'PUT', path, body)).statusCode).toBe(204)
  await put(`/api/v1/admin/secrets/${SECRET_DB}`, { environmentId: ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: ENV_VALUE })
  if (o.webhook !== false) await put('/api/v1/admin/secrets/61111111-1111-4111-8111-111111111111', { environmentId: ENV_ID, name: 'teams', kind: 'teams_webhook', value: WEBHOOK })
  await put('/api/v1/admin/secrets/62222222-2222-4222-8222-222222222222', { environmentId: null, name: 'sendgrid', kind: 'sendgrid_api_key', value: SENDGRID })
  if (o.anthropic !== false) await put('/api/v1/admin/secrets/63333333-3333-4333-8333-333333333333', { environmentId: null, name: 'anthropic', kind: 'anthropic_api_key', value: ANTHROPIC })
  if (o.qa) await put('/api/v1/admin/secrets/64444444-4444-4444-8444-444444444444', { environmentId: null, name: 'github', kind: 'github_token', value: GITHUB })
  const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Ops' })).json().id as string
  await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
  await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })
  return { fr, posts, bob, admin, claude }
}

async function release(bob: string, fr: FakeRunner, qa = false): Promise<string> {
  const pre = await call(bob, 'POST', '/api/v1/releases/preflight', {
    environmentId: ENV_ID,
    serviceIds: [SVC],
    bump: 'none',
    options: { backup: false, notify: true, qa },
  })
  expect(pre.statusCode, pre.body).toBe(201)
  const id = pre.json().releaseId as string
  await hub.app.releases.whenIdle()
  expect((await call(bob, 'POST', `/api/v1/releases/${id}/start`, {})).statusCode).toBe(204)
  await hub.app.releases.whenIdle()
  expect(fr.kinds).toContain('release')
  return id
}

const cards = (posts: Posted[]) => posts.filter((p) => p.url === WEBHOOK)
const everything = () =>
  JSON.stringify([
    hub.audit.list({ limit: 1000 }),
    hub.db.prepare('SELECT * FROM notification_log').all(),
    hub.db.prepare('SELECT * FROM run_events').all(),
    hub.db.prepare('SELECT * FROM releases').all(),
    hub.logs,
  ])

describe('hub notifications', () => {
  it("success posts one Teams card with Hub facts and the actor's name", async () => {
    const { fr, posts, bob } = await setup()
    const id = await release(bob, fr)
    const sent = cards(posts)
    expect(sent.length).toBe(1)
    expect(sent[0]!.body).toContain('prod')
    expect(sent[0]!.body).toContain('Bob Builder@')
    expect(sent[0]!.body).not.toContain('bob@example.com')
    const log = hub.db.prepare("SELECT * FROM notification_log WHERE source_id = ? AND channel = 'teams'").all(id) as { status: string }[]
    expect(log.map((r) => r.status)).toEqual(['sent'])
    const sentAudit = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'notify.sent')
    expect(sentAudit.length).toBeGreaterThan(0)
    expect(sentAudit.map((e) => e.details)).toContainEqual({ channel: 'teams', releaseId: id })
  })

  it('retrying finalize does not double-post', async () => {
    const { fr, posts, bob } = await setup()
    const id = await release(bob, fr)
    expect(cards(posts).length).toBe(1)
    const meta = hub.app.releases.service.runMeta(id)!
    const ctx = { run: meta, signal: new AbortController().signal, log: () => undefined }
    const steps = (hub.app.releases.service as unknown as { d: { finalize: { notify(c: unknown): Promise<void> } } }).d.finalize
    await steps.notify(ctx)
    expect(cards(posts).length).toBe(1)
  })

  it('no anthropic key uses fallback notes', async () => {
    const claude = claudeStub('should never be used')
    const { fr, bob } = await setup({ anthropic: false, claude })
    fr.commitsTotal = 1
    // The fake runner reports no commits, so give every run one as it is created.
    const commits = JSON.stringify([{ sha: A, subject: 'Fix the invoice rounding', author: 'dev', date: '2026-10-01T00:00:00Z', deploymentId: DEP_WEB }])
    hub.db.exec(`CREATE TRIGGER seed_commits AFTER INSERT ON deployment_runs BEGIN UPDATE deployment_runs SET commits = '${commits.replaceAll("'", "''")}' WHERE id = NEW.id; END`)
    const id = await release(bob, fr)
    expect(claude.stream).not.toHaveBeenCalled()
    const res = (await call(bob, 'GET', `/api/v1/releases/${id}`)).json()
    expect(res.status).toBe('succeeded')
    expect(JSON.stringify(res)).not.toContain('should never be used')
    const notes = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'ai.release_notes')
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.map((e) => (e.details as { source?: string }).source)).toContain('fallback')
  })

  it('the webhook URL and API keys never appear in audit, events or errors', async () => {
    const { fr, posts, bob, claude } = await setup()
    const id = await release(bob, fr)
    expect(cards(posts).length).toBe(1)
    // Outbound bodies and the model prompt carry no secret either.
    const outbound = JSON.stringify(posts.map((p) => p.body)) + JSON.stringify(claude.stream.mock.calls)
    for (const s of ['SECRET-WEBHOOK-TOKEN-8842', SENDGRID, ANTHROPIC, ENV_VALUE]) expect(outbound).not.toContain(s)
    const dump = everything() + (await call(bob, 'GET', `/api/v1/releases/${id}/events`)).body + (await call(bob, 'GET', `/api/v1/releases/${id}`)).body
    for (const s of [WEBHOOK, 'SECRET-WEBHOOK-TOKEN-8842', SENDGRID, ANTHROPIC, ENV_VALUE]) expect(dump).not.toContain(s)
  })

  it('a failing webhook is audited without its URL', async () => {
    const { fr, bob } = await setup({ fetchStatus: 500 })
    await release(bob, fr)
    const failed = hub.audit.list({ limit: 1000 }).filter((e) => e.action === 'notify.failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(everything()).not.toContain('SECRET-WEBHOOK-TOKEN-8842')
  })

  it('failure notifications follow the subscribed events, on prod and dev named environments', async () => {
    const failing = (fr: FakeRunner) => {
      fr.on.release = () => ({ exitCode: 1, failedDeploymentRunIds: [], commits: { x: { previous: A } } as never })
    }
    const a = await setup({ events: ['release.failed'] })
    failing(a.fr)
    await release(a.bob, a.fr)
    expect(cards(a.posts).length).toBe(1)
    expect(cards(a.posts)[0]!.body).toContain('prod')
    await hub.close()

    const b = await setup({ events: ['release.succeeded'] })
    failing(b.fr)
    await release(b.bob, b.fr)
    expect(cards(b.posts).length).toBe(0)
    await hub.close()

    const c = await setup({ events: ['release.failed', 'bogus.event'] })
    failing(c.fr)
    await release(c.bob, c.fr)
    expect(cards(c.posts).length).toBe(1)
    await hub.close()

    const d = await setup({ env: 'dev-sandbox', events: ['release.failed'] })
    failing(d.fr)
    await release(d.bob, d.fr)
    expect(cards(d.posts).length).toBe(1)
    expect(cards(d.posts)[0]!.body).toContain('dev-sandbox')
  })

  it('the GitHub token is masked while a QA dispatch is in flight and is not held afterwards', async () => {
    const seen: string[][] = []
    const { fr, posts, bob } = await setup({ qa: true, onFetch: (url) => { if (url.includes('api.github.com')) seen.push(hub.app.releases.knownSecrets()) } })
    await release(bob, fr, true)
    expect(posts.some((p) => p.url.includes('/workflows/qa.yml/dispatches'))).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    for (const known of seen) expect(known).toContain(GITHUB)
    expect(JSON.stringify(posts)).not.toContain(GITHUB)
    expect(everything()).not.toContain(GITHUB)
  })

  it('rejects a Teams webhook that is not an https URL, without echoing it', async () => {
    const { admin } = await setup({ webhook: false })
    for (const bad of ['not a url SECRET-BAD-VALUE', 'http://hooks.example.com/SECRET-BAD-VALUE', 'ftp://x/SECRET-BAD-VALUE']) {
      const r = await call(admin, 'PUT', '/api/v1/admin/secrets/65555555-5555-4555-8555-555555555555', { environmentId: ENV_ID, name: 'teams', kind: 'teams_webhook', value: bad })
      expect(r.statusCode).toBe(400)
      expect(r.body).not.toContain('SECRET-BAD-VALUE')
    }
    expect((await call(admin, 'PUT', '/api/v1/admin/secrets/65555555-5555-4555-8555-555555555555', { environmentId: ENV_ID, name: 'teams', kind: 'teams_webhook', value: WEBHOOK })).statusCode).toBe(204)
  })
})
