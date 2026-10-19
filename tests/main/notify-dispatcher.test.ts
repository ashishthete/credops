import { describe, expect, it } from 'vitest'
import { noopFinalize, type FinalizeSteps, type ReleaseRunMeta } from '../../src/main/deploy/finalize'
import { NotificationDispatcher } from '../../src/main/notify/dispatcher'
import { createFinalizeSteps } from '../../src/main/notify/finalize'
import { IntegrationError } from '../../src/main/notify/http'
import type { NotificationSink } from '../../src/main/notify/sink'
import type { NotificationFacts } from '../../src/main/notify/teams'
import { IntegrationStore } from '../../src/main/settings/integration-store'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import type { RunEvent, RunEventBody } from '../../src/shared/deploy'
import { NOTIFY_EVENTS, type NotificationRecord, type NotifyEventKey } from '../../src/shared/settings'
import type { TunnelEvent } from '../../src/shared/tunnels'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'
import { ready, rig } from './release-rig'
import { auditRows } from './vault-helpers'

const HOOK = 'https://x.webhook.office.com/abc/SECRETPATH'
const SG_KEY = 'SG.sendgrid-key-value-123'
const T0 = Date.parse('2026-10-19T12:00:00Z')

class FakeSink implements NotificationSink {
  calls: string[] = []
  facts: NotificationFacts[] = []
  notes: (string | null)[] = []
  fail: Partial<Record<'teams' | 'email', Error>> = {}
  async teams(_env: string, f: NotificationFacts): Promise<void> {
    this.calls.push(`teams:${f.event}`)
    this.facts.push(f)
    if (this.fail.teams) throw this.fail.teams
  }
  async email(_env: string, f: NotificationFacts, notes: string | null): Promise<void> {
    this.calls.push(`email:${f.event}`)
    this.notes.push(notes)
    if (this.fail.email) throw this.fail.email
  }
  macos(f: NotificationFacts, route: string): void {
    this.calls.push(`macos:${f.event}`)
    this.facts.push(f)
    void route
  }
}

function stores(f: DeployFixture) {
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const settings = new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const integrations = new IntegrationStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const hook = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'hook', kind: 'webhook', value: HOOK })
  const sg = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sg', kind: 'api_key', value: SG_KEY })
  return { secrets, settings, integrations, hook, sg }
}

async function setup(events: NotifyEventKey[] = [...NOTIFY_EVENTS]) {
  const f = await makeDeployFixture()
  const s = stores(f)
  s.integrations.update(f.staging.id, { teamsWebhookSecretId: s.hook.id, notifyEvents: events })
  const runs = new Map<string, ReleaseRunMeta>()
  const sink = new FakeSink()
  const clock = { t: T0 }
  const sent: NotificationRecord[] = []
  const make = () => {
    const d = new NotificationDispatcher({
      db: f.db,
      sink,
      integrations: s.integrations,
      settings: s.settings,
      vault: f.vault,
      audit: f.audit,
      runs: { runMeta: (id, status) => ({ ...runs.get(id)!, ...(status ? { status } : {}) }) },
      tunnels: f.tunnels,
      now: () => new Date(clock.t),
      knownSecrets: () => s.secrets.knownValues(),
    })
    d.onSent((r) => void sent.push(r))
    return d
  }
  const meta = (id: string, over: Partial<ReleaseRunMeta> = {}): ReleaseRunMeta => {
    const m: ReleaseRunMeta = {
      id,
      releaseId: id,
      kind: 'release',
      status: 'running',
      environmentId: f.staging.id,
      environmentName: 'staging',
      productId: null,
      productName: 'shop',
      deployments: [{ id: 'd1', name: 'api', hostId: f.host.id, hostLabel: 'app1', status: 'succeeded', previousCommit: null, deployedCommit: null }],
      hostIds: [f.host.id],
      version: '1.2.0',
      previousVersion: '1.1.0',
      commits: [],
      options: { backup: true, notify: true, qa: false },
      releaseNotes: null,
      redeploy: false,
      startedAt: '2026-10-19T11:58:00.000Z',
      finishedAt: '2026-10-19T12:00:05.000Z',
      actor: { osUser: 'tester', machine: 'box' },
      urls: ['https://shop.example/'],
      ...over,
    }
    runs.set(id, m)
    return m
  }
  let seq = 0
  const ev = (runId: string, body: RunEventBody): RunEvent => ({ id: `e${++seq}`, runId, seq, at: new Date(clock.t).toISOString(), ...body })
  const rows = () =>
    f.db.prepare('SELECT source_id, event, channel, status, detail FROM notification_log ORDER BY at, channel').all() as unknown as {
      source_id: string
      event: string
      channel: string
      status: string
      detail: string | null
    }[]
  return { f, ...s, sink, clock, sent, make, d: make(), meta, ev, rows }
}

