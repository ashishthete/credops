import type {
  BreakLockConfirm,
  PlaybookPreview,
  PreflightRequest,
  ReleaseConfirm,
  ReleaseDetail,
  ReleaseListFilter,
  ReleaseStatus,
  ReleaseSummary,
  RunEvent,
} from '../../shared/deploy'
import type { AuditLog } from '../audit/audit-log'
import type { ReleaseRunMeta } from '../deploy/finalize'
import { HubError, type HubClient } from './client'

type Maybe<T> = T | Promise<T>

/**
 * What the release IPC handlers call. Phase 8's `ReleaseService` satisfies it as is (its answers are synchronous);
 * the Hub's runner and the router answer with promises, since every read there is a request.
 */
export interface ReleaseApi {
  preflight(req: PreflightRequest): Maybe<{ releaseId: string }>
  previewPlaybook(releaseId: string): Maybe<PlaybookPreview>
  start(releaseId: string, confirm?: ReleaseConfirm): Maybe<void>
  cancel(releaseId: string): Maybe<void>
  rollback(releaseId: string, confirm?: ReleaseConfirm): Maybe<{ releaseId: string }>
  breakLock(releaseId: string, hostId: string, confirm: BreakLockConfirm): Maybe<void>
  discard(releaseId: string): Maybe<void>
  retryVersion(releaseId: string): Maybe<void>
  setNotes(releaseId: string, notes: string): Maybe<void>
  list(filter?: ReleaseListFilter): Maybe<ReleaseSummary[]>
  listActive(): Maybe<ReleaseSummary[]>
  detail(releaseId: string): Maybe<ReleaseDetail>
  events(releaseId: string, afterSeq: number, limit?: number): Maybe<RunEvent[]>
  runMeta(releaseId: string, status?: ReleaseStatus): Maybe<ReleaseRunMeta>
  hasActive(): boolean
  onEvent(fn: (batch: RunEvent[]) => void): () => void
}

type Op = 'preflight' | 'start' | 'cancel' | 'rollback' | 'break-lock' | 'discard' | 'retry-version'

export interface HubRunnerDeps {
  client: () => Pick<HubClient, 'get' | 'post'>
  audit: Pick<AuditLog, 'append'>
  /** Shared with the router: every release id the Hub has told us about. */
  ids: Set<string>
  /** The environment's name in the signed-in person's catalog. */
  envName: (environmentId: string) => string | undefined
  /** Batches the live feed delivers, for `onEvent`. */
  feed: { onEvent(fn: (batch: RunEvent[]) => void): () => void }
}

/**
 * The Hub side of the release API: each method is the Hub route of the same name. The Hub decides who may do
 * what and builds the plan from its own registry, so the request carries ids only. A mutating call is also
 * written to this desktop's audit log as `hub.release`.
 */
export class HubRunner implements ReleaseApi {
  private readonly names = new Map<string, string>()

  constructor(private readonly d: HubRunnerDeps) {}

  async preflight(req: PreflightRequest): Promise<{ releaseId: string }> {
    const envName = this.d.envName(req.environmentId) ?? ''
    const res = await this.audited('preflight', null, envName, () => this.d.client().post<{ releaseId: string }>('/api/v1/releases/preflight', req))
    this.remember(res.releaseId, envName)
    return res
  }

  /** A read: not audited, like `detail`. */
  previewPlaybook(releaseId: string): Promise<PlaybookPreview> {
    return this.d.client().get<PlaybookPreview>(`/api/v1/releases/${releaseId}/playbook`)
  }

  async start(releaseId: string, confirm: ReleaseConfirm = {}): Promise<void> {
    await this.audited('start', releaseId, await this.nameOf(releaseId), () => this.d.client().post<void>(`/api/v1/releases/${releaseId}/start`, confirm))
  }

  async cancel(releaseId: string): Promise<void> {
    await this.audited('cancel', releaseId, await this.nameOf(releaseId), () => this.d.client().post<void>(`/api/v1/releases/${releaseId}/cancel`))
  }

  async rollback(releaseId: string, confirm: ReleaseConfirm = {}): Promise<{ releaseId: string }> {
    const envName = await this.nameOf(releaseId)
    const res = await this.audited('rollback', releaseId, envName, () => this.d.client().post<{ releaseId: string }>(`/api/v1/releases/${releaseId}/rollback`, confirm))
    this.remember(res.releaseId, envName)
    return res
  }

  async breakLock(releaseId: string, hostId: string, confirm: BreakLockConfirm): Promise<void> {
    await this.audited('break-lock', releaseId, await this.nameOf(releaseId), () =>
      this.d.client().post<void>(`/api/v1/releases/${releaseId}/break-lock`, { hostId, typedLabel: confirm.typedLabel }),
    )
  }

