import { randomUUID } from 'node:crypto'
import type { AuditAppender } from '../audit/audit-log'
import type { FinalizeContext, ReleaseRunMeta } from '../deploy/finalize'
import type { IntegrationStore } from '../settings/integration-store'
import type { SettingsStore } from '../settings/settings-store'
import type { SecretStore } from '../vault/secret-store'
import type { QaDispatch } from '../../shared/settings'
import type { NotificationDispatcher } from './dispatcher'
import { getJson, IntegrationError, postJson, type Fetch, type HttpOptions } from './http'

const GITHUB = 'https://api.github.com'
const FIND_EVERY_MS = 15_000
const FIND_FOR_MS = 2 * 60_000
const POLL_EVERY_MS = 30_000
const POLL_FOR_MS = 30 * 60_000
/** A run created this long before the dispatch still counts: GitHub's clock and ours differ. */
const CLOCK_SKEW_MS = 5_000
const MAX_KEPT = 50
const LIST_MAX_BYTES = 1024 * 1024
const RUN_MAX_BYTES = 256 * 1024

export type QaTrigger = 'manual' | 'release'

export interface QaDispatchOptions {
  trigger: QaTrigger
  releaseId?: string
  version?: string | null
}

export interface QaResult {
  /** GitHub's conclusion (`success`, `failure`, `cancelled`, …); null when OpsDeck stopped waiting. */
  conclusion: string | null
  htmlUrl: string | null
}

export interface QaDeps {
  secrets: Pick<SecretStore, 'value'>
  settings: Pick<SettingsStore, 'get'>
  integrations: Pick<IntegrationStore, 'forEnvironment' | 'environmentName'>
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  now?: () => Date
  audit: AuditAppender
  dispatcher: Pick<NotificationDispatcher, 'notifyQa'>
  /** The release a dispatch belongs to, for the `qa.finished` notification. */
  runs: { runMeta(releaseId: string): ReleaseRunMeta | null }
  knownSecrets?: () => readonly string[]
  ids?: () => string
}

interface GhRun {
  id: number
  created_at: string
  status: string
  conclusion: string | null
  html_url: string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Only a github.com page is kept as a link; anything else from the API is dropped. */
const safeHtmlUrl = (u: unknown): string | null => (typeof u === 'string' && u.startsWith('https://github.com/') ? u : null)

/**
 * Dispatches an environment's QA workflow on GitHub and, optionally, waits for its run. Dispatches live in
 * memory only. The token is read from the vault per request and sent only in the Authorization header.
 */
export class QaDispatcher {
  private readonly d: QaDeps
  private readonly now: () => Date
  private readonly ids: () => string
  private readonly items: QaDispatch[] = []
  private readonly listeners = new Set<(d: QaDispatch) => void>()
  private readonly lifetime = new AbortController()

  constructor(d: QaDeps) {
    this.d = d
    this.now = d.now ?? (() => new Date())
    this.ids = d.ids ?? randomUUID
  }

