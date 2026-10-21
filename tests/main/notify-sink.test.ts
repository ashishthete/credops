import { describe, expect, it, vi } from 'vitest'
import { createNotifyHandlers } from '../../src/main/ipc/handlers/notify'
import type { Fetch } from '../../src/main/notify/http'
import { MacNotifier, type NotificationCtor } from '../../src/main/notify/macos'
import { LocalSink } from '../../src/main/notify/sink'
import type { NotificationFacts } from '../../src/main/notify/teams'
import { IntegrationStore } from '../../src/main/settings/integration-store'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeInventory } from './inventory-helpers'
import { auditRows } from './vault-helpers'

const HOOK = 'https://x.webhook.office.com/abc/SECRETPATH'

function fakeNotification(supported = true) {
  const shown: { title: string; body: string; silent?: boolean; click: () => void }[] = []
  class FakeNotification {
    static isSupported = () => supported
    private readonly handlers: Record<string, () => void> = {}
    constructor(private readonly opts: { title: string; body: string; silent?: boolean }) {}
    on(ev: 'click' | 'close', fn: () => void) {
      this.handlers[ev] = fn
      return this
    }
    show() {
      shown.push({ ...this.opts, click: () => this.handlers.click?.() })
    }
  }
  return { Ctor: FakeNotification as unknown as NotificationCtor, shown }
}

const facts = (over: Partial<NotificationFacts> = {}): NotificationFacts => ({
  event: 'release.failed',
  title: 'shop failed on prod',
  environment: { name: 'prod', color: '#ef4444', protected: true },
  product: 'shop',
  deployment: 'web',
  hosts: ['web-1'],
  status: 'failed',
  version: '1.4.0',
  durationSec: 65,
  urls: [],
  actor: 'ashish@mbp',
  at: '2026-10-19T10:00:00.000Z',
  ...over,
})

async function setup(fetchImpl: () => Promise<Response> = async () => new Response(null, { status: 200 })) {
  const f = await makeInventory()
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const settings = new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const integrations = new IntegrationStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const fetch = vi.fn(fetchImpl)
  const mac = fakeNotification()
  const clicks: string[] = []
  const notifier = new MacNotifier({ Notification: mac.Ctor, onClick: (r) => clicks.push(r), enabled: () => settings.get().macos })
  const sink = new LocalSink({
    secrets,
    settings,
    integrations,
    fetch: fetch as unknown as Fetch,
    sleep: async () => {},
    notifier,
    knownSecrets: () => [...secrets.knownValues()],
  })
  const env = f.envs.create({ name: 'prod', color: '#ef4444' })
  const handlers = createNotifyHandlers({
    db: f.db,
    sink,
    settings,
    integrations,
    mac: notifier,
    audit: f.audit,
    actor: { osUser: 'ashish', machine: 'mbp' },
    now: () => new Date('2026-10-19T10:00:00.000Z'),
  })
  return { f, secrets, settings, integrations, fetch, mac, clicks, notifier, sink, env, handlers }
}

describe('MacNotifier', () => {
  it('macos shows title and routes click', async () => {
    const { notifier, mac, clicks } = await setup()
    notifier.show(facts(), '#/deployments/release/r1')
    expect(mac.shown).toHaveLength(1)
    expect(mac.shown[0]).toMatchObject({ title: 'prod · web failed', body: '1.4.0 · 1m 05s', silent: false })
    mac.shown[0]!.click()
    expect(clicks).toEqual(['#/deployments/release/r1'])
    notifier.show(facts({ status: 'succeeded', deployment: null, title: 'db tunnel', version: null, durationSec: null }), '#/tunnels?focus=t1')
    expect(mac.shown[1]).toMatchObject({ title: 'prod · db tunnel succeeded', body: '', silent: true })
  })

  it('macos no-op when unsupported or disabled', async () => {
    const off = fakeNotification(false)
    new MacNotifier({ Notification: off.Ctor, onClick: () => {}, enabled: () => true }).show(facts(), '#/')
    expect(off.shown).toHaveLength(0)
    const on = fakeNotification(true)
    const n = new MacNotifier({ Notification: on.Ctor, onClick: () => {}, enabled: () => false })
    n.show(facts(), '#/')
    expect(on.shown).toHaveLength(0)
    expect(n.supported()).toBe(true)
  })
})