  async discard(releaseId: string): Promise<void> {
    await this.audited('discard', releaseId, await this.nameOf(releaseId), () => this.d.client().post<void>(`/api/v1/releases/${releaseId}/discard`))
  }

  async retryVersion(releaseId: string): Promise<void> {
    await this.audited('retry-version', releaseId, await this.nameOf(releaseId), () => this.d.client().post<void>(`/api/v1/releases/${releaseId}/retry-version`))
  }

  setNotes(): never {
    throw new Error('Release notes of a Hub release are set when it is prepared')
  }

  async list(filter: ReleaseListFilter = {}): Promise<ReleaseSummary[]> {
    const rows = await this.d.client().get<ReleaseSummary[]>('/api/v1/releases', { ...filter })
    for (const r of rows) this.remember(r.id, r.environmentName)
    return rows
  }

  async listActive(): Promise<ReleaseSummary[]> {
    const rows = await this.d.client().get<ReleaseSummary[]>('/api/v1/releases/active')
    for (const r of rows) this.remember(r.id, r.environmentName)
    return rows
  }

  async detail(releaseId: string): Promise<ReleaseDetail> {
    const d = await this.d.client().get<ReleaseDetail>(`/api/v1/releases/${releaseId}`)
    this.remember(d.id, d.environmentName)
    return d
  }

  events(releaseId: string, afterSeq: number, limit = 1000): Promise<RunEvent[]> {
    return this.d.client().get<RunEvent[]>(`/api/v1/releases/${releaseId}/events`, { afterSeq, limit })
  }

  /** What finalize steps and notifications read, derived from the Hub's detail. */
  async runMeta(releaseId: string, status?: ReleaseStatus): Promise<ReleaseRunMeta> {
    const d = await this.detail(releaseId)
    const at = d.triggeredBy.lastIndexOf('@')
    return {
      id: d.id,
      releaseId: d.id,
      kind: d.kind,
      status: status ?? d.status,
      environmentId: d.environmentId,
      environmentName: d.environmentName,
      productId: null,
      productName: null,
      deployments: d.runs.map((r) => ({
        id: r.deploymentId,
        name: r.deploymentName,
        hostId: r.hostId,
        hostLabel: r.hostLabel,
        status: r.status,
        previousCommit: r.previousCommit,
        deployedCommit: r.deployedCommit,
      })),
      hostIds: [...new Set(d.runs.flatMap((r) => (r.hostId === null ? [] : [r.hostId])))],
      version: d.version,
      previousVersion: d.previousVersion,
      commits: d.runs.flatMap((r) => r.commits),
      options: d.options,
      releaseNotes: d.releaseNotes,
      redeploy: d.redeploy,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
      actor: { osUser: at < 0 ? d.triggeredBy : d.triggeredBy.slice(0, at), machine: at < 0 ? '' : d.triggeredBy.slice(at + 1) },
      urls: [],
    }
  }

  /** Hub releases run on the Hub; this desktop never holds a lock for one. */
  hasActive(): boolean {
    return false
  }

  onEvent(fn: (batch: RunEvent[]) => void): () => void {
    return this.d.feed.onEvent(fn)
  }

  private remember(releaseId: string, environmentName: string): void {
    this.d.ids.add(releaseId)
    if (environmentName) this.names.set(releaseId, environmentName)
  }

  private async nameOf(releaseId: string): Promise<string> {
    const known = this.names.get(releaseId)
    if (known !== undefined) return known
    try {
      return (await this.detail(releaseId)).environmentName
    } catch {
      return ''
    }
  }

  private async audited<T>(op: Op, releaseId: string | null, environmentName: string, run: () => Promise<T>): Promise<T> {
    let result: T
    try {
      result = await run()
    } catch (err) {
      this.audit(op, releaseId, environmentName, 'failure', err instanceof HubError ? err.code : undefined)
      throw err
    }
    const made = (result as { releaseId?: unknown } | undefined)?.releaseId
    this.audit(op, typeof made === 'string' && (op === 'preflight' || op === 'rollback') ? made : releaseId, environmentName, 'success')
    return result
  }

  private audit(op: Op, releaseId: string | null, environmentName: string, outcome: 'success' | 'failure', reason?: string): void {
    this.d.audit.append({
      action: 'hub.release',
      outcome,
      targetType: 'release',
      ...(releaseId ? { targetId: releaseId } : {}),
      ...(environmentName ? { targetLabel: environmentName } : {}),
      details: { op, releaseId, environmentName, ...(reason ? { reason } : {}) },
    })
  }
}