describe('NotificationDispatcher', () => {
  it('run started → teams + macos when selected', async () => {
    const t = await setup()
    t.meta('rel-1')
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.started', kind: 'release', version: '1.2.0' }))
    expect(t.sink.calls.sort()).toEqual(['macos:release.started', 'teams:release.started'])
    const card = t.sink.facts.find((x) => x.event === 'release.started')!
    expect(card).toMatchObject({ status: 'started', deployment: 'api', hosts: ['app1'], product: 'shop', version: '1.2.0', actor: 'tester@box' })
    expect(card.environment).toEqual({ name: 'staging', color: '#112233', protected: false })
    expect(t.rows().map((r) => `${r.channel}:${r.status}`).sort()).toEqual(['macos:sent', 'teams:sent'])
    expect(t.sent.map((r) => r.channel).sort()).toEqual(['macos', 'teams'])
    // A rollback's start is not news.
    t.meta('rel-2', { kind: 'rollback' })
    await t.d.onRunEvent(t.ev('rel-2', { type: 'run.started', kind: 'rollback', version: null }))
    expect(t.sink.calls).toHaveLength(2)
  })

  it('filters by environment notify_events', async () => {
    const t = await setup(['release.failed'])
    t.meta('rel-1')
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.started', kind: 'release', version: '1.2.0' }))
    expect(t.sink.calls).toEqual([])
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.finished', status: 'failed', error: 'boom' }))
    expect(t.sink.calls.sort()).toEqual(['macos:release.failed', 'teams:release.failed'])
    // Cancelled is never sent.
    t.meta('rel-2')
    await t.d.onRunEvent(t.ev('rel-2', { type: 'run.finished', status: 'cancelled' }))
    expect(t.sink.calls).toHaveLength(2)
  })

  it('options.notify false → macos only', async () => {
    const t = await setup()
    t.meta('rel-1', { options: { backup: true, notify: false, qa: false } })
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.finished', status: 'rolled_back' }))
    expect(t.sink.calls).toEqual(['macos:release.rolled_back'])
  })

  it('succeeded is sent from finalize, not from run.finished', async () => {
    const t = await setup()
    t.settings.update({ sendgridApiKeySecretId: t.sg.id, sendgridFrom: 'ops@example.com' })
    t.integrations.update(t.f.staging.id, { emailTo: ['team@example.com'] })
    const m = t.meta('rel-1', { status: 'succeeded' })
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.finished', status: 'succeeded' }))
    expect(t.sink.calls).toEqual([])
    const out = await t.d.notifyRunSucceeded(m, '## Notes')
    expect(t.sink.calls.sort()).toEqual(['email:release.succeeded', 'macos:release.succeeded', 'teams:release.succeeded'])
    expect(t.sink.notes).toEqual(['## Notes'])
    expect(out.map((o) => `${o.channel}:${o.status}`).sort()).toEqual(['email:sent', 'macos:sent', 'teams:sent'])
    expect(t.sink.facts.find((x) => x.event === 'release.succeeded')).toMatchObject({ durationSec: 125, notesExcerpt: '## Notes' })
    // A manual rollback's success is its outcome, sent from the raw event.
    t.meta('rel-2', { kind: 'rollback' })
    await t.d.onRunEvent(t.ev('rel-2', { type: 'run.finished', status: 'succeeded' }))
    expect(t.sink.calls.filter((c) => c.endsWith('release.rolled_back')).sort()).toEqual(['macos:release.rolled_back', 'teams:release.rolled_back'])
  })

  it('each event posts at most once per channel', async () => {
    const t = await setup()
    t.meta('rel-1')
    const fin = t.ev('rel-1', { type: 'run.finished', status: 'failed' })
    await t.d.onRunEvent(fin)
    await t.d.onRunEvent(fin)
    await t.make().onRunEvent(fin)
    expect(t.sink.calls.sort()).toEqual(['macos:release.failed', 'teams:release.failed'])
    expect(t.rows()).toHaveLength(2)
  })

  it('zero-commit redeploy sends nothing on success but still reports failure', async () => {
    const t = await setup()
    const m = t.meta('rel-1', { redeploy: true, version: null })
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.started', kind: 'release', version: null }))
    expect(await t.d.notifyRunSucceeded(m, null)).toEqual([])
    expect(t.sink.calls).toEqual([])
    t.meta('rel-2', { redeploy: true, version: null })
    await t.d.onRunEvent(t.ev('rel-2', { type: 'run.finished', status: 'failed' }))
    expect(t.sink.calls.sort()).toEqual(['macos:release.failed', 'teams:release.failed'])
  })

  it('tunnel dropped (wasUp true) notifies; failed before up does not', async () => {
    const t = await setup()
    const tun = t.f.tunnels.create({ label: 'db', hostId: t.f.host.id, environmentId: t.f.staging.id, type: 'L', bindPort: 15432, targetHost: '127.0.0.1', targetPort: 5432 })
    const failed = (wasUp: boolean, at: string): TunnelEvent => ({ type: 'failed', tunnelId: tun.id, label: 'db', at, error: { code: 'network', message: 'connection reset by 10.0.0.7' } as never, wasUp })
    await t.d.onTunnelEvent(failed(false, '2026-10-19T12:00:00.000Z'))
    expect(t.sink.calls).toEqual([])
    await t.d.onTunnelEvent(failed(true, '2026-10-19T12:01:00.000Z'))
    expect(t.sink.calls.sort()).toEqual(['macos:tunnel.failed', 'teams:tunnel.failed'])
    const f = t.sink.facts[0]
    expect(f).toMatchObject({ status: 'dropped', hosts: ['app1'], deployment: null })
    expect(JSON.stringify(t.sink.facts)).not.toContain('10.0.0.7')
    // Up event is not news.
    await t.d.onTunnelEvent({ type: 'up', tunnelId: tun.id, label: 'db', at: '2026-10-19T12:02:00.000Z', recovered: true })
    expect(t.sink.calls).toHaveLength(2)
  })

  it('tunnel without environment → macos only when macosUnscoped', async () => {
    const t = await setup()
    const tun = t.f.tunnels.create({ label: 'adhoc', hostId: t.f.host.id, type: 'L', bindPort: 18080, targetHost: '127.0.0.1', targetPort: 80 })
    const failed = (at: string): TunnelEvent => ({ type: 'failed', tunnelId: tun.id, label: 'adhoc', at, error: { code: 'network', message: 'x' } as never, wasUp: true })
    t.settings.update({ macosUnscoped: false })
    await t.d.onTunnelEvent(failed('2026-10-19T12:00:00.000Z'))
    expect(t.sink.calls).toEqual([])
    t.settings.update({ macosUnscoped: true })
    await t.d.onTunnelEvent(failed('2026-10-19T12:05:00.000Z'))
    expect(t.sink.calls).toEqual(['macos:tunnel.failed'])
  })

  it('queues Teams while locked and flushes on unlock', async () => {
    const t = await setup()
    t.meta('rel-1')
    t.f.vault.lock('manual')
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.finished', status: 'failed' }))
    expect(t.sink.calls).toEqual(['macos:release.failed'])
    expect(t.rows().find((r) => r.channel === 'teams')).toMatchObject({ status: 'pending', detail: 'waiting for vault unlock' })
    await t.f.vault.unlock('correct horse')
    await t.d.flushPending()
    await t.d.flushPending()
    expect(t.sink.calls.sort()).toEqual(['macos:release.failed', 'teams:release.failed'])
    expect(t.rows().find((r) => r.channel === 'teams')?.status).toBe('sent')

    // Older than an hour: skipped, never sent.
    t.meta('rel-2')
    t.f.vault.lock('manual')
    await t.d.onRunEvent(t.ev('rel-2', { type: 'run.finished', status: 'failed' }))
    t.clock.t += 61 * 60_000
    await t.f.vault.unlock('correct horse')
    await t.d.flushPending()
    expect(t.sink.calls.filter((c) => c === 'teams:release.failed')).toHaveLength(1)
    expect(t.rows().find((r) => r.source_id === 'rel-2' && r.channel === 'teams')).toMatchObject({ status: 'skipped', detail: 'expired while the vault was locked' })
  })

  it('audit notify.send has channel, event, status and no URL', async () => {
    const t = await setup()
    t.meta('rel-1')
    t.sink.fail.teams = new Error(`POST ${HOOK} failed`)
    await t.d.onRunEvent(t.ev('rel-1', { type: 'run.finished', status: 'failed' }))
    const ev = t.f.audit.list({ actions: ['notify.send'] })
    expect(ev.map((e) => e.details).sort((a, b) => String(a['channel']).localeCompare(String(b['channel'])))).toEqual([
      { channel: 'macos', event: 'release.failed', status: 'sent' },
      { channel: 'teams', event: 'release.failed', status: 'failed' },
    ])
    expect(ev.find((e) => e.details['channel'] === 'teams')?.outcome).toBe('failure')
    expect(auditRows(t.f.db)).not.toContain('SECRETPATH')
    expect(JSON.stringify(t.rows())).not.toContain('SECRETPATH')
    expect(JSON.stringify(t.rows())).not.toContain('webhook.office.com')
  })
})

