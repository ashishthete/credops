import type { AuditAppender } from '../audit/audit-log'
import type { Db } from '../db/connection'
import type { ReleaseRunMeta } from '../deploy/finalize'
import { uuidv7 } from '../deploy/uuidv7'
import { redact } from '../security/redact'
import type { IntegrationStore } from '../settings/integration-store'
import type { SettingsStore } from '../settings/settings-store'
import type { RunEvent } from '../../shared/deploy'
import type { NotificationRecord, NotifyChannel, NotifyEventKey, NotifySourceType } from '../../shared/settings'
import type { TunnelEvent, TunnelMeta } from '../../shared/tunnels'
import type { ReleaseStatus } from '../../shared/deploy'
import { IntegrationError } from './http'
import { toRecord, type LogRow } from './log'
import type { NotificationSink } from './sink'
import { MAX_NOTES_EXCERPT, type NotificationFacts } from './teams'

export const WAITING_FOR_UNLOCK = 'waiting for vault unlock'
export const EXPIRED_WHILE_LOCKED = 'expired while the vault was locked'
/** Pending sends older than this are dropped at unlock. */
export const PENDING_TTL_MS = 60 * 60_000
/** notification_log keeps this many newest rows; the rest go on each insert. */
export const NOTIFY_LOG_KEEP = 5000
const MAX_DETAIL = 200

type SendChannel = Exclude<NotifyChannel, 'qa'>
/** What one channel did with one event: `duplicate` means an earlier attempt already owns it. */
export interface ChannelOutcome {
  channel: SendChannel
  status: 'sent' | 'failed' | 'skipped' | 'pending' | 'duplicate'
  /** Why it was skipped, or a short failure reason (`HTTP 500`). Never a URL or a value. */
  reason: string | null
}

export interface DispatcherDeps {
  db: Db
  sink: NotificationSink
  integrations: Pick<IntegrationStore, 'forEnvironment'>
  settings: Pick<SettingsStore, 'get'>
  vault: { isUnlocked(): boolean }
  audit: AuditAppender
  runs: { runMeta(releaseId: string, status?: ReleaseStatus): ReleaseRunMeta }
  tunnels: { get(id: string): Pick<TunnelMeta, 'label' | 'hostId' | 'environmentId'> }
  /** How an environment appears on a card; the default reads the app's `environments` table (the Hub has no color). */
  environment?: (id: string, fallbackName: string | null) => NotificationFacts['environment']
  now?: () => Date
  ids?: () => string
  knownSecrets?: () => readonly string[]
  logLimit?: number
}

interface Source {
  type: Exclude<NotifySourceType, 'test'>
  id: string
}

interface Job {
  source: Source
  event: NotifyEventKey
  environmentId: string | null
  facts: NotificationFacts
  notes: string | null
  /** The run's `options.notify`; false keeps Teams and email off (macOS still fires). */
  remote: boolean
  route: string
}

const RUN_STATUS: Partial<Record<NotifyEventKey, NotificationFacts['status']>> = {
  'release.started': 'started',
  'release.succeeded': 'succeeded',
  'release.failed': 'failed',
  'release.rolled_back': 'rolled_back',
}

const RELEASE_ROUTE = '#/deployments'
const TUNNEL_ROUTE = '#/tunnels'

/**
 * Turns run and tunnel events into Teams, email and macOS sends, per environment. Every (source, event,
 * channel) sends at most once: a `pending` row is inserted first and the UNIQUE constraint refuses a second.
 */