export interface RoutingReleasesDeps {
  local: ReleaseApi
  hub: ReleaseApi
  isHubEnv: (environmentId: string) => boolean
  /** The same set the runner fills. */
  hubReleaseIds: Set<string>
  /** Whether a Hub is linked and signed in; otherwise Hub entries are simply absent, with no warning. */
  hubActive: () => boolean
  /** Told once per outage. */
  notice: (message: string) => void
}

export const HUB_OFFLINE_NOTICE = 'Hub offline — team releases hidden'

/** Sends each release call to the local service or the Hub: preflight by environment, everything else by where the release came from. */
export class RoutingReleases implements ReleaseApi {
  private offlineTold = false

  constructor(private readonly d: RoutingReleasesDeps) {}

  private pick(releaseId: string): ReleaseApi {
    return this.d.hubReleaseIds.has(releaseId) ? this.d.hub : this.d.local
  }

  async preflight(req: PreflightRequest): Promise<{ releaseId: string }> {
    return this.d.isHubEnv(req.environmentId) ? this.d.hub.preflight(req) : this.d.local.preflight(req)
  }
  previewPlaybook(releaseId: string): Maybe<PlaybookPreview> {
    return this.pick(releaseId).previewPlaybook(releaseId)
  }
  start(releaseId: string, confirm?: ReleaseConfirm): Maybe<void> {
    return this.pick(releaseId).start(releaseId, confirm)
  }
  cancel(releaseId: string): Maybe<void> {
    return this.pick(releaseId).cancel(releaseId)
  }
  rollback(releaseId: string, confirm?: ReleaseConfirm): Maybe<{ releaseId: string }> {
    return this.pick(releaseId).rollback(releaseId, confirm)
  }
  breakLock(releaseId: string, hostId: string, confirm: BreakLockConfirm): Maybe<void> {
    return this.pick(releaseId).breakLock(releaseId, hostId, confirm)
  }
  discard(releaseId: string): Maybe<void> {
    return this.pick(releaseId).discard(releaseId)
  }
  retryVersion(releaseId: string): Maybe<void> {
    return this.pick(releaseId).retryVersion(releaseId)
  }
  setNotes(releaseId: string, notes: string): Maybe<void> {
    return this.pick(releaseId).setNotes(releaseId, notes)
  }
  detail(releaseId: string): Maybe<ReleaseDetail> {
    return this.pick(releaseId).detail(releaseId)
  }
  events(releaseId: string, afterSeq: number, limit?: number): Maybe<RunEvent[]> {
    return this.pick(releaseId).events(releaseId, afterSeq, limit)
  }
  runMeta(releaseId: string, status?: ReleaseStatus): Maybe<ReleaseRunMeta> {
    return this.pick(releaseId).runMeta(releaseId, status)
  }

  async list(filter: ReleaseListFilter = {}): Promise<ReleaseSummary[]> {
    const env = filter.environmentId
    const hubOnly = env !== undefined && this.d.isHubEnv(env)
    const localOnly = env !== undefined && !hubOnly
    const local = hubOnly ? [] : await this.d.local.list(filter)
    const hub = localOnly ? [] : await this.fromHub(() => this.d.hub.list(filter))
    return this.merge(local, hub, filter.limit)
  }

  async listActive(): Promise<ReleaseSummary[]> {
    const local = await this.d.local.listActive()
    const hub = await this.fromHub(() => this.d.hub.listActive())
    return this.merge(local, hub)
  }

  hasActive(): boolean {
    return this.d.local.hasActive()
  }

  onEvent(fn: (batch: RunEvent[]) => void): () => void {
    const offs = [this.d.local.onEvent(fn), this.d.hub.onEvent(fn)]
    return () => offs.forEach((off) => off())
  }

  private merge(local: ReleaseSummary[], hub: ReleaseSummary[], limit?: number): ReleaseSummary[] {
    const all = [...local, ...hub].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return limit === undefined ? all : all.slice(0, limit)
  }

  /** An unreachable Hub (including a proxy's 5xx in front of a stopped one) hides its entries and says so once; any other failure is the caller's to see. */
  private async fromHub(read: () => Maybe<ReleaseSummary[]>): Promise<ReleaseSummary[]> {
    if (!this.d.hubActive()) return []
    try {
      const rows = await read()
      this.offlineTold = false
      return rows
    } catch (err) {
      if (!(err instanceof HubError) || !unreachable(err)) throw err
      if (!this.offlineTold) {
        this.offlineTold = true
        this.d.notice(HUB_OFFLINE_NOTICE)
      }
      return []
    }
  }
}

/** A Hub that cannot answer: no socket, a 5xx from a proxy in front of a stopped Hub, or no status at all. 401 and 403 are answers. */
function unreachable(err: HubError): boolean {
  return err.code === 'network' || err.code === 'timeout' || err.code === 'unavailable' || err.status === undefined || err.status >= 500
}