describe('finalize notify', () => {
  /** A real ReleaseService (the 8a rig) whose finalize `notify` is this module's, routed to a fake sink. */
  async function rigWithNotify(fail: Partial<Record<'teams' | 'email', Error>>) {
    let steps: FinalizeSteps = noopFinalize
    const finalize: FinalizeSteps = { releaseNotes: noopFinalize.releaseNotes, notify: (ctx) => steps.notify(ctx), qa: noopFinalize.qa }
    const r = await rig({ finalize })
    const s = stores(r.f)
    s.settings.update({ sendgridApiKeySecretId: s.sg.id, sendgridFrom: 'ops@example.com', macos: false })
    s.integrations.update(r.f.staging.id, { teamsWebhookSecretId: s.hook.id, emailTo: ['team@example.com'] })
    const sink = new FakeSink()
    sink.fail = fail
    const dispatcher = new NotificationDispatcher({
      db: r.f.db,
      sink,
      integrations: s.integrations,
      settings: s.settings,
      vault: r.f.vault,
      audit: r.f.audit,
      runs: r.svc,
      tunnels: r.f.tunnels,
      now: () => new Date(T0),
    })
    steps = createFinalizeSteps({ dispatcher })
    const id = await ready(r)
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const events = r.svc.events(id, 0)
    const step = (kind: string) => events.filter((e) => 'stepId' in e && e.stepId === `release:${kind}` && e.type !== 'step.started').map((e) => e.type)
    const lines = events.flatMap((e) => (e.type === 'log' ? [e.line] : []))
    return { r, id, sink, step, lines }
  }

  it('finalize notify failure never fails the run', async () => {
    const one = await rigWithNotify({ teams: new IntegrationError('teams', 'http', 'Teams webhook failed (HTTP 500)', [], 500) })
    expect(one.r.svc.detail(one.id).status).toBe('succeeded')
    expect(one.sink.calls.sort()).toEqual(['email:release.succeeded', 'teams:release.succeeded'])
    expect(one.lines).toEqual(expect.arrayContaining(['Teams: failed (HTTP 500)', 'Email: sent', 'macOS: skipped (turned off)']))
    expect(one.step('finalize_notify')).toEqual(['step.done'])

    const both = await rigWithNotify({
      teams: new IntegrationError('teams', 'http', 'Teams webhook failed (HTTP 500)', [], 500),
      email: new IntegrationError('sendgrid', 'auth', 'SendGrid rejected the API key (HTTP 401)', [], 401),
    })
    expect(both.r.svc.detail(both.id).status).toBe('succeeded')
    expect(both.step('finalize_notify')).toEqual(['step.failed'])
    expect(both.step('finalize_notes')).toEqual(['step.done'])
    expect(both.step('finalize_qa')).toEqual(['step.done'])
  })

  it('logs skipped channels with the reason', async () => {
    const t = await setup()
    const lines: string[] = []
    const steps = createFinalizeSteps({ dispatcher: t.d })
    const run = t.meta('rel-1', { status: 'succeeded' })
    await steps.notify({ run, log: (l) => void lines.push(l), signal: new AbortController().signal })
    expect(lines).toEqual(['Teams: sent', 'Email: skipped (no recipients)', 'macOS: sent'])
    expect(steps.releaseNotes).toBe(noopFinalize.releaseNotes)
    expect(steps.qa).toBe(noopFinalize.qa)
  })
})