describe('notify:test', () => {
  it('test send to teams uses the env webhook secret and audits', async () => {
    const { secrets, integrations, env, handlers, fetch, f } = await setup()
    const hook = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'prod teams', kind: 'webhook', value: HOOK })
    integrations.update(env.id, { teamsWebhookSecretId: hook.id })
    await handlers['notify:test']({ channel: 'teams', environmentId: env.id })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(HOOK)
    expect(String(init.body)).toContain('Test from OpsDeck')
    const [ev] = f.audit.list({ actions: ['notify.test'] })
    expect(ev).toMatchObject({ outcome: 'success', targetType: 'environment', targetId: env.id, details: { channel: 'teams' } })
    expect(auditRows(f.db)).not.toContain('SECRETPATH')
  })

  it('test send without a webhook fails with "No Teams webhook set for <env>"', async () => {
    const { env, handlers, fetch, f } = await setup()
    await expect(handlers['notify:test']({ channel: 'teams', environmentId: env.id })).rejects.toThrow('No Teams webhook set for prod')
    expect(fetch).not.toHaveBeenCalled()
    const [ev] = f.audit.list({ actions: ['notify.test'] })
    expect(ev).toMatchObject({ outcome: 'failure', details: { channel: 'teams', reason: 'No Teams webhook set for prod' } })
  })

  it('test email needs a key, a from address and recipients', async () => {
    const { env, handlers, secrets, settings, integrations, fetch } = await setup(async () => new Response(null, { status: 202 }))
    await expect(handlers['notify:test']({ channel: 'email', environmentId: env.id })).rejects.toThrow('No SendGrid API key set')
    const key = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sg', kind: 'api_key', value: 'SG.abcdefghijklmnop1234.qrstuvwxyz0123456789' })
    settings.update({ sendgridApiKeySecretId: key.id, sendgridFrom: 'ops@acme.example' })
    await expect(handlers['notify:test']({ channel: 'email', environmentId: env.id })).rejects.toThrow('No email recipients set for prod')
    integrations.update(env.id, { emailTo: ['qa@acme.example'] })
    await handlers['notify:test']({ channel: 'email', environmentId: env.id })
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.subject).toBe('Test from OpsDeck')
  })

  it('test macOS alert shows and fails when off', async () => {
    const { handlers, mac, settings } = await setup()
    await handlers['notify:test']({ channel: 'macos' })
    expect(mac.shown[0]!.title).toBe('Test from OpsDeck')
    settings.update({ macos: false })
    await expect(handlers['notify:test']({ channel: 'macos' })).rejects.toThrow('macOS notifications are turned off')
  })

  it('sink never returns or throws the secret', async () => {
    const { secrets, integrations, env, sink } = await setup(async () => {
      throw new TypeError(`getaddrinfo ENOTFOUND ${HOOK}`)
    })
    const hook = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'prod teams', kind: 'webhook', value: HOOK })
    integrations.update(env.id, { teamsWebhookSecretId: hook.id })
    const out = await sink.teams(env.id, facts()).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(Error)
    const e = out as Error
    expect(e.message).toBe('Teams webhook could not be reached')
    for (const s of [e.message, String(e), JSON.stringify(e), String(e.stack)]) expect(s).not.toContain('SECRETPATH')
    const ok = await setup()
    const h2 = ok.secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 't', kind: 'webhook', value: HOOK })
    ok.integrations.update(ok.env.id, { teamsWebhookSecretId: h2.id })
    expect(await ok.sink.teams(ok.env.id, facts())).toBeUndefined()
  })
})