  onState(fn: (d: QaDispatch) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Newest first. */
  list(): QaDispatch[] {
    return this.items.map((i) => ({ ...i }))
  }

  /** Stops every detached wait (app quit or vault reset). */
  stop(): void {
    this.lifetime.abort()
  }

  async dispatch(environmentId: string, o: QaDispatchOptions): Promise<QaDispatch> {
    const integ = this.d.integrations.forEnvironment(environmentId)
    const qa = integ.qa
    const details = qa ? { trigger: o.trigger, repo: qa.repo, workflow: qa.workflow, ref: qa.ref } : { trigger: o.trigger }
    try {
      if (!qa) throw new Error('No QA workflow set for this environment')
      const inputs: Record<string, string> = { environment: this.d.integrations.environmentName(environmentId) }
      if (o.version) inputs['version'] = o.version
      const http = this.http()
      const at = this.now()
      try {
        await postJson(`${this.base(qa.repo)}/workflows/${encodeURIComponent(qa.workflow)}/dispatches`, { ref: qa.ref, inputs }, http)
      } catch (e) {
        if (e instanceof IntegrationError && e.status === 404) throw new Error('QA workflow not found (HTTP 404)')
        throw e
      }
      const item: QaDispatch = {
        id: this.ids(),
        environmentId,
        releaseId: o.releaseId ?? null,
        repo: qa.repo,
        workflow: qa.workflow,
        ref: qa.ref,
        dispatchedAt: at.toISOString(),
        state: 'dispatched',
        htmlUrl: null,
      }
      this.items.unshift(item)
      this.items.length = Math.min(this.items.length, MAX_KEPT)
      this.d.audit.append({ action: 'qa.dispatch', outcome: 'success', targetType: 'environment', targetId: environmentId, details })
      this.emit(item)
      return { ...item }
    } catch (e) {
      this.d.audit.append({
        action: 'qa.dispatch',
        outcome: 'failure',
        targetType: 'environment',
        targetId: environmentId,
        details: { ...details, reason: message(e) },
      })
      throw e
    }
  }

  /** Waits in the background for the dispatch's run; the promise settles when the wait does and never rejects. */
  watch(d: QaDispatch): Promise<void> {
    return this.wait(d, this.lifetime.signal).then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Finds the run the dispatch started (every 15 s, up to 2 min), then polls it (every 30 s, up to 30 min).
   * A finished run audits `qa.finished` and, for a release, sends the `qa.finished` notification.
   */
  async wait(d: QaDispatch, signal: AbortSignal): Promise<QaResult> {
    const item = this.items.find((i) => i.id === d.id) ?? d
    let found: GhRun | null = null
    try {
      found = await this.findRun(item, signal)
      if (!found) return this.giveUp(item)
      item.state = 'running'
      item.htmlUrl = safeHtmlUrl(found.html_url)
      this.emit(item)
      const run = await this.pollRun(item, found, signal)
      if (!run) return this.giveUp(item)
      const conclusion = run.conclusion ?? 'unknown'
      item.state = conclusion === 'success' ? 'passed' : 'failed'
      item.htmlUrl = safeHtmlUrl(run.html_url) ?? item.htmlUrl
      this.emit(item)
      this.d.audit.append({
        action: 'qa.finished',
        outcome: conclusion === 'success' ? 'success' : 'failure',
        targetType: 'environment',
        targetId: item.environmentId,
        details: { conclusion },
      })
      const meta = item.releaseId ? this.meta(item.releaseId) : null
      if (meta) await this.d.dispatcher.notifyQa(meta, conclusion, item.htmlUrl).catch(() => undefined)
      return { conclusion, htmlUrl: item.htmlUrl }
    } catch (e) {
      return this.giveUp(item, message(e))
    }
  }

  private async findRun(item: QaDispatch, signal: AbortSignal): Promise<GhRun | null> {
    const since = Date.parse(item.dispatchedAt) - CLOCK_SKEW_MS
    const url = `${this.base(item.repo)}/workflows/${encodeURIComponent(item.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(item.ref)}&per_page=10`
    const start = this.now().getTime()
    for (;;) {
      if (signal.aborted) return null
      const res = await getJson<{ workflow_runs?: GhRun[] }>(url, { ...this.http(), maxBytes: LIST_MAX_BYTES })
      const runs = Array.isArray(res.workflow_runs) ? res.workflow_runs : []
      const mine = runs
        .filter((r) => typeof r.id === 'number' && Date.parse(r.created_at) >= since)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]
      if (mine) return mine
      if (this.now().getTime() - start >= FIND_FOR_MS) return null
      await this.d.sleep(FIND_EVERY_MS)
    }
  }

  private async pollRun(item: QaDispatch, run: GhRun, signal: AbortSignal): Promise<GhRun | null> {
    const url = `${this.base(item.repo)}/runs/${run.id}`
    const start = this.now().getTime()
    for (;;) {
      if (signal.aborted) return null
      const r = await getJson<GhRun>(url, { ...this.http(), maxBytes: RUN_MAX_BYTES })
      if (r.status === 'completed') return r
      if (this.now().getTime() - start >= POLL_FOR_MS) return null
      await this.d.sleep(POLL_EVERY_MS)
    }
  }

  private meta(releaseId: string): ReleaseRunMeta | null {
    try {
      return this.d.runs.runMeta(releaseId)
    } catch {
      return null
    }
  }

  private giveUp(item: QaDispatch, reason?: string): QaResult {
    item.state = 'unknown'
    this.emit(item)
    this.d.audit.append({
      action: 'qa.finished',
      outcome: 'info',
      targetType: 'environment',
      targetId: item.environmentId,
      details: reason ? { conclusion: 'unknown', reason } : { conclusion: 'unknown' },
    })
    return { conclusion: null, htmlUrl: item.htmlUrl }
  }

  private base(repo: string): string {
    const [owner = '', name = ''] = repo.split('/')
    return `${GITHUB}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions`
  }

  /** Reads the token now; it rides only in the Authorization header. */
  private http(): HttpOptions {
    const id = this.d.settings.get().githubTokenSecretId
    if (!id) throw new Error('No GitHub token set')
    const token = this.d.secrets.value(id)
    const known = [...(this.d.knownSecrets?.() ?? []), token]
    return {
      service: 'github',
      fetch: this.d.fetch,
      sleep: this.d.sleep,
      knownSecrets: known,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
    }
  }

  private emit(item: QaDispatch): void {
    for (const fn of this.listeners) {
      try {
        fn({ ...item })
      } catch {
        // A listener's failure never stops QA.
      }
    }
  }
}

/** Finalize's `qa` step: dispatches when the run asked for QA and the environment has a workflow. */
export function qaFinalizeStep(d: {
  qa: Pick<QaDispatcher, 'dispatch' | 'watch'>
  integrations: Pick<IntegrationStore, 'forEnvironment'>
}): (ctx: FinalizeContext) => Promise<void> {
  return async (ctx) => {
    if (!ctx.run.options.qa) return ctx.log('QA: skipped (off for this run)')
    const integ = d.integrations.forEnvironment(ctx.run.environmentId)
    if (!integ.qa) return ctx.log('QA: skipped (no QA workflow)')
    const item = await d.qa.dispatch(ctx.run.environmentId, { trigger: 'release', releaseId: ctx.run.releaseId, version: ctx.run.version })
    ctx.log(`QA: dispatched ${item.repo}/${item.workflow}@${item.ref}`)
    if (integ.qaWait) d.qa.watch(item)
  }
}