export class NotificationDispatcher {
  private readonly now: () => Date
  private readonly ids: () => string
  private readonly listeners = new Set<(r: NotificationRecord) => void>()

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? (() => new Date())
    this.ids = d.ids ?? (() => uuidv7())
  }

  onSent(fn: (r: NotificationRecord) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** The rule table for run events. `release.succeeded` is never sent from here: finalize sends it with notes. */
  async onRunEvent(e: RunEvent): Promise<void> {
    try {
      const event = this.runEventKey(e)
      if (!event) return
      const run = this.d.runs.runMeta(e.runId)
      if (run.redeploy && event === 'release.started') return
      await this.dispatch(this.runJob(run, event, null))
    } catch {
      /* a notification never breaks the event stream */
    }
  }

  async onTunnelEvent(e: TunnelEvent): Promise<void> {
    try {
      if (e.type !== 'failed' || !e.wasUp) return
      const facts = this.factsForTunnel(e)
      const meta = this.d.tunnels.get(e.tunnelId)
      // A tunnel id restarts its stream at each drop; the drop time keeps each drop its own source.
      await this.dispatch({
        source: { type: 'tunnel', id: `${e.tunnelId}@${e.at}` },
        event: 'tunnel.failed',
        environmentId: meta.environmentId,
        facts,
        notes: null,
        remote: true,
        route: TUNNEL_ROUTE,
      })
    } catch {
      /* a deleted tunnel has nothing to report */
    }
  }

  /** Called by finalize `notify`. A zero-commit redeploy sends nothing. */
  async notifyRunSucceeded(run: ReleaseRunMeta, notes: string | null): Promise<ChannelOutcome[]> {
    if (run.redeploy) return []
    return this.dispatch(this.runJob(run, 'release.succeeded', notes))
  }

  /** Called by the QA wait (Task 7) once the workflow run completes. */
  async notifyQa(run: ReleaseRunMeta, conclusion: string | null, htmlUrl: string | null = null): Promise<ChannelOutcome[]> {
    const job = this.runJob(run, 'qa.finished', null)
    job.facts.status = conclusion === 'success' ? 'qa_passed' : 'qa_failed'
    job.facts.title = 'QA'
    if (htmlUrl) job.facts.urls = [htmlUrl, ...job.facts.urls]
    return this.dispatch(job)
  }

  /** At unlock: sends the queued Teams and email rows younger than an hour; older ones become `skipped`. */
  async flushPending(): Promise<void> {
    if (!this.d.vault.isUnlocked()) return
    const rows = this.d.db
      .prepare("SELECT * FROM notification_log WHERE status = 'pending' AND detail = ? ORDER BY at, id")
      .all(WAITING_FOR_UNLOCK) as unknown as LogRow[]
    const cutoff = this.now().getTime() - PENDING_TTL_MS
    for (const row of rows) {
      const claimed = this.d.db
        .prepare("UPDATE notification_log SET detail = NULL WHERE id = ? AND status = 'pending' AND detail = ?")
        .run(row.id, WAITING_FOR_UNLOCK)
      if (claimed.changes === 0) continue
      if (Date.parse(row.at) < cutoff) {
        this.finish(row, 'skipped', EXPIRED_WHILE_LOCKED)
        continue
      }
      const job = this.rebuild(row)
      if (!job) {
        this.finish(row, 'skipped', 'its release or tunnel no longer exists')
        continue
      }
      await this.send(row, job)
    }
  }

  factsForRun(run: ReleaseRunMeta, status: NotificationFacts['status'], event: NotifyEventKey = 'release.succeeded'): NotificationFacts {
    const names = [...new Set(run.deployments.map((x) => x.name))]
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN
    return {
      event,
      title: run.kind === 'rollback' ? 'Rollback' : 'Release',
      environment: this.environment(run.environmentId, run.environmentName),
      product: run.productName,
      deployment: names.length ? names.join(', ') : null,
      hosts: [...new Set(run.deployments.map((x) => x.hostLabel))],
      status,
      version: run.version,
      durationSec: status !== 'started' && Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 1000)) : null,
      urls: [...run.urls],
      actor: `${run.actor.osUser}@${run.actor.machine}`,
      at: this.now().toISOString(),
    }
  }

  factsForTunnel(e: Extract<TunnelEvent, { type: 'failed' }>): NotificationFacts {
    const meta = this.d.tunnels.get(e.tunnelId)
    const host = this.d.db.prepare('SELECT label FROM hosts WHERE id = ?').get(meta.hostId) as { label: string } | undefined
    return {
      event: 'tunnel.failed',
      title: `Tunnel ${meta.label}`,
      environment: meta.environmentId ? this.environment(meta.environmentId, null) : { name: 'No environment', color: '', protected: false },
      product: null,
      deployment: null,
      hosts: host ? [host.label] : [],
      status: 'dropped',
      version: null,
      durationSec: null,
      urls: [],
      actor: '',
      at: e.at,
    }
  }

  // ---- internals ----

  private runEventKey(e: RunEvent): NotifyEventKey | null {
    if (e.type === 'run.started') return e.kind === 'release' ? 'release.started' : null
    if (e.type !== 'run.finished') return null
    switch (e.status) {
      case 'failed':
        return 'release.failed'
      case 'rolled_back':
        return 'release.rolled_back'
      case 'succeeded':
        // A release's success goes out from finalize, with notes; a manual rollback has no finalize.
        return this.d.runs.runMeta(e.runId).kind === 'rollback' ? 'release.rolled_back' : null
      default:
        return null
    }
  }

  private runJob(run: ReleaseRunMeta, event: NotifyEventKey, notes: string | null): Job {
    const facts = this.factsForRun(run, RUN_STATUS[event] ?? 'succeeded', event)
    if (event === 'release.succeeded' && notes) facts.notesExcerpt = notes.slice(0, MAX_NOTES_EXCERPT)
    return { source: { type: 'release', id: run.releaseId }, event, environmentId: run.environmentId, facts, notes, remote: run.options.notify, route: RELEASE_ROUTE }
  }

  private environment(id: string, fallbackName: string | null): NotificationFacts['environment'] {
    if (this.d.environment) return this.d.environment(id, fallbackName)
    const row = this.d.db.prepare('SELECT name, color, protected FROM environments WHERE id = ?').get(id) as
      | { name: string; color: string; protected: number }
      | undefined
    return row ? { name: row.name, color: row.color, protected: row.protected === 1 } : { name: fallbackName ?? 'Unknown environment', color: '', protected: false }
  }

  /** Which channels this job goes to, and why each other one does not. */
  private plan(job: Job): { channel: SendChannel; skip: string | null }[] {
    const s = this.d.settings.get()
    const macos = s.macos ? null : 'turned off'
    if (job.environmentId === null) return [{ channel: 'macos', skip: macos ?? (s.macosUnscoped ? null : 'not selected') }]
    const integ = this.d.integrations.forEnvironment(job.environmentId)
    const selected = integ.notifyEvents.includes(job.event)
    const off = !selected ? 'not selected' : null
    const remoteOff = off ?? (job.remote ? null : 'turned off for this release')
    const out: { channel: SendChannel; skip: string | null }[] = [{ channel: 'teams', skip: remoteOff ?? (integ.teamsWebhookSecretId ? null : 'no webhook') }]
    if (job.event === 'release.succeeded') {
      const email = remoteOff ?? (integ.emailTo.length === 0 ? 'no recipients' : !s.sendgridApiKeySecretId || !s.sendgridFrom ? 'SendGrid not set up' : null)
      out.push({ channel: 'email', skip: email })
    }
    out.push({ channel: 'macos', skip: off ?? macos })
    return out
  }

  private async dispatch(job: Job): Promise<ChannelOutcome[]> {
    const out: ChannelOutcome[] = []
    for (const { channel, skip } of this.plan(job)) {
      if (skip !== null) {
        out.push({ channel, status: 'skipped', reason: skip })
        continue
      }
      const locked = channel !== 'macos' && !this.d.vault.isUnlocked()
      const row = this.claim(job, channel, locked ? WAITING_FOR_UNLOCK : null)
      if (!row) {
        out.push({ channel, status: 'duplicate', reason: 'already sent' })
        continue
      }
      if (locked) {
        out.push({ channel, status: 'pending', reason: WAITING_FOR_UNLOCK })
        continue
      }
      out.push(await this.send(row, job))
    }
    return out
  }

  /** Inserts the `pending` row; null when one already exists for this (source, event, channel). */
  private claim(job: Job, channel: SendChannel, detail: string | null): LogRow | null {
    const row: LogRow = {
      id: this.ids(),
      at: this.now().toISOString(),
      source_type: job.source.type,
      source_id: job.source.id,
      event: job.event,
      channel,
      status: 'pending',
      detail,
    }
    const res = this.d.db
      .prepare('INSERT OR IGNORE INTO notification_log(id, at, source_type, source_id, event, channel, status, detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.at, row.source_type, row.source_id, row.event, row.channel, row.status, row.detail)
    if (res.changes !== 1) return null
    this.d.db
      .prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY at DESC, id DESC LIMIT ?)')
      .run(this.d.logLimit ?? NOTIFY_LOG_KEEP)
    return row
  }

  private async send(row: LogRow, job: Job): Promise<ChannelOutcome> {
    const channel = row.channel as SendChannel
    try {
      if (channel === 'teams') await this.d.sink.teams(job.environmentId!, job.facts)
      else if (channel === 'email') await this.d.sink.email(job.environmentId!, job.facts, job.notes)
      else this.d.sink.macos(job.facts, job.route)
      this.finish(row, 'sent', null)
      return { channel, status: 'sent', reason: null }
    } catch (e) {
      const { detail, reason } = this.failure(e)
      this.finish(row, 'failed', detail)
      return { channel, status: 'failed', reason }
    }
  }

  /** The stored detail is the fixed integration message, else the redacted error with URLs removed. */
  private failure(e: unknown): { detail: string; reason: string } {
    if (e instanceof IntegrationError) {
      return { detail: e.message.slice(0, MAX_DETAIL), reason: e.status !== undefined ? `HTTP ${e.status}` : e.message.slice(0, MAX_DETAIL) }
    }
    const raw = e instanceof Error ? e.message : String(e)
    const safe = redact(raw, this.d.knownSecrets?.() ?? [])
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '‹url›')
      .slice(0, MAX_DETAIL)
    return { detail: safe, reason: safe }
  }

  private finish(row: LogRow, status: 'sent' | 'failed' | 'skipped', detail: string | null): void {
    this.d.db.prepare('UPDATE notification_log SET status = ?, detail = ? WHERE id = ?').run(status, detail, row.id)
    const record = toRecord({ ...row, status, detail })
    this.d.audit.append({
      action: 'notify.send',
      outcome: status === 'sent' ? 'success' : status === 'failed' ? 'failure' : 'info',
      targetType: row.source_type,
      targetId: row.source_type === 'release' ? row.source_id : row.source_id.split('@')[0],
      details: { channel: row.channel, event: row.event, status },
    })
    for (const fn of this.listeners) {
      try {
        fn(record)
      } catch {
        /* a listener never stops a send */
      }
    }
  }

  /** Rebuilds a queued job from its source at unlock (the facts are not stored). */
  private rebuild(row: LogRow): Job | null {
    try {
      const event = row.event as NotifyEventKey
      if (row.source_type === 'release') {
        const run = this.d.runs.runMeta(row.source_id)
        const job = this.runJob(run, event, event === 'release.succeeded' ? run.releaseNotes : null)
        job.facts.at = row.at
        return job
      }
      const at = row.source_id.slice(row.source_id.indexOf('@') + 1)
      const tunnelId = row.source_id.split('@')[0]
      const meta = this.d.tunnels.get(tunnelId)
      const facts = this.factsForTunnel({ type: 'failed', tunnelId, label: meta.label, at, error: { code: 'unknown', message: '' } as never, wasUp: true })
      return { source: { type: 'tunnel', id: row.source_id }, event, environmentId: meta.environmentId, facts, notes: null, remote: true, route: TUNNEL_ROUTE }
    } catch {
      return null
    }
  }
}