describe('notify:log', () => {
  it('lists newest first with filters and a limit', async () => {
    const { f, handlers } = await setup()
    const ins = f.db.prepare('INSERT INTO notification_log(id, at, source_type, source_id, event, channel, status, detail) VALUES (?,?,?,?,?,?,?,?)')
    ins.run('a', '2026-10-19T09:00:00.000Z', 'release', 'r1', 'release.failed', 'teams', 'sent', null)
    ins.run('b', '2026-10-19T09:05:00.000Z', 'release', 'r1', 'release.failed', 'macos', 'sent', null)
    ins.run('c', '2026-10-19T09:10:00.000Z', 'tunnel', 't1', 'tunnel.failed', 'teams', 'failed', 'Teams webhook failed (HTTP 500)')
    expect((await handlers['notify:log']({})).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(await handlers['notify:log']({ sourceType: 'tunnel' })).toEqual([
      { id: 'c', at: '2026-10-19T09:10:00.000Z', sourceType: 'tunnel', sourceId: 't1', event: 'tunnel.failed', channel: 'teams', status: 'failed', detail: 'Teams webhook failed (HTTP 500)' },
    ])
    expect((await handlers['notify:log']({ sourceId: 'r1', limit: 1 })).map((r) => r.id)).toEqual(['b'])
  })

  it('filters to one environment through its releases and tunnels', async () => {
    const { f, handlers, env } = await setup()
    const other = f.envs.create({ name: 'staging', color: '#22c55e' })
    const host = f.hosts.create({ label: 'app1', address: '10.0.0.7' })
    const now = '2026-10-19T09:00:00.000Z'
    const rel = f.db.prepare("INSERT INTO releases(id, environment_id, kind, status, triggered_by, created_at) VALUES (?,?,'release','failed','t',?)")
    rel.run('r-prod', env.id, now)
    rel.run('r-stg', other.id, now)
    const tun = f.db.prepare("INSERT INTO tunnels(id, label, host_id, environment_id, type, bind_port, created_at, updated_at) VALUES (?,?,?,?,'D',1080,?,?)")
    const T_PROD = '0190a1b2-c3d4-7e5f-8a6b-000000000001'
    const T_STG = '0190a1b2-c3d4-7e5f-8a6b-000000000002'
    tun.run(T_PROD, 'db', host.id, env.id, now, now)
    tun.run(T_STG, 'db2', host.id, other.id, now, now)
    const ins = f.db.prepare('INSERT INTO notification_log(id, at, source_type, source_id, event, channel, status, detail) VALUES (?,?,?,?,?,?,?,?)')
    ins.run('a', '2026-10-19T09:00:00.000Z', 'release', 'r-prod', 'release.failed', 'teams', 'sent', null)
    ins.run('b', '2026-10-19T09:01:00.000Z', 'release', 'r-stg', 'release.failed', 'teams', 'sent', null)
    ins.run('c', '2026-10-19T09:02:00.000Z', 'tunnel', `${T_PROD}@2026-10-19T09:02:00.000Z`, 'tunnel.failed', 'teams', 'failed', null)
    ins.run('d', '2026-10-19T09:03:00.000Z', 'tunnel', `${T_STG}@2026-10-19T09:03:00.000Z`, 'tunnel.failed', 'teams', 'sent', null)
    expect((await handlers['notify:log']({ environmentId: env.id })).map((r) => r.id)).toEqual(['c', 'a'])
  })
})

describe('notify validators', async () => {
  const { VALIDATORS } = await import('../../src/main/ipc/validators')
  const check = (channel: string, a: unknown[]) => (VALIDATORS as Record<string, (x: unknown[]) => unknown>)[channel]!(a)
  const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
  it('accepts good targets and rejects bad shapes naming the path', () => {
    expect(() => check('notify:test', [{ channel: 'teams', environmentId: ID }])).not.toThrow()
    expect(() => check('notify:test', [{ channel: 'macos' }])).not.toThrow()
    expect(() => check('notify:test', [{ channel: 'teams' }])).toThrow(/environmentId/)
    expect(() => check('notify:test', [{ channel: 'sms', environmentId: ID }])).toThrow(/channel/)
    expect(() => check('notify:log', [{ sourceType: 'release', limit: 10 }])).not.toThrow()
    expect(() => check('notify:log', [{ sourceType: 'nope' }])).toThrow(/sourceType/)
    expect(() => check('notify:log', [{ limit: 201 }])).toThrow(/limit/)
    expect(() => check('notify:log', [{ environmentId: ID }])).not.toThrow()
    expect(() => check('notify:log', [{ environmentId: 'x' }])).toThrow(/environmentId/)
  })
})
