import { createHash } from 'node:crypto'
import {
  BREAK_LOCK_CONFIRM_MESSAGE,
  EVENT_BATCH_MS,
  MAX_ACTIVE_RELEASES,
  NOTHING_SELECTED_MESSAGE,
  REDEPLOY_CONFIRM_MESSAGE,
  STEP_SECRET_UNUSED_MESSAGE,
  bumpVersion,
  parseEnvTemplate,
  renderEnvTemplate,
  type Actor,
  type BreakLockConfirm,
  type DeploymentMeta,
  type DeploymentRunMeta,
  type DeploymentRunStatus,
  type DockerMode,
  EDIT_INVALID_MESSAGE,
  PLAYBOOK_CHANGED_MESSAGE,
  PREPARE_FAILED_MESSAGE,
  ROLLBACK_GENERATED_NOTE,
  PREPARE_FETCH_FAILED_MESSAGE,
  REVIEW_EXPIRED_MESSAGE,
  REVIEW_TTL_MS,
  type PlaybookEditResult,
  type PlaybookPreview,
  type PreflightCheck,
  type PreflightReport,
  type PreflightRequest,
  type ReleaseConfirm,
  type ReleaseDetail,
  type ReleaseFlow,
  type ReleaseListFilter,
  type ReleaseStatus,
  type ReleaseSummary,
  type EnvLastRelease,
  type RunEvent,
  type RunEventBody,
  type RunService,
  type StepKind,
} from '../../shared/deploy'
import type { AuditAction, AuditInput } from '../../shared/audit'
import { CONFIRM_MESSAGE } from '../../shared/ops'
import { listNames, type ServiceMeta } from '../../shared/services'
import { effectiveSteps, stepLabel, type Step, type StepBody } from '../../shared/steps'
import { ONCE_BUILTINS, isReadOnlyRunbook, validateParamValues, type OperationMeta, type OperationRequest, type Runbook } from '../../shared/runbooks'
import { ProtectError, confirmNeeded, protectionFor } from '../ops/protect'
import type { ResolvedHost } from '../../shared/inventory'
import type { Db } from '../db/connection'
import type { EnvironmentMeta } from '../../shared/inventory'
import { environmentMeta, hostMeta, productMeta } from '../inventory/rows'
import { redact } from '../security/redact'
import { DeployError, type DeployAccess, type DeployAction } from './access'
import type { DeployStore } from './deploy-store'
import { flowStages, planFields, resolveSelection, runServicesOf, skipServices, type RunSelection } from './selection'
import type { ServiceStore } from './service-store'
import { noopFinalize, type FinalizeSteps, type ReleaseRunMeta } from './finalize'
import { INTERRUPTED_MESSAGE, type ReleaseStore } from './release-store'
import type { DeployPlan, DeployRunner, PlanDeployment, PlanFlow, PlanHop, PlanHost, PlanKind, PlanOperation, PlanStep, RunOutcome, RunSecrets } from './runner'
import { generatePlaybook, stepList } from './generate'
import { operationSteps } from './generate-ops'
import type { RunbookStore } from './runbook-store'
import { generateInventory } from './ssh-files'
import { maskPlaybook, withBase64Forms } from './mask'
import { ToolingError } from './tooling'
import { validateEditedPlaybook } from './playbook-validate'

/* The release lifecycle: preflight, start, rollback, versioning, locks. It owns the stream (run.started /
   run.finished / preflight.done), the access and confirmation boundaries and the secrets' lifetime; the runner
   only executes plans. */

/** What the service reads about the inventory. Locally it is the app database; the Hub answers from its registry. */
export interface ReleaseInventory {
  environment(id: string): Pick<EnvironmentMeta, 'id' | 'name' | 'protected' | 'productIds'>
  /** The environment matters on the Hub, where a shared host has a row per environment. */
  hostLabel(hostId: string, environmentId: string): string
  productName(productId: string): string
  /** Every environment the hosts belong to, for the typed-name rule. */
  environmentsOfHosts(hostIds: string[]): { id: string; name: string; protected: boolean }[]
}

/** The inventory in the app database (Phase 8's behavior). */
export function dbInventory(db: Db): ReleaseInventory {
  return {
    environment: (id) => environmentMeta(db, id),
    hostLabel: (hostId) => hostMeta(db, hostId).label,
    productName: (productId) => productMeta(db, productId).name,
    environmentsOfHosts: (hostIds) => {
      if (hostIds.length === 0) return []
      const rows = db
        .prepare(`SELECT e.id AS id, e.name AS name, e.protected AS protected FROM environments e JOIN environment_hosts eh ON eh.environment_id = e.id WHERE eh.host_id IN (${hostIds.map(() => '?').join(',')})`)
        .all(...hostIds) as { id: string; name: string; protected: number }[]
      return rows.map((r) => ({ id: r.id, name: r.name, protected: r.protected === 1 }))
    },
  }
}

/** Who a call is for. The Hub passes the signed-in user per call; the desktop app uses the constructor's actor. */
export interface CallCtx {
  actor: Actor
}

export interface ReleaseServiceDeps {
  /** The store's database; the service reads only the `releases` table (version bump) from it directly. */
  db: Db
  deploys: Pick<DeployStore, 'get' | 'list' | 'settings' | 'updateSettings'>
  services: Pick<ServiceStore, 'list' | 'recordDeployed'>
  releases: ReleaseStore
  runner: DeployRunner
  access: DeployAccess
  finalize: FinalizeSteps
  audit: { append(input: AuditInput & { actor: Actor }): unknown }
  vault: { assertUnlocked(): void }
  resolve: (hostId: string, environmentId?: string) => ResolvedHost
  /** Reserved for the Hub's identity lookups; the local runner resolves identities itself. */
  identities?: unknown
  /** `environmentId` lets the Hub resolve a secret within one environment; the local store ignores it. */
  secrets: { value(id: string, environmentId?: string): string }
  /**
   * The secret values a playbook leaving main is masked with (as `deploy:previewPlaybook` masks it). An edit is made
   * on that masked text, so it is checked against it and its masked tasks are swapped back for the raw ones.
   */
  knownSecrets?: () => readonly string[]
  /** Defaults to the app database. */
  inventory?: ReleaseInventory
  /** The runbooks an operation runs; without it `preflightOperation` refuses. */
  runbooks?: Pick<RunbookStore, 'get'>
  /** One call per flushed batch (about every EVENT_BATCH_MS), already persisted with their seq. */
  emit: (batch: RunEvent[]) => void
  emitState: (summary: ReleaseSummary) => void
  actor: Actor
  now: () => Date
  clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}

/** The part of the service the Hub's routes and tests use. */
export type ReleaseOps = Pick<
  ReleaseService,
  'preflight' | 'preflightOperation' | 'previewPlaybook' | 'start' | 'cancel' | 'rollback' | 'breakLock' | 'discard' | 'retryVersion' | 'runMeta' | 'detail' | 'list' | 'events' | 'hasActive' | 'onEvent'
>
type ReleaseCounts = { serviceCount: number; deploymentCount: number; hostCount: number }

/** A run of a runbook on some of its services, with the param values it asks for. */
export type { OperationRequest }

type Phase = 'preflight' | 'release' | 'version' | 'rollback' | 'unlock'

interface Live {
  id: string
  actor: Actor
  environmentId: string
  environmentName: string
  phase: Phase
  runId: string | null
  cancelRequested: boolean
  /** Set by a vault reset: no playbook but the deploy-lock release runs again. */
  vaultReset: boolean
  done: Promise<void>
  runStatus: Map<string, DeploymentRunStatus>
  checkedOut: Set<string>
  /** Runs whose up step started (a parallel prepare rolls back only these). */
  upped: Set<string>
  /** The builds this release's parallel prepare launched: the unlock stops any still running. */
  killBuilds: { runId: string; repoPath: string }[]
  runIds: Set<string>
  failure: string | null
  versionError: string | null
  busyText: string | null
  known: string[]
  /** `<version|kind>`, the audit target label's second half. */
  label: string
  failedStep: string | null
  /** Aborts finalize's slow work (Claude notes); set only while finalize runs. */
  finalize: AbortController | null
  /** Set while a runbook operation preflights or runs. */
  op: OperationMeta | null
}

/** The decrypted values of one release. Held by reference so `drop` can let go of them. */
interface Holder {
  secrets: RunSecrets | null
  envKey: Map<string, string>
  becomeKey: Map<string, string>
  /** `<runId>:<step index>:<secret index>` -> the key of a custom step's secret. */
  stepKey: Map<string, string>
  secretIds: string[]
  refs: DeployPlan['secretRefs']
}

interface Info {
  run: DeploymentRunMeta
  dep: DeploymentMeta
  /** The run's services and form, as stored at preflight. */
  sel: RunSelection
}

const SHA = /^[0-9a-f]{40}$/
const EMPTY: RunSecrets = { values: {}, known: [] }
export { NOTHING_SELECTED_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, STEP_SECRET_UNUSED_MESSAGE }
/** What a start skips: the unchanged services left out, and each run's selection after them (null: the whole run). */
interface Skips {
  skipped: { id: string; since: string | null }[]
  sels: Map<string, RunSelection | null>
}
/**
 * How long a review keeps its start time. The lock a start writes carries that time (it is part of the
 * reviewed text), so an older review would make a fresh lock look old; past this it is reviewed again.
 * Within it, the host lock and its "started N minutes ago" can be up to this much older than the real
 * start (the release row keeps the real time), which brings LOCK_STALE_MS that much closer.
 */
export const PREVIEW_TTL_MS = REVIEW_TTL_MS
/** Reviews are dropped from memory after this; a ready release expires well before. */
const PREVIEW_KEEP_MS = 24 * 60 * 60_000
export const RESET_CUT_ROLLBACK = 'Cancelled by a vault reset; the rollback did not finish'
const TAG_FAILED = 'Deployed, but tagging'
const STALE_TEXT = (minutes: number, who: string): string => `The lock is only ${minutes} minutes old; wait or ask ${who}`

export class ReleaseService {
  private readonly d: ReleaseServiceDeps
  private readonly inv: ReleaseInventory
  private readonly live = new Map<string, Live>()
  private readonly queue = new Map<string, RunEventBody[]>()
  private readonly listeners = new Set<(batch: RunEvent[]) => void>()
  private readonly steps = new Map<string, DeploymentRunMeta['steps']>()
  /** Runs whose step list changed since the last flush; written in the same transaction as the events. */
  private readonly dirty = new Set<string>()
  /**
   * Per ready release and person (`reviewKey`), the start time their last review generated with, so two people
   * reviewing one Hub release don't undo each other's review. Memory only: a preview writes nothing.
   */
  private readonly previews = new Map<string, { releaseId: string; startedAt: string; at: number }>()
  private timer: unknown = null
  private readonly unsubscribe: () => void

  constructor(deps: ReleaseServiceDeps) {
    this.d = deps
    this.inv = deps.inventory ?? dbInventory(deps.db)
    this.unsubscribe = deps.runner.onEvent((releaseId, body) => this.push(releaseId, body))
  }

  close(): void {
    this.unsubscribe()
    this.flush()
  }

  // ---- readers ----

  list(filter: ReleaseListFilter = {}): ReleaseSummary[] {
    return this.d.releases.list({ environmentId: filter.environmentId, limit: filter.limit ?? 50, before: filter.before, operations: filter.operations })
  }

  detail(releaseId: string): ReleaseDetail {
    this.flush()
    const d = this.d.releases.detail(releaseId)
    return {
      ...d,
      playbook: d.playbook === null ? null : redact(d.playbook),
      playbookGenerated: d.playbookGenerated === null ? null : redact(d.playbookGenerated),
      error: d.error === null ? null : redact(d.error) }
  }

  events(releaseId: string, afterSeq: number, limit = 1000): RunEvent[] {
    this.flush()
    return this.d.releases.events(releaseId, afterSeq, limit)
  }

  /** Each environment's newest release that ran; its error is redacted as in `detail`. */
  latestPerEnvironment(): EnvLastRelease[] {
    return this.d.releases.latestPerEnvironment().map((r) => (r.error === null ? r : { ...r, error: redact(r.error) }))
  }

  listActive(): ReleaseSummary[] {
    return this.d.releases.active()
  }

  /** Work is in flight on this release, a preflight (or break-lock) included. */
  isBusy(releaseId: string): boolean {
    return this.live.has(releaseId)
  }

  /** A release is running or rolling back (preflights don't count: they hold no lock). */
  hasActive(): boolean {
    return [...this.live.values()].some((l) => l.phase !== 'preflight')
  }

  activeEnvironments(): string[] {
    return [...this.live.values()].filter((l) => l.phase !== 'preflight').map((l) => l.environmentName)
  }

  onEvent(fn: (batch: RunEvent[]) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Resolves when nothing is in flight (every run finished and unlocked). */
  async whenIdle(): Promise<void> {
    while (this.live.size > 0) await Promise.allSettled([...this.live.values()].map((l) => l.done))
  }

  /** Startup recovery: marks releases a quit interrupted as failed and audits each. Call once, after the stores exist. */
  recoverInterrupted(message: string = INTERRUPTED_MESSAGE): string[] {
    const ids = this.d.releases.failInterrupted(message)
    for (const id of ids) {
      const r = this.d.releases.get(id)
      const counts = { serviceCount: r.serviceCount, deploymentCount: r.deploymentCount, hostCount: r.hostCount }
      this.d.audit.append({
        actor: this.d.actor,
        action: r.operation ? 'ops.run' : 'release.finish',
        outcome: 'failure',
        targetType: 'release',
        targetId: id,
        targetLabel: `${r.environmentName} ${r.operation?.name ?? r.version ?? r.kind}`,
        details: r.operation
          ? { name: r.operation.name, outcome: 'failed', durationSec: null, interrupted: true, ...counts }
          : { status: 'failed', version: r.version, durationSec: null, interrupted: true, ...counts },
      })
    }
    return ids
  }

  // ---- preflight ----

  async preflight(req: PreflightRequest, ctx?: CallCtx): Promise<{ releaseId: string }> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const env = this.inv.environment(req.environmentId)
    const groups = resolveSelection(
      env.id,
      { serviceIds: req.serviceIds, checkoutIds: req.checkoutIds ?? [] },
      { services: this.d.services.list(env.id), deployments: this.d.deploys.list(env.id) },
    )
    await this.guard(actor, 'deploy.view', 'release.preflight', env, groups.map((g) => g.deployment.id), undefined, {
      serviceCount: groups.reduce((n, g) => n + g.selected.length, 0),
      deploymentCount: groups.length,
      hostCount: new Set(groups.map((g) => g.deployment.hostId)).size,
    })
    const deps = groups.map((g) => g.deployment)
    const sels: RunSelection[] = groups.map((g) => ({ services: runServicesOf(g), whole: g.whole }))

    const settings = this.d.deploys.settings(env.id)
    const bump = settings.versioned ? req.bump : 'none'
    const tag = settings.versioned && bump !== 'none' ? bumpVersion(settings.currentVersion, bump) : null
    const release = this.d.releases.createRelease({
      environmentId: env.id,
      kind: 'release',
      status: 'preflight',
      version: settings.versioned ? (tag ?? settings.currentVersion) : null,
      previousVersion: settings.versioned ? settings.currentVersion : null,
      versionBump: bump,
      redeploy: false,
      rollbackOf: null,
      options: req.options,
      triggeredBy: this.who(actor),
      serviceIds: groups.flatMap((g) => g.selected.map((s) => s.id)),
    })
    const runs = this.d.releases.createRuns(
      release.id,
      deps.map((x, i) => ({
        deploymentId: x.id,
        deploymentName: x.name,
        hostId: x.hostId,
        hostLabel: this.inv.hostLabel(x.hostId, env.id),
        position: i,
        branch: x.defaultBranch,
        steps: [],
        services: sels[i].services,
        wholeCheckout: sels[i].whole,
      })),
    )
    const infos: Info[] = deps.map((dep, i) => ({ dep, run: runs[i], sel: sels[i] }))
    this.seedSteps(infos, 'release', req.options.backup)
    if (req.releaseNotes) this.d.releases.setStatus(release.id, 'preflight', { releaseNotes: req.releaseNotes })
    this.emitState(release.id)

    const live = this.register(release.id, env, 'preflight', tag ?? settings.currentVersion ?? 'release', actor)
    for (const r of runs) live.runIds.add(r.id)
    live.done = this.runPreflight(live, infos, tag).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
    return { releaseId: release.id }
  }

  /**
   * Preflights a run of a runbook on some of the services it targets: a release row of kind `release` with
   * `operation` set, so it shares the release history, the host lock and the audit trail. Its preflight blocks only
   * on what the run needs (operationChecks). The param values are checked here and stored on the row; they travel
   * to the host as base64 only.
   */
  async preflightOperation(req: OperationRequest, ctx?: CallCtx): Promise<{ releaseId: string }> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    if (!this.d.runbooks) throw new DeployError('INVALID_STATE', 'Runbooks are not available here')
    if (req.serviceIds.length === 0) throw new DeployError('VALIDATION', 'Pick one or more of the services this runbook targets')
    // Access first, on the picked services alone: a caller who may not run operations learns nothing about the runbook.
    const env = this.inv.environment(req.environmentId)
    const groups = resolveSelection(env.id, { serviceIds: req.serviceIds, checkoutIds: [] }, { services: this.d.services.list(env.id), deployments: this.d.deploys.list(env.id) })
    const counts = { serviceCount: req.serviceIds.length, deploymentCount: groups.length, hostCount: new Set(groups.map((g) => g.deployment.hostId)).size }
    await this.guard(actor, 'ops.run', 'ops.preflight', env, groups.map((g) => g.deployment.id), undefined, counts)
    const rb = this.d.runbooks.get(req.runbookId)
    if (rb.environmentId !== req.environmentId) throw new DeployError('VALIDATION', 'This runbook belongs to another environment')
    const targets = new Set(rb.targetServiceIds)
    if (req.serviceIds.some((x) => !targets.has(x))) throw new DeployError('VALIDATION', 'Pick one or more of the services this runbook targets')
    const params = validateParamValues(rb.params, req.params)
    if (rb.items.some((i) => i.type === 'builtin' && i.builtin === 'backup-db')) {
      const none = groups.find((g) => !g.deployment.dbBackup || !g.deployment.backupDir)
      if (none) throw new DeployError('VALIDATION', `${none.deployment.name} has no database backup set up`)
    }
    const meta: OperationMeta = { runbookId: rb.id, name: rb.name, params, readOnly: isReadOnlyRunbook(rb), lock: rb.lock, targetServiceIds: [...req.serviceIds] }
    const deps = groups.map((g) => g.deployment)
    // Always the named services: an operation acts on what was picked, never on a whole checkout by default.
    const sels: RunSelection[] = groups.map((g) => ({ services: runServicesOf({ ...g, whole: false }), whole: false }))
    const release = this.d.releases.createRelease({
      environmentId: env.id,
      kind: 'release',
      status: 'preflight',
      version: null,
      previousVersion: null,
      versionBump: 'none',
      redeploy: false,
      rollbackOf: null,
      options: { backup: false, notify: rb.notify, qa: false },
      triggeredBy: this.who(actor),
      serviceIds: [...req.serviceIds],
      operation: meta,
    })
    const runs = this.d.releases.createRuns(
      release.id,
      deps.map((x, i) => ({
        deploymentId: x.id,
        deploymentName: x.name,
        hostId: x.hostId,
        hostLabel: this.inv.hostLabel(x.hostId, env.id),
        position: i,
        branch: x.defaultBranch,
        steps: [],
        services: sels[i].services,
        wholeCheckout: false,
      })),
    )
    const infos: Info[] = deps.map((dep, i) => ({ dep, run: runs[i], sel: sels[i] }))
    this.seedOpSteps(infos, rb)
    this.emitState(release.id)

    const live = this.register(release.id, env, 'preflight', rb.name, actor)
    live.op = meta
    for (const r of runs) live.runIds.add(r.id)
    live.done = this.runPreflight(live, infos, null, rb).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
    return { releaseId: release.id }
  }

  private async runPreflight(live: Live, infos: Info[], tag: string | null, op: Runbook | null = null): Promise<void> {
    const id = live.id
    let report: PreflightReport
    let holder: Holder | null = null
    try {
      holder = this.resolveSecrets(infos, { env: false })
      live.known = holder.secrets?.known ?? []
      const plan = this.plan('preflight', live, infos, { version: tag, holder, docker: new Map() })
      const { out, err } = await this.exec(live, plan, holder.secrets ?? EMPTY)
      if (live.cancelRequested || out?.cancelled) {
        this.finish(live, 'cancelled', 'Cancelled', null)
        return
      }
      const checks: PreflightCheck[] = this.sharedRepoChecks(live.environmentId, infos)
      if (err !== null) checks.push(this.block('ansible', err))
      else checks.push({ id: 'ansible', deploymentId: null, hostId: '', label: 'ansible', level: 'ok', message: 'ansible-playbook is available' })
      if (out?.preflight)
        report = { releaseId: id, ...out.preflight, checks: [...checks, ...out.preflight.checks], serviceCommits: serviceCommits(infos, out.preflight.commits, this.d.services.list(live.environmentId), stepBound(this.d.deploys.settings(live.environmentId).flow)) }
      else {
        if (err === null) checks.push(this.block('tools', 'Preflight did not finish; see the log'))
        report = { releaseId: id, checks, commits: {}, dockerModes: {}, composeServices: {}, serviceCommits: {}, locks: {}, commitsTotal: 0, blocked: true }
      }
    } catch (e) {
      const msg = this.red(live, e instanceof Error ? e.message : String(e))
      report = { releaseId: id, checks: [this.block(e instanceof ToolingError ? 'ansible' : 'tools', msg)], commits: {}, dockerModes: {}, composeServices: {}, serviceCommits: {}, locks: {}, commitsTotal: 0, blocked: true }
    } finally {
      this.drop(holder)
    }
    if (op !== null) report = { ...report, checks: operationChecks(report.checks, op), blocked: false }
    report.blocked = report.blocked || report.checks.some((c) => c.level === 'block')
    for (const check of report.checks) this.push(id, { type: 'preflight.check', check })
    this.push(id, { type: 'preflight.done', report })
    this.flush()
    this.setStatus(id, report.blocked ? 'blocked' : 'ready')
    const blockers = report.checks.filter((c) => c.level === 'block').length
    if (op !== null) this.audit('ops.preflight', 'success', live, { name: op.name, blockers, hostCount: this.hostCount(infos), ...this.counts(infos) })
    else this.audit('release.preflight', 'success', live, { deployments: infos.map((i) => i.dep.id), commits: report.commitsTotal, blockers, hostCount: this.hostCount(infos), ...this.counts(infos) })
    this.clearSteps(live)
  }

  // ---- start ----

  /**
   * The playbook `start` would run now, and its sha256, for review before Deploy. It builds the plan through the
   * same `releasePlan` as start. It writes nothing (no row, event or audit), takes no lock, decrypts no secret
   * (the playbook holds references only) and starts no agent. The start time it generates with is kept in memory
   * so a start bound to this hash regenerates the same text.
   */
  async previewPlaybook(releaseId: string, ctx?: CallCtx, forceServiceIds?: string[]): Promise<PlaybookPreview> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.detail(releaseId)
    this.assertStartable(rel)
    const env = this.inv.environment(rel.environmentId)
    // An access check without the denied audit row `guard` writes: start audits a denial.
    const res = await this.d.access.check(actor, rel.operation ? 'ops.run' : 'release.start', { environmentId: env.id, deploymentIds: this.depIds(rel) })
    if (!res.allowed) throw new DeployError('DENIED', redact(res.reason ?? 'Not allowed'))
    const skips = rel.operation ? NO_SKIPS : this.skips(rel, forceServiceIds)
    if (rel.operation) this.assertOpCurrent(rel)
    else this.assertCurrent(rel, env)
    const now = this.d.now()
    const startedAt = now.toISOString()
    const { playbook, inventory } = rel.operation ? this.opPlan(rel, env, actor, startedAt) : this.releasePlan(rel, env, actor, startedAt, skips)
    for (const [k, p] of this.previews) if (now.getTime() - p.at > PREVIEW_KEEP_MS) this.previews.delete(k)
    this.previews.set(reviewKey(releaseId, actor), { releaseId, startedAt, at: now.getTime() })
    return { playbook, sha256: reviewHash(playbook, skips, inventory), skippedServiceIds: skips.skipped.map((x) => x.id) }
  }

  /**
   * Checks an edited playbook against the one the preview shows (same start time, same plan). Static only:
   * nothing is written, no secret is decrypted and no agent or shell runs. The sha256 is of the canonical text,
   * which is what a start bound to this edit must carry.
   */
  async validateEdit(releaseId: string, text: string, ctx?: CallCtx, forceServiceIds?: string[]): Promise<PlaybookEditResult> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.detail(releaseId)
    this.assertStartable(rel)
    const env = this.inv.environment(rel.environmentId)
    // The same check as the preview: the errors say whether generated text matches, so they are not for everyone.
    const allowed = await this.d.access.check(actor, rel.operation ? 'ops.run' : 'release.start', { environmentId: env.id, deploymentIds: this.depIds(rel) })
    if (!allowed.allowed) throw new DeployError('DENIED', redact(allowed.reason ?? 'Not allowed'))
    if (rel.operation) this.assertOpCurrent(rel)
    else this.assertCurrent(rel, env)
    const reviewed = this.previews.get(reviewKey(releaseId, actor))
    const startedAt = reviewed?.startedAt ?? this.d.now().toISOString()
    const skips = rel.operation ? NO_SKIPS : this.skips(rel, forceServiceIds)
    const { playbook, inventory } = rel.operation ? this.opPlan(rel, env, actor, startedAt) : this.releasePlan(rel, env, actor, startedAt, skips)
    const res = validateEditedPlaybook(text, playbook, this.masked(playbook))
    // Hashed as the preview is: an unedited text has the preview's hash, and the skips and inventory stay bound.
    return res.ok ? { ok: true, canonical: res.canonical, sha256: reviewHash(res.canonical, skips, inventory) } : res
  }

  /**
   * The edit a start carries, checked again against the playbook it would otherwise run, and bound to the hash
   * `validateEdit` gave for it. Null without an edit, or when the canonical text is the generated one.
   */
  private editOf(confirm: ReleaseConfirm, generated: string, skips: Skips, inventory: string | null): { text: string; lineDelta: number } | null {
    if (confirm.editedPlaybook === undefined) return null
    const res = validateEditedPlaybook(confirm.editedPlaybook, generated, this.masked(generated))
    if (!res.ok) {
      const [first] = res.errors
      throw new DeployError('VALIDATION', first ? `${EDIT_INVALID_MESSAGE} (line ${first.line}: ${first.message})` : EDIT_INVALID_MESSAGE)
    }
    if (confirm.playbookSha256 === undefined || reviewHash(res.canonical, skips, inventory) !== confirm.playbookSha256) {
      throw new DeployError('INVALID_STATE', PLAYBOOK_CHANGED_MESSAGE)
    }
    if (res.canonical === generated) return null
    return { text: res.canonical, lineDelta: lineCount(res.canonical) - lineCount(generated) }
  }

  /** The generated playbook as the preview showed it. */
  private masked(generated: string): string {
    return maskPlaybook(generated, this.d.knownSecrets?.() ?? [])
  }

  /** The row fields a started playbook stores: the edited text with the generated one beside it, or the generated one. */
  private playbookFields(generated: string, edit: { text: string } | null): { playbook: string; playbookSource?: 'edited'; playbookGenerated?: string } {
    return edit === null ? { playbook: generated } : { playbook: edit.text, playbookSource: 'edited', playbookGenerated: generated }
  }

  /**
   * Starts a ready release. With `playbookSha256` (every start from the UI: the IPC handler refuses one without
   * it) the playbook is regenerated and must hash the same, or the start is refused before anything is written;
   * the stored playbook is then the reviewed text. Retry-tagging and rollback generate their own playbook and
   * are exempt, as are the service's own callers (tests, the Hub's start route checks it when sent).
   */
  async start(releaseId: string, confirm: ReleaseConfirm = {}, ctx?: CallCtx): Promise<void> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.detail(releaseId)
    this.assertStartable(rel)
    if (this.live.has(releaseId)) throw new DeployError('INVALID_STATE', 'This release is busy')
    const env = this.inv.environment(rel.environmentId)
    if (rel.operation) return this.startOperation(rel, rel.operation, env, confirm, actor)
    await this.guard(actor, 'release.start', 'release.start', env, this.depIds(rel), releaseId)
    this.assertStatus(releaseId, ['ready'])
    this.confirmProtected(actor, 'release.start', rel, env, rel.runs.map((r) => r.hostId).filter((h): h is string => h !== null), confirm.typedName)
    this.assertCurrent(rel, env)
    const skips = this.skips(rel, confirm.forceServiceIds)
    const redeploy = (rel.preflight?.commitsTotal ?? 0) === 0
    if (redeploy && confirm.redeploy !== true) throw new DeployError('CONFIRM_REQUIRED', REDEPLOY_CONFIRM_MESSAGE)

    this.assertCapacity(env)
    const reviewed = confirm.playbookSha256 !== undefined ? this.previews.get(reviewKey(releaseId, actor)) : undefined
    if (reviewed !== undefined && this.d.now().getTime() - reviewed.at > PREVIEW_TTL_MS) {
      throw new DeployError('INVALID_STATE', REVIEW_EXPIRED_MESSAGE)
    }
    const built = this.releasePlan(rel, env, actor, reviewed?.startedAt ?? this.d.now().toISOString(), skips)
    const edit = this.editOf(confirm, built.playbook, skips, built.inventory)
    if (confirm.editedPlaybook === undefined && confirm.playbookSha256 !== undefined && reviewHash(built.playbook, skips, built.inventory) !== confirm.playbookSha256) {
      throw new DeployError('INVALID_STATE', PLAYBOOK_CHANGED_MESSAGE)
    }
    const live = this.register(releaseId, env, 'release', rel.version ?? 'release', actor)
    let run: { infos: Info[]; holder: Holder; tag: string | null; autoRollback: boolean; previousVersion: string | null; version: string | null; edited: boolean }
    try {
      this.dropPreviews(releaseId)
      // The skips stay in memory until the last step that can refuse (decrypting) has passed.
      const infos = this.infosFor(rel, skips)
      const settings = this.d.deploys.settings(env.id)
      const holder = this.resolveSecrets(infos, { env: true, scope: 'release', flow: built.plan.flow })
      live.known = holder.secrets?.known ?? []
      const { playbook, version, docker } = built
      const plan: DeployPlan = edit === null ? built.plan : { ...built.plan, playbookText: edit.text }
      const tag = !redeploy && settings.versioned && rel.version !== null && rel.version !== settings.currentVersion ? rel.version : null
      const skippedSteps = this.d.releases.transaction(() => {
        const out = this.applySkips(rel, skips)
        for (const [runId, steps] of this.reseed(rel, plan)) out.set(runId, steps)
        this.d.releases.setStatus(releaseId, 'running', {
          startedAt: this.d.now().toISOString(),
          redeploy,
          version,
          ...(redeploy ? { versionBump: 'none' as const } : {}),
          ...this.playbookFields(playbook, edit),
        })
        return out
      })
      // In memory only once the rows are written.
      for (const [runId, steps] of skippedSteps) this.steps.set(runId, steps)
      for (const { run } of infos) if (!this.steps.has(run.id)) this.steps.set(run.id, run.steps.map((x) => ({ ...x })))
      for (const i of infos) live.runIds.add(i.run.id)
      run = { infos, holder, tag, autoRollback: settings.autoRollback, previousVersion: settings.currentVersion, version, edited: edit !== null }
      this.emitState(releaseId)
      this.audit('release.start', 'success', live, {
        kind: 'release',
        version,
        bump: redeploy ? 'none' : ((this.d.db.prepare('SELECT version_bump AS b FROM releases WHERE id = ?').get(releaseId) as { b: string }).b),
        redeploy,
        deployments: infos.map((i) => i.dep.id),
        hostCount: this.hostCount(infos),
        ...this.counts(infos),
        credentialIds: holder.secretIds,
        skippedServiceIds: skips.skipped.map((x) => x.id),
      })
      // How much the text grew or shrank, nothing of what it says.
      if (edit !== null) this.audit('playbook.edited', 'success', live, { lineDelta: edit.lineDelta })
      live.done = this.runRelease(live, run, plan, docker, rel.options.backup).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
    } catch (e) {
      this.unregister(live)
      throw e
    }
  }

  private dropPreviews(releaseId: string): void {
    for (const [k, p] of this.previews) if (p.releaseId === releaseId) this.previews.delete(k)
  }

  /** A release or an operation (an operation's row is kind `release` too). */
  private assertStartable(rel: ReleaseDetail): void {
    if (rel.kind !== 'release') throw new DeployError('INVALID_STATE', 'Only a release can be started')
    if (rel.status !== 'ready') {
      throw new DeployError('INVALID_STATE', rel.status === 'blocked' ? 'This release is blocked; fix the failed checks and run preflight again' : `This release is ${rel.status}`)
    }
  }

  /** What changed since preflight that the release cannot run with: the version, or its services. */
  private assertCurrent(rel: ReleaseDetail, env: { id: string }): void {
    const current = this.d.deploys.settings(env.id)
    if (current.versioned && current.currentVersion !== rel.previousVersion) {
      throw new DeployError('INVALID_STATE', 'The version changed since preflight; run preflight again')
    }
    this.assertSelectionCurrent(rel)
  }

  /**
   * The release plan and playbook of a ready release, as start runs it. The one code path for the preview and
   * start: the plan holds secret references only (keys named by run id), so nothing is decrypted here.
   */
  private releasePlan(
    rel: ReleaseDetail,
    env: { id: string; name: string },
    actor: Actor,
    startedAt: string,
    skips: Skips,
  ): { plan: DeployPlan; playbook: string; inventory: string | null; version: string | null; docker: Map<string, DockerMode> } {
    const infos = this.infosFor(rel, skips)
    const settings = this.d.deploys.settings(env.id)
    const redeploy = (rel.preflight?.commitsTotal ?? 0) === 0
    const version = redeploy ? settings.currentVersion : rel.version
    const docker = new Map<string, DockerMode>(Object.entries(rel.preflight?.dockerModes ?? {}))
    const flow = this.flowOf(env.id, infos)
    const refs = this.resolveSecrets(infos, { env: true, values: false, scope: 'release', flow })
    const plan = this.plan('release', { id: rel.id, environmentId: env.id, environmentName: env.name, actor }, infos, {
      flow,
      version,
      holder: refs,
      docker,
      backup: rel.options.backup,
      startedAt,
      tagCommits: rel.preflight?.commits,
      originHeads: originHeads(rel, skips),
      prepare: settings.parallelPrepare ? { cap: settings.prepareCap } : null,
    })
    // With a flow or a parallel prepare, `od` and become are inventory host vars: the review covers them as it covers play vars.
    return { plan, playbook: generatePlaybook(plan), inventory: plan.flow === null && plan.prepare === null ? null : generateInventory(plan), version, docker }
  }

  private async runRelease(
    live: Live,
    c: { infos: Info[]; holder: Holder; tag: string | null; autoRollback: boolean; previousVersion: string | null; version: string | null; edited: boolean },
    plan: DeployPlan,
    docker: Map<string, DockerMode>,
    backup: boolean,
  ): Promise<void> {
    const id = live.id
    let status: ReleaseStatus = 'failed'
    let error: string | null = null
    let notes: string | null = null
    try {
      this.push(id, { type: 'run.started', kind: 'release', version: c.version })
      live.phase = 'release'
      // Set before the run: a cancel mid-build still has its unlock stop the builds.
      if (plan.prepare !== null) live.killBuilds = plan.deployments.map((d) => ({ runId: d.runId, repoPath: d.repoPath }))
      const res = await this.exec(live, plan, c.holder.secrets ?? EMPTY)
      // Whatever else happens next (rollback, tag, finalize), the runs that succeeded now run this code.
      this.recordDeployedRuns(live, res.out)
      if (live.cancelRequested || res.out?.cancelled) {
        status = 'cancelled'
        error = 'Cancelled'
      } else if (res.err !== null || !res.out || this.failed(res.out)) {
        error = this.prepareFailed(live, c.infos, plan, res.out) ?? this.reason(live, res.out, res.err, 'Release')
        status = 'failed'
        const targets = c.autoRollback && live.busyText === null ? this.rollbackTargets(live, c.infos, res.out, plan.prepare !== null) : []
        if (targets.length > 0) {
          const rb = await this.autoRollback(live, c, targets, docker, backup)
          if (c.edited) notes = withNote(this.d.releases.detail(id).releaseNotes, ROLLBACK_GENERATED_NOTE)
          status = rb.ok ? 'rolled_back' : 'failed'
          if (live.vaultReset && !rb.ok) {
            status = 'cancelled'
            error = RESET_CUT_ROLLBACK
          } else if (!rb.ok) error = `${error}; the rollback also failed: ${rb.reason}`
        }
      } else {
        status = 'succeeded'
        if (c.tag !== null) {
          live.phase = 'version'
          const v = await this.exec(live, this.plan('version', live, c.infos, { version: c.tag, holder: null, docker }), EMPTY)
          if (v.err !== null || !v.out || v.out.cancelled || this.failed(v.out)) {
            const why = live.versionError ?? v.err ?? (v.out?.cancelled ? 'cancelled' : 'see the log')
            status = 'failed'
            error = this.red(live, `${TAG_FAILED} ${c.tag} failed: ${why}`)
          } else {
            try {
              this.d.deploys.updateSettings(live.environmentId, { currentVersion: c.tag })
              this.push(id, { type: 'version.bumped', from: c.previousVersion, to: c.tag })
            } catch (e) {
              status = 'failed'
              error = this.red(live, `Deployed and tagged ${c.tag}, but saving the version failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
        if (status === 'succeeded') notes = await this.runFinalize(live)
      }
    } catch (e) {
      status = 'failed'
      error = this.red(live, e instanceof Error ? e.message : String(e))
    } finally {
      this.dropForReset(live, c.holder)
      await this.safeUnlock(live, c.infos, c.holder)
      this.finish(live, status, error, notes, c.holder)
    }
  }

  // ---- operations ----

  /**
   * Starts a ready operation: the `ops.run` access check and typed-name rule, the same capacity and review-hash rules
   * as a release (a lock-free read-only one may run beside a release on its environment), then the run and always the
   * unlock, which also removes the run directory. Nothing is recorded as deployed, tagged or finalized.
   */
  private async startOperation(rel: ReleaseDetail, op: OperationMeta, env: EnvironmentLike, confirm: ReleaseConfirm, actor: Actor): Promise<void> {
    const releaseId = rel.id
    await this.guard(actor, 'ops.run', 'ops.run', env, this.depIds(rel), releaseId)
    this.assertStatus(releaseId, ['ready'])
    this.confirmProtected(actor, 'ops.run', { id: releaseId, version: op.name }, env, rel.runs.map((r) => r.hostId).filter((h): h is string => h !== null), confirm.typedName, {
      name: op.name,
      ...this.rowCounts(releaseId),
    })
    this.assertOpCurrent(rel)
    const lockFree = !op.lock && op.readOnly
    this.assertCapacity(env, lockFree)
    const reviewed = confirm.playbookSha256 !== undefined ? this.previews.get(reviewKey(releaseId, actor)) : undefined
    if (reviewed !== undefined && this.d.now().getTime() - reviewed.at > PREVIEW_TTL_MS) throw new DeployError('INVALID_STATE', REVIEW_EXPIRED_MESSAGE)
    const built = this.opPlan(rel, env, actor, reviewed?.startedAt ?? this.d.now().toISOString())
    const edit = this.editOf(confirm, built.playbook, NO_SKIPS, null)
    if (confirm.editedPlaybook === undefined && confirm.playbookSha256 !== undefined && reviewHash(built.playbook, NO_SKIPS, null) !== confirm.playbookSha256) {
      throw new DeployError('INVALID_STATE', PLAYBOOK_CHANGED_MESSAGE)
    }
    const live = this.register(releaseId, env, 'release', op.name, actor)
    live.op = op
    try {
      this.dropPreviews(releaseId)
      const infos = this.infosFor(rel)
      const holder = this.opSecrets(infos, built.rb, op.params, true)
      live.known = holder.secrets?.known ?? []
      this.d.releases.setStatus(releaseId, 'running', { startedAt: this.d.now().toISOString(), ...this.playbookFields(built.playbook, edit) })
      for (const { run } of infos) if (!this.steps.has(run.id)) this.steps.set(run.id, run.steps.map((x) => ({ ...x })))
      for (const i of infos) live.runIds.add(i.run.id)
      this.emitState(releaseId)
      this.audit('ops.run', 'success', live, { name: op.name, outcome: 'started', hostCount: this.hostCount(infos), ...this.counts(infos), credentialIds: holder.secretIds })
      if (edit !== null) this.audit('playbook.edited', 'success', live, { lineDelta: edit.lineDelta })
      live.done = this.runOperation(live, infos, holder, edit === null ? built.plan : { ...built.plan, playbookText: edit.text }).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
    } catch (e) {
      this.unregister(live)
      throw e
    }
  }

  private async runOperation(live: Live, infos: Info[], holder: Holder, plan: DeployPlan): Promise<void> {
    let status: ReleaseStatus = 'failed'
    let error: string | null = null
    try {
      this.push(live.id, { type: 'run.started', kind: 'release', version: null })
      live.phase = 'release'
      const res = await this.exec(live, plan, holder.secrets ?? EMPTY)
      if (live.cancelRequested || res.out?.cancelled) {
        status = 'cancelled'
        error = 'Cancelled'
      } else if (res.err !== null || !res.out || this.failed(res.out)) {
        status = 'failed'
        error = this.reason(live, res.out, res.err, 'Operation')
      } else status = 'succeeded'
      // The runner settles each run from its steps; whatever it left open ends with the operation.
      const failedRuns = new Set(res.out?.failedDeploymentRunIds ?? [])
      for (const { run } of infos) {
        const now = live.runStatus.get(run.id)
        if (now !== undefined && now !== 'pending' && now !== 'running') continue
        if (status === 'succeeded') this.applyRun(live, { type: 'deployment.updated', deploymentRunId: run.id, status: 'succeeded' })
        else if (status === 'failed' && (failedRuns.size === 0 || failedRuns.has(run.id))) this.applyRun(live, { type: 'deployment.updated', deploymentRunId: run.id, status: 'failed' })
      }
    } catch (e) {
      status = 'failed'
      error = this.red(live, e instanceof Error ? e.message : String(e))
    } finally {
      this.dropForReset(live, holder)
      // Lock or not, the unlock removes the run directory; an operation launches no builds for it to stop.
      live.killBuilds = []
      await this.safeUnlock(live, infos, holder)
      this.finish(live, status, error, null, holder)
    }
  }

  /** An operation's plan and playbook, as its preview and start build them. Holds secret references only. */
  private opPlan(rel: ReleaseDetail, env: { id: string; name: string }, actor: Actor, startedAt: string): { plan: DeployPlan; playbook: string; inventory: null; rb: Runbook } {
    const op = rel.operation as OperationMeta
    const rb = this.opRunbook(rel)
    const infos = this.infosFor(rel)
    const refs = this.opSecrets(infos, rb, op.params, false)
    const operation: PlanOperation = {
      runbookId: rb.id,
      name: op.name,
      lock: op.lock,
      items: opItems(rb, op.params, refs),
      targets: infos.map((i) => ({ runId: i.run.id, services: i.sel.services.map((e) => e.composeService) })),
    }
    const docker = new Map<string, DockerMode>(Object.entries(rel.preflight?.dockerModes ?? {}))
    const backup = rb.items.some((i) => i.type === 'builtin' && i.builtin === 'backup-db')
    const plan = this.plan('operation', { id: rel.id, environmentId: env.id, environmentName: env.name, actor }, infos, { version: null, holder: refs, docker, backup, startedAt, operation })
    return { plan, playbook: generatePlaybook(plan), inventory: null, rb }
  }

  /** The runbook as it is now, held to what preflight saw: the same name, lock, params and steps. */
  private opRunbook(rel: ReleaseDetail): Runbook {
    const op = rel.operation as OperationMeta
    if (!this.d.runbooks) throw new DeployError('INVALID_STATE', 'Runbooks are not available here')
    let rb: Runbook
    try {
      rb = this.d.runbooks.get(op.runbookId)
    } catch {
      throw new DeployError('INVALID_STATE', 'This runbook was deleted since preflight')
    }
    const first = new Set<string>()
    const same =
      rb.environmentId === rel.environmentId &&
      rb.name === op.name &&
      rb.lock === op.lock &&
      isReadOnlyRunbook(rb) === op.readOnly &&
      rel.runs.every((run) => {
        const isFirst = run.hostId !== null && !first.has(run.hostId)
        if (run.hostId !== null) first.add(run.hostId)
        return operationSteps(opItems(rb, op.params, null), isFirst).map((x) => x.key).join() === run.steps.map((x) => x.key).join()
      })
    if (!same) throw new DeployError('INVALID_STATE', 'This runbook changed since preflight; run it again')
    try {
      validateParamValues(rb.params, op.params)
    } catch {
      throw new DeployError('INVALID_STATE', 'This runbook changed since preflight; run it again')
    }
    return rb
  }

  /** Each run's services must still be in its checkout under the same compose name (a deploy since is fine). */
  private assertOpCurrent(rel: ReleaseDetail): void {
    const now = new Map(this.d.services.list(rel.environmentId).flatMap((s) => (s.kind === 'service' ? [[s.id, s] as const] : [])))
    for (const run of rel.runs) {
      if (run.deploymentId === null) throw new DeployError('INVALID_STATE', `${run.deploymentName} was removed since preflight; run it again`)
      for (const e of run.services) {
        const cur = now.get(e.id)
        if (!cur || cur.deploymentId !== run.deploymentId || cur.composeService !== e.composeService) throw new DeployError('INVALID_STATE', `${e.name} changed since preflight; run it again`)
      }
    }
    this.opRunbook(rel)
  }

  /**
   * The sudo passwords and the steps' secrets an operation needs (each one the environment already uses, S12), and
   * the param values as known values so any echo of one is masked like a secret.
   */
  private opSecrets(infos: Info[], rb: Runbook, params: Record<string, string>, values: boolean): Holder {
    const steps = rb.items.flatMap((it, i) => (it.type === 'step' ? [{ i, step: it.step }] : []))
    const holder = this.resolveSecrets(infos, { env: false, values, opSteps: steps })
    if (values && holder.secrets) holder.secrets.known.push(...Object.values(params).filter((v) => v !== ''))
    return holder
  }

  /** The step rows of an operation's runs, as generate-ops tags them (a host's first run also prunes images). */
  private seedOpSteps(infos: Info[], rb: Runbook): void {
    const first = new Set<string>()
    const items = opItems(rb, {}, null)
    for (const { run, dep } of infos) {
      const isFirst = !first.has(dep.hostId)
      first.add(dep.hostId)
      const steps = operationSteps(items, isFirst).map((x) => ({ stepId: `${run.id}:${x.key}`, kind: x.kind, label: x.label, key: x.key, state: 'pending' as const, startedAt: null, finishedAt: null }))
      this.d.releases.updateRun(run.id, { steps })
      this.steps.set(run.id, steps)
    }
  }

  private async autoRollback(
    live: Live,
    c: { infos: Info[]; holder: Holder },
    targets: { info: Info; commit: string }[],
    docker: Map<string, DockerMode>,
    backup: boolean,
  ): Promise<{ ok: boolean; reason: string }> {
    const id = live.id
    this.setStatus(id, 'rolling_back')
    this.push(id, { type: 'rollback.started', deploymentRunIds: targets.map((t) => t.info.run.id) })
    live.phase = 'rollback'
    const plan = this.plan('rollback', live, targets.map((t) => t.info), {
      version: null,
      holder: c.holder,
      docker,
      backup,
      previous: new Map(targets.map((t) => [t.info.run.id, t.commit])),
    })
    const res = await this.exec(live, plan, c.holder.secrets ?? EMPTY)
    const bad = targets.filter((t) => live.runStatus.get(t.info.run.id) === 'rollback_failed')
    const ok = res.err === null && !!res.out && res.out.exitCode === 0 && bad.length === 0 && res.out.failedDeploymentRunIds.length === 0
    if (ok) {
      for (const t of targets) {
        if (live.runStatus.get(t.info.run.id) !== 'rolled_back') this.applyRun(live, { type: 'deployment.updated', deploymentRunId: t.info.run.id, status: 'rolled_back' })
      }
      this.restoreServices(live, targets.map((t) => ({ services: t.info.sel.services, commit: t.commit })), id)
    }
    this.push(id, { type: 'rollback.done', ok })
    return { ok, reason: this.reason(live, res.out, res.err, 'Rollback') }
  }

  // ---- cancel ----

  async cancel(releaseId: string, ctx?: CallCtx): Promise<void> {
    const live = this.live.get(releaseId)
    if (!live) throw new DeployError('INVALID_STATE', 'This release is not running')
    const env = this.inv.environment(live.environmentId)
    await this.guard(ctx?.actor ?? this.d.actor, 'release.cancel', 'release.cancel', env, this.depIds(this.d.releases.detail(releaseId)), releaseId)
    this.abort(live)
    this.audit('release.cancel', 'success', live, { releaseId, ...this.rowCounts(releaseId) }, ctx?.actor)
    await live.done
  }

  /** Cancels every run and resolves once they have all unlocked (used on quit). */
  async cancelAll(): Promise<void> {
    const all = [...this.live.values()]
    for (const l of all) this.abort(l)
    await Promise.allSettled(all.map((l) => l.done))
  }

  /** A vault lock stops finalize's slow work; the steps fall back (commit-list notes) and the run still succeeds. */
  vaultLocked(): void {
    for (const l of this.live.values()) l.finalize?.abort()
  }

  /**
   * A vault reset cancels every run, past the point of no return too: a rollback holds secrets the
   * old password guarded. Only the deploy-lock release (it holds none) still runs, so the hosts
   * aren't left locked; each release ends cancelled and lets go of its secrets as it finishes.
   */
  vaultReset(): void {
    const all = [...this.live.values()]
    // Flags first (they can't throw), so a failing cancel below never leaves a release unmarked.
    for (const l of all) {
      l.vaultReset = true
      l.cancelRequested = true
    }
    for (const l of all) {
      try {
        l.finalize?.abort()
        if (l.runId !== null && l.phase !== 'unlock') this.d.runner.cancel(l.runId)
      } catch (e) {
        console.warn(redact(`Cancelling a release for the vault reset failed: ${e instanceof Error ? e.message : String(e)}`, withBase64Forms(l.known)))
      }
    }
  }

  /**
   * After a vault reset the decrypted values go before the (slow, best-effort) unlock playbook runs.
   * `known` is kept, copied, until finish, so late output is still redacted.
   */
  private dropForReset(live: Live, holder: Holder | null): void {
    if (!live.vaultReset) return
    live.known = [...live.known]
    this.drop(holder)
  }

  private abort(live: Live): void {
    live.cancelRequested = true
    live.finalize?.abort()
    // Past the point of no return (rollback, unlock) the run is allowed to finish.
    if (live.runId !== null && (live.phase === 'release' || live.phase === 'version' || live.phase === 'preflight')) this.d.runner.cancel(live.runId)
  }

  // ---- rollback ----

  async rollback(releaseId: string, confirm: ReleaseConfirm = {}, ctx?: CallCtx): Promise<{ releaseId: string }> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const src = this.d.releases.detail(releaseId)
    if (this.live.has(releaseId)) throw new DeployError('INVALID_STATE', 'This release is busy')
    const env = this.inv.environment(src.environmentId)
    await this.guard(actor, 'release.rollback', 'release.rollback', env, this.depIds(src), releaseId)
    if (src.operation !== null) throw new DeployError('INVALID_STATE', 'An operation deploys nothing, so it cannot be rolled back')
    if (src.kind !== 'release') throw new DeployError('INVALID_STATE', 'Only a release can be rolled back')
    if (src.status !== 'succeeded' && src.status !== 'failed' && src.status !== 'rolled_back') throw new DeployError('INVALID_STATE', `This release is ${src.status}`)
    // The runs the rollback rebuilds, last first: each checks out its run's previous commit.
    const eligible = src.runs
      .filter((r) => (r.status === 'succeeded' || r.status === 'failed') && r.previousCommit !== null && SHA.test(r.previousCommit) && r.deploymentId !== null)
      .reverse()
    this.assertStillCurrent(src, eligible)
    this.confirmProtected(actor, 'release.rollback', src, env, src.runs.map((r) => r.hostId).filter((h): h is string => h !== null), confirm.typedName)
    if (eligible.length === 0) {
      throw new DeployError('INVALID_STATE', src.status === 'rolled_back' ? 'Nothing to roll back: this release was already rolled back' : 'Nothing to roll back: every deployment was a first deploy')
    }

    this.assertCapacity(env)
    // What can refuse without decrypting (a step secret the environment stopped using, an invalid template) does so
    // before the rollback has a row.
    this.resolveSecrets(
      eligible.map((r) => ({ run: r, dep: this.d.deploys.get(r.deploymentId as string), sel: selectionOf(r) })),
      { env: true, values: false, scope: 'rollback' },
    )
    // The rollback's own record: each entry moves from its deployed commit to the commit the rollback checks out.
    const entries: RunService[][] = eligible.map((r) =>
      r.services.map((e) => ({ ...e, previousCommit: shaOrNull(e.deployedCommit ?? r.deployedCommit), previousReleaseId: src.id, deployedCommit: r.previousCommit })),
    )
    const rb = this.d.releases.transaction(() => {
      const rel = this.d.releases.createRelease({
        environmentId: env.id,
        kind: 'rollback',
        status: 'running',
        version: src.previousVersion,
        previousVersion: src.version,
        versionBump: 'none',
        redeploy: false,
        rollbackOf: src.id,
        options: src.options,
        triggeredBy: this.who(actor),
        serviceIds: entries.flat().map((e) => e.id),
      })
      const runs = this.d.releases.createRuns(
        rel.id,
        eligible.map((r, i) => ({
          deploymentId: r.deploymentId,
          deploymentName: r.deploymentName,
          hostId: r.hostId,
          hostLabel: r.hostLabel,
          position: i,
          branch: r.branch,
          steps: [],
          services: entries[i],
          wholeCheckout: r.wholeCheckout,
        })),
      )
      this.d.releases.setStatus(rel.id, 'running', { startedAt: this.d.now().toISOString() })
      return { rel, runs }
    })
    const live = this.register(rb.rel.id, env, 'rollback', 'rollback', actor)
    try {
      const infos: Info[] = eligible.map((r, i) => ({ run: rb.runs[i], dep: this.d.deploys.get(r.deploymentId as string), sel: selectionOf(rb.runs[i]) }))
      for (const i of infos) live.runIds.add(i.run.id)
      this.seedSteps(infos, 'rollback', false)
      const holder = this.resolveSecrets(infos, { env: true, scope: 'rollback' })
      live.known = holder.secrets?.known ?? []
      const previous = new Map(infos.map((i, n) => [i.run.id, eligible[n].previousCommit as string]))
      const docker = new Map<string, DockerMode>(Object.entries(src.preflight?.dockerModes ?? {}))
      const plan = this.plan('rollback', live, infos, { version: null, holder, docker, backup: false, previous })
      // An edit ran once: the rollback is always the generated one, and its notes say so.
      this.d.releases.setStatus(rb.rel.id, 'running', { playbook: generatePlaybook(plan), ...(src.playbookSource === 'edited' ? { releaseNotes: ROLLBACK_GENERATED_NOTE } : {}) })
      this.emitState(rb.rel.id)
      this.audit('release.rollback', 'success', live, { rollbackOf: src.id, deployments: infos.map((i) => i.dep.id), hostCount: this.hostCount(infos), ...this.counts(infos) })
      live.done = this.runRollback(live, src, infos, holder, plan).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
      return { releaseId: rb.rel.id }
    } catch (e) {
      this.finish(live, 'failed', e instanceof Error ? e.message : String(e), null)
      this.unregister(live)
      throw e
    }
  }

  private async runRollback(live: Live, src: ReleaseDetail, infos: Info[], holder: Holder, plan: DeployPlan): Promise<void> {
    const id = live.id
    let status: ReleaseStatus = 'failed'
    let error: string | null = null
    try {
      this.push(id, { type: 'run.started', kind: 'rollback', version: src.previousVersion })
      this.push(id, { type: 'rollback.started', deploymentRunIds: infos.map((i) => i.run.id) })
      live.phase = 'rollback'
      const res = await this.exec(live, plan, holder.secrets ?? EMPTY)
      const bad = infos.filter((i) => live.runStatus.get(i.run.id) === 'rollback_failed')
      const ok = res.err === null && !!res.out && res.out.exitCode === 0 && bad.length === 0 && res.out.failedDeploymentRunIds.length === 0
      this.push(id, { type: 'rollback.done', ok })
      if (ok) {
        for (const i of infos) {
          if (live.runStatus.get(i.run.id) !== 'rolled_back') this.applyRun(live, { type: 'deployment.updated', deploymentRunId: i.run.id, status: 'rolled_back' })
        }
        status = 'succeeded'
        this.setStatus(src.id, 'rolled_back')
        // Each run's services now run the commit its plan checked out; history before the source decides last_release_id.
        const checkedOut = new Map(plan.deployments.map((d) => [d.runId, d.previousCommit]))
        this.restoreServices(live, infos.map((i) => ({ services: i.sel.services, commit: checkedOut.get(i.run.id) ?? null })), src.id)
      } else {
        status = live.cancelRequested || res.out?.cancelled ? 'cancelled' : 'failed'
        error = status === 'cancelled' ? 'Cancelled' : this.reason(live, res.out, res.err, 'Rollback')
      }
    } catch (e) {
      status = 'failed'
      error = this.red(live, e instanceof Error ? e.message : String(e))
    } finally {
      this.dropForReset(live, holder)
      await this.safeUnlock(live, infos, holder)
      this.finish(live, status, error, null, holder)
    }
  }

  // ---- locks ----

  async breakLock(releaseId: string, hostId: string, confirm: BreakLockConfirm, ctx?: CallCtx): Promise<void> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.detail(releaseId)
    if (this.live.has(releaseId)) throw new DeployError('INVALID_STATE', 'This release is busy')
    const env = this.inv.environment(rel.environmentId)
    if (rel.status !== 'ready' && rel.status !== 'blocked') throw new DeployError('INVALID_STATE', `This release is ${rel.status}`)
    await this.guard(actor, 'lock.break', 'deploy.lock_break', env, [], releaseId)
    this.assertStatus(releaseId, ['ready', 'blocked'])
    const lock = rel.preflight?.locks[hostId]
    if (!lock) throw new DeployError('INVALID_STATE', 'No lock was seen on this host in preflight')
    const label = this.inv.hostLabel(hostId, rel.environmentId)
    if (!lock.stale) {
      const minutes = Math.max(0, Math.floor((this.d.now().getTime() - Date.parse(lock.holder.startedAt)) / 60000))
      throw new DeployError('INVALID_STATE', STALE_TEXT(minutes, `${lock.holder.user}@${lock.holder.machine}`))
    }
    if (confirm.typedLabel !== label) {
      this.auditRelease(actor, 'deploy.lock_break', 'denied', releaseId, env.name, rel.version ?? 'release', { reason: 'confirm', hostCount: 1 })
      throw new DeployError('CONFIRM_REQUIRED', BREAK_LOCK_CONFIRM_MESSAGE)
    }
    const infos = this.infosOf(rel).filter((i) => i.dep.hostId === hostId)
    if (infos.length === 0) throw new DeployError('INVALID_STATE', 'This release has no deployment on that host')
    const live = this.register(releaseId, env, 'preflight', rel.version ?? 'release', actor)
    const run = async (): Promise<void> => {
      const brk = this.plan('break-lock', live, infos, { version: null, holder: null, docker: new Map(), lockRaw: { [hostId]: lock.raw } })
      const a = await this.exec(live, brk, EMPTY)
      if (a.err !== null || !a.out || this.failed(a.out)) throw new DeployError('INVALID_STATE', this.reason(live, a.out, a.err, 'Breaking the lock'))
      const holder = this.resolveSecrets(infos, { env: false })
      try {
        const pre = this.plan('preflight', live, infos, { version: null, holder, docker: new Map() })
        const b = await this.exec(live, pre, holder.secrets ?? EMPTY)
        const fresh = b.out?.preflight
        if (!fresh) throw new DeployError('INVALID_STATE', this.reason(live, b.out, b.err, 'Re-checking the lock'))
        const report: PreflightReport = rel.preflight as PreflightReport
        const mine = new Set(infos.map((i) => i.dep.id))
        const kept = report.checks.filter((c) => !(c.id === 'lock' && c.deploymentId !== null && mine.has(c.deploymentId)))
        const checks = [...kept, ...fresh.checks.filter((c) => c.id === 'lock')]
        const next: PreflightReport = { ...report, checks, locks: { ...report.locks, [hostId]: fresh.locks[hostId] ?? null }, blocked: checks.some((c) => c.level === 'block') }
        this.push(releaseId, { type: 'preflight.done', report: next })
        this.flush()
        this.setStatus(releaseId, next.blocked ? 'blocked' : 'ready')
      } finally {
        this.drop(holder)
      }
    }
    let failure: unknown = null
    live.done = run().catch((e: unknown) => {
      failure = e
    })
    await live.done
    this.unregister(live)
    const details = { holder: `${lock.holder.user}@${lock.holder.machine}`, hostCount: 1 }
    if (failure) {
      this.auditRelease(actor, 'deploy.lock_break', 'failure', releaseId, env.name, rel.version ?? 'release', details)
      throw failure
    }
    this.auditRelease(actor, 'deploy.lock_break', 'success', releaseId, env.name, rel.version ?? 'release', details)
  }

  // ---- discard / retry ----

  /**
   * Re-reads the row after a guard await: a discard, start or break that ran meanwhile may have moved it,
   * and `setStatus` is unconditional, so acting on the pre-await status could overwrite `discarded`.
   */
  private assertStatus(releaseId: string, allowed: ReleaseStatus[]): void {
    const now = this.d.releases.get(releaseId).status
    if (this.live.has(releaseId) || !allowed.includes(now)) throw new DeployError('INVALID_STATE', `This release is ${now}`)
  }

  /**
   * Saves the notes edited in the wizard while the release is ready or blocked; '' clears them so finalize
   * writes its own. Not audited: it carries content, and the release itself is audited.
   */
  setNotes(releaseId: string, notes: string): void {
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.get(releaseId)
    if (rel.status !== 'ready' && rel.status !== 'blocked') throw new DeployError('INVALID_STATE', `A ${rel.status} release cannot take notes`)
    this.d.releases.setStatus(releaseId, rel.status, { releaseNotes: notes.trim() === '' ? null : notes })
  }

  /**
   * Ends a ready or blocked release. A release whose first preflight is still checking is aborted and settled
   * first: the wizard drops a preflight it no longer wants as soon as `release:preflight` answers, which is
   * always while the checks run. Any other live release (a start, a break-lock re-check) stays busy.
   */
  async discard(releaseId: string, ctx?: CallCtx): Promise<void> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.get(releaseId)
    const checking = (): Live | null => {
      const live = this.live.get(releaseId)
      if (!live) return null
      if (live.phase !== 'preflight' || this.d.releases.get(releaseId).status !== 'preflight') throw new DeployError('INVALID_STATE', 'This release is busy')
      return live
    }
    if (!checking() && rel.status !== 'ready' && rel.status !== 'blocked') throw new DeployError('INVALID_STATE', `A ${rel.status} release cannot be discarded`)
    const env = this.inv.environment(rel.environmentId)
    await this.guard(actor, 'deploy.edit', 'release.discard', env, this.depIds(this.d.releases.detail(releaseId)), releaseId)
    // Re-check after the await: a start that began meanwhile has registered and moved the row to running.
    const live = checking()
    let settled: ReleaseStatus[] = ['ready', 'blocked']
    if (live) {
      // runPreflight sees cancelRequested once its run returns and ends the row cancelled; once `done`
      // settles it can no longer write ready or blocked, so the discarded status below is final.
      this.abort(live)
      await live.done
      settled = ['ready', 'blocked', 'cancelled']
    }
    const now = this.d.releases.get(releaseId).status
    if (this.live.has(releaseId) || !settled.includes(now)) throw new DeployError('INVALID_STATE', 'This release is busy')
    // An aborted preflight already closed its stream as cancelled.
    if (now !== 'cancelled') {
      this.push(releaseId, { type: 'run.finished', status: 'cancelled' })
      this.flush()
    }
    this.dropPreviews(releaseId)
    this.d.releases.setStatus(releaseId, 'discarded', { finishedAt: this.d.now().toISOString() })
    this.emitState(releaseId)
    this.auditRelease(actor, 'release.discard', 'success', releaseId, env.name, rel.version ?? 'release', {})
  }

  async retryVersion(releaseId: string, ctx?: CallCtx): Promise<void> {
    const actor = ctx?.actor ?? this.d.actor
    this.d.vault.assertUnlocked()
    const rel = this.d.releases.detail(releaseId)
    if (this.live.has(releaseId)) throw new DeployError('INVALID_STATE', 'This release is busy')
    const env = this.inv.environment(rel.environmentId)
    await this.guard(actor, 'release.start', 'release.start', env, this.depIds(rel), releaseId)
    if (rel.operation !== null) throw new DeployError('INVALID_STATE', 'An operation has no version tag to retry')
    this.assertStatus(releaseId, ['failed'])
    const tagFailed = rel.kind === 'release' && rel.status === 'failed' && rel.version !== null && (rel.error ?? '').startsWith(TAG_FAILED)
    if (!tagFailed || rel.runs.length === 0 || !rel.runs.every((r) => r.status === 'succeeded')) {
      throw new DeployError('INVALID_STATE', 'Only a release whose deployments all succeeded and whose version tag failed can retry the tag')
    }
    this.assertCapacity(env)
    const live = this.register(releaseId, env, 'version', rel.version ?? 'release', actor)
    try {
      const infos = this.infosOf(rel)
      for (const i of infos) live.runIds.add(i.run.id)
      const tag = rel.version as string
      this.setStatus(releaseId, 'running', { error: null, finishedAt: null })
      this.audit('release.start', 'success', live, { kind: 'release', version: rel.version, bump: 'none', redeploy: false, retryVersion: true, deployments: infos.map((i) => i.dep.id), hostCount: this.hostCount(infos), ...this.counts(infos), credentialIds: [] })
      live.done = this.runRetry(live, infos, tag, rel.previousVersion).catch((e: unknown) => this.crash(live, e)).finally(() => this.unregister(live))
    } catch (e) {
      this.unregister(live)
      throw e
    }
  }

  private async runRetry(live: Live, infos: Info[], tag: string, from: string | null): Promise<void> {
    let status: ReleaseStatus = 'failed'
    let error: string | null = null
    let notes: string | null = null
    try {
      live.phase = 'version'
      this.push(live.id, { type: 'run.started', kind: 'release', version: tag })
      const v = await this.exec(live, this.plan('version', live, infos, { version: tag, holder: null, docker: new Map() }), EMPTY)
      if (v.err !== null || !v.out || v.out.cancelled || this.failed(v.out)) {
        status = 'failed'
        error = this.red(live, `${TAG_FAILED} ${tag} failed: ${live.versionError ?? v.err ?? (v.out?.cancelled ? 'cancelled' : 'see the log')}`)
      } else {
        this.d.deploys.updateSettings(live.environmentId, { currentVersion: tag })
        this.push(live.id, { type: 'version.bumped', from, to: tag })
        status = 'succeeded'
        notes = await this.runFinalize(live)
      }
    } catch (e) {
      status = 'failed'
      error = this.red(live, e instanceof Error ? e.message : String(e))
    } finally {
      await this.safeUnlock(live, infos, null)
      this.finish(live, status, error, notes, null)
    }
  }

  // ---- finalize ----

  runMeta(releaseId: string, status?: ReleaseStatus, ctx?: CallCtx): ReleaseRunMeta {
    const d = this.d.releases.detail(releaseId)
    const env = this.inv.environment(d.environmentId)
    const productId = env.productIds[0] ?? null
    const urls: string[] = []
    for (const r of d.runs) {
      if (r.deploymentId === null) continue
      try {
        for (const u of this.d.deploys.get(r.deploymentId).urls) if (!urls.includes(u.url)) urls.push(u.url)
      } catch {
        /* the deployment was deleted since */
      }
    }
    return {
      id: d.id,
      releaseId: d.id,
      kind: d.kind,
      status: status ?? d.status,
      environmentId: d.environmentId,
      environmentName: d.environmentName,
      productId,
      productName: productId === null ? null : this.inv.productName(productId),
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
      actor: ctx?.actor ?? this.live.get(releaseId)?.actor ?? this.d.actor,
      urls,
      operation: d.operation,
    }
  }

  /** notes -> notify -> qa, only after success. A throw marks just that step failed. Returns the notes. */
  private async runFinalize(live: Live): Promise<string | null> {
    const fin = this.d.finalize
    const ac = new AbortController()
    live.finalize = ac
    if (live.cancelRequested) ac.abort()
    const ctx = { run: this.runMeta(live.id, 'succeeded', { actor: live.actor }), log: (line: string) => this.push(live.id, { type: 'log', stepId: null, hostId: null, stream: 'ansible', line: this.red(live, line) }), signal: ac.signal }
    let notes: string | null = null
    const step = async (kind: StepKind, name: string, noop: boolean, fn: () => Promise<unknown>): Promise<void> => {
      const stepId = `release:${kind}`
      this.push(live.id, { type: 'step.started', stepId, kind, name, hostId: null, deploymentRunId: null })
      const t0 = this.d.now().getTime()
      if (noop) return void this.push(live.id, { type: 'step.done', stepId, state: 'skipped', durationMs: 0 })
      try {
        const out = await fn()
        if (kind === 'finalize_notes' && typeof out === 'string') notes = out
        this.push(live.id, { type: 'step.done', stepId, state: 'ok', durationMs: this.d.now().getTime() - t0 })
      } catch (e) {
        this.push(live.id, { type: 'step.failed', stepId, error: this.red(live, e instanceof Error ? e.message : String(e)), durationMs: this.d.now().getTime() - t0 })
      }
    }
    await step('finalize_notes', 'Release notes', fin.releaseNotes === noopFinalize.releaseNotes, () => fin.releaseNotes(ctx))
    await step('finalize_notify', 'Notify', fin.notify === noopFinalize.notify, () => fin.notify(ctx))
    await step('finalize_qa', 'QA', fin.qa === noopFinalize.qa, () => fin.qa(ctx))
    live.finalize = null
    return notes
  }

  // ---- running a plan ----

  private async exec(live: Live, plan: DeployPlan, secrets: RunSecrets): Promise<{ out: RunOutcome | null; err: string | null }> {
    live.failure = null
    if (live.cancelRequested && (plan.kind === 'release' || plan.kind === 'version' || plan.kind === 'preflight' || plan.kind === 'operation' || (live.vaultReset && plan.kind !== 'unlock'))) {
      return { out: { exitCode: null, signal: null, cancelled: true, failedDeploymentRunIds: [], reachedCheckout: [], commits: {} }, err: null }
    }
    try {
      const handle = this.d.runner.start(plan, secrets)
      live.runId = handle.runId
      const out = await handle.done
      return { out, err: null }
    } catch (e) {
      return { out: null, err: this.red(live, e instanceof Error ? e.message : String(e)) }
    } finally {
      live.runId = null
    }
  }

  /** Unlock is best-effort at the end of a run: a failure to even build its plan must not strand the release row. */
  private async safeUnlock(live: Live, infos: Info[], holder: Holder | null): Promise<void> {
    try {
      await this.unlock(live, infos, holder)
    } catch (e) {
      this.push(live.id, { type: 'log', stepId: null, hostId: null, stream: 'ansible', line: this.red(live, `Unlock failed: ${e instanceof Error ? e.message : String(e)}`) })
    }
  }

  /** A throw nothing else caught: end the row failed instead of leaving it preflight/running with an unhandled rejection. */
  private crash(live: Live, e: unknown): void {
    try {
      const status = this.d.releases.get(live.id).status
      if (status === 'preflight' || status === 'running' || status === 'rolling_back') this.finish(live, 'failed', e instanceof Error ? e.message : String(e), null)
    } catch {
      /* the store itself is failing; startup recovery will mark the row */
    }
  }

  private async unlock(live: Live, infos: Info[], holder: Holder | null): Promise<void> {
    void holder
    live.phase = 'unlock'
    if (infos.length === 0) return
    const res = await this.exec(live, this.plan('unlock', live, infos, { version: null, holder: null, docker: new Map(), killBuilds: live.killBuilds }), EMPTY)
    if (res.err !== null || !res.out || this.failed(res.out)) {
      this.push(live.id, { type: 'log', stepId: null, hostId: null, stream: 'err', line: this.red(live, `Could not release the deploy lock: ${res.err ?? 'see the log'}`) })
    }
  }

  private failed(out: RunOutcome): boolean {
    return out.exitCode !== 0 || out.failedDeploymentRunIds.length > 0
  }

  private reason(live: Live, out: RunOutcome | null, err: string | null, what: string): string {
    const msg = live.busyText ?? live.failure ?? err ?? (out?.exitCode != null ? `${what} failed (exit ${out.exitCode})` : `${what} failed`)
    return this.red(live, msg)
  }

  /**
   * A parallel prepare that failed before any service went up: which checkout failed, and that nothing was restarted.
   * Null when something went up, or no checkout's step failed (a lock refusal, an unreachable host).
   */
  private prepareFailed(live: Live, infos: Info[], plan: DeployPlan, out: RunOutcome | null): string | null {
    if (plan.prepare === null || live.busyText !== null || live.upped.size > 0 || (out?.reachedUp ?? []).length > 0) return null
    const run = live.failedStep?.split(':')[0]
    const info = infos.find((i) => i.run.id === run)
    if (!info) return null
    const names = info.sel.services.map((x) => x.name)
    const svc = names.length > 0 ? names.join(', ') : info.dep.name
    const checkedOut = new Set([...(out?.reachedCheckout ?? []), ...live.checkedOut])
    // before its checkout the failed one's server is still on the old commit
    if (!checkedOut.has(info.run.id)) return PREPARE_FETCH_FAILED_MESSAGE(svc, checkedOut.size > 0)
    return PREPARE_FAILED_MESSAGE(svc)
  }

  /** The runs a rollback undoes: those that reached checkout, or with a parallel prepare only those that reached up. */
  private rollbackTargets(live: Live, infos: Info[], out: RunOutcome | null, prepared = false): { info: Info; commit: string }[] {
    const reached = prepared ? new Set([...(out?.reachedUp ?? []), ...live.upped]) : new Set([...(out?.reachedCheckout ?? []), ...live.checkedOut])
    const rows = new Map(this.d.releases.detail(live.id).runs.map((r) => [r.id, r]))
    const targets: { info: Info; commit: string }[] = []
    for (const info of infos) {
      if (!reached.has(info.run.id)) continue
      const commit = out?.commits[info.run.id]?.previous ?? rows.get(info.run.id)?.previousCommit ?? null
      // A first deploy has nothing to go back to.
      if (commit && SHA.test(commit)) targets.push({ info, commit })
    }
    return targets.reverse()
  }

  // ---- finishing ----

  private finish(live: Live, status: ReleaseStatus, error: string | null, notes: string | null, holder?: Holder | null): void {
    const id = live.id
    const now = this.d.now().toISOString()
    try {
      for (const run of this.d.releases.detail(id).runs) {
        if (run.status === 'pending') this.d.releases.updateRun(run.id, { status: 'skipped', finishedAt: now })
        else if (run.status === 'running') this.d.releases.updateRun(run.id, { status: status === 'cancelled' ? 'cancelled' : 'failed', finishedAt: now })
      }
    } catch {
      /* the release row is the source of truth; a sweep failure must not block the final status */
    }
    const finished = status === 'succeeded' || status === 'failed' || status === 'rolled_back' || status === 'cancelled' ? status : 'failed'
    const safe = error === null ? null : this.red(live, error)
    this.push(id, { type: 'run.finished', status: finished, ...(safe !== null ? { error: safe } : {}) })
    this.flush()
    this.d.releases.setStatus(id, status, { finishedAt: now, error: safe, ...(notes !== null ? { releaseNotes: notes } : {}) })
    this.emitState(id)
    const row = this.d.releases.get(id)
    const durationSec = row.startedAt ? Math.max(0, Math.round((Date.parse(now) - Date.parse(row.startedAt)) / 1000)) : 0
    const outcome = status === 'succeeded' ? 'success' : status === 'cancelled' ? 'info' : 'failure'
    // An operation's preflight that ends (a cancel, a crash) is not a run: only a started one is audited as ops.run.
    if (live.op !== null && live.phase === 'preflight') this.audit('ops.preflight', outcome, live, { name: live.op.name, outcome: status, serviceCount: row.serviceCount, deploymentCount: row.deploymentCount, hostCount: row.hostCount })
    else if (live.op !== null) this.audit('ops.run', outcome, live, { name: live.op.name, outcome: status, durationSec, ...(live.failedStep ? { failedStep: live.failedStep } : {}), serviceCount: row.serviceCount, deploymentCount: row.deploymentCount, hostCount: row.hostCount })
    else this.audit('release.finish', outcome, live, {
      status,
      version: row.version,
      durationSec,
      ...(live.failedStep ? { failedStep: live.failedStep } : {}),
      serviceCount: row.serviceCount,
      deploymentCount: row.deploymentCount,
      hostCount: row.hostCount,
    })
    this.drop(holder)
    live.known = []
    this.clearSteps(live)
  }

  // ---- plans and secrets ----

  private plan(
    kind: PlanKind,
    live: Pick<Live, 'id' | 'environmentId' | 'environmentName' | 'actor'>,
    infos: Info[],
    o: {
      version: string | null
      holder: Holder | null
      docker: Map<string, DockerMode>
      backup?: boolean
      previous?: Map<string, string>
      lockRaw?: Record<string, string>
      /** The lock's start time; a reviewed release passes the review's, so the text matches. */
      startedAt?: string
      /** Preflight's commits per checkout: a step's `when changed` base falls back to the deploy tag's commit. */
      tagCommits?: PreflightReport['commits']
      /** Release only: per run with skipped services, the origin head its preflight saw (see expectOriginHead). */
      originHeads?: Map<string, string>
      /** Release only: the environment's flow as this release's stages (flowOf). */
      flow?: PlanFlow | null
      /** Release only: the parallel prepare, from the environment's settings. */
      prepare?: { cap: number } | null
      /** Unlock only: the builds a parallel prepare launched. */
      killBuilds?: { runId: string; repoPath: string }[]
      /** Operation only: what the runbook runs. */
      operation?: PlanOperation
    },
  ): DeployPlan {
    const hosts = this.planHosts(live.environmentId, infos)
    const metas = new Map(this.d.services.list(live.environmentId).map((s) => [s.id, s]))
    const deployments: PlanDeployment[] = infos.map(({ run, dep, sel }) => ({
      runId: run.id,
      deploymentId: dep.id,
      name: dep.name,
      hostId: dep.hostId,
      repoPath: dep.repoPath,
      branch: dep.defaultBranch,
      composeFile: dep.composeFile,
      deployTag: dep.deployTag,
      healthStatus: dep.healthStatus,
      healthTimeoutSec: dep.healthTimeoutSec,
      backup: (kind === 'release' || kind === 'operation') && o.backup && dep.dbBackup && dep.backupDir ? { dir: dep.backupDir, label: dep.name } : null,
      // The hooks run as the migrated steps (effectiveSteps), never as hooks.
      preHookB64: null,
      postHookB64: null,
      buildTimeoutSec: dep.buildTimeoutSec,
      composeTimeoutSec: dep.composeTimeoutSec,
      docker: o.docker.get(dep.id) ?? (dep.useSudo === 'yes' ? 'sudo' : 'plain'),
      envSecretKey: o.holder?.envKey.get(run.id) ?? null,
      becomeSecretKey: o.holder?.becomeKey.get(run.id) ?? null,
      previousCommit: kind === 'rollback' ? (o.previous?.get(run.id) ?? null) : null,
      useSudo: dep.useSudo,
      composeProject: dep.composeProject,
      ...this.stepFields(kind, run.id, dep, planFields(dep, sel, metas), o.holder, o.tagCommits),
      ...(o.originHeads?.has(run.id) ? { expectOriginHead: o.originHeads.get(run.id) } : {}),
    }))
    return {
      releaseId: live.id,
      kind,
      environment: { id: live.environmentId, name: live.environmentName },
      version: o.version,
      actor: live.actor,
      hosts,
      deployments,
      secretRefs: o.holder?.refs ?? {},
      lock: o.lockRaw ? { expectRaw: o.lockRaw } : {},
      startedAt: o.startedAt ?? this.d.now().toISOString(),
      flow: kind === 'release' ? (o.flow ?? null) : null,
      prepare: kind === 'release' ? (o.prepare ?? null) : null,
      ...(kind === 'unlock' && o.killBuilds && o.killBuilds.length > 0 ? { killBuilds: o.killBuilds } : {}),
      ...(kind === 'operation' && o.operation ? { operation: o.operation } : {}),
    }
  }

  /** The environment's release flow as stages of these runs (flowStages); null when it has none. */
  private flowOf(environmentId: string, infos: Info[]): PlanFlow | null {
    const flow = this.d.deploys.settings(environmentId).flow
    const stages = flowStages(flow, infos, new Map(this.d.services.list(environmentId).map((s) => [s.id, s])))
    return flow === null || stages === null ? null : { stages, onFailure: flow.onFailure }
  }

  /**
   * A checkout's custom steps (saved, or its migrated hooks) as a release or rollback runs them, with their
   * secrets' keys from the holder; other plans run none. A rollback keeps only `alsoOnRollback` steps, under the
   * keys they have in a release. `whenBase` is the commit a `when changed` step diffs from: the one previous
   * commit every entry shares, else the deploy tag's commit when no entry has one; anything else is null (the
   * step runs).
   */
  private stepFields(
    kind: PlanKind,
    runId: string,
    dep: DeploymentMeta,
    f: Pick<PlanDeployment, 'services' | 'urls' | 'commitBases'>,
    holder: Holder | null,
    tagCommits: PreflightReport['commits'] | undefined,
  ): Pick<PlanDeployment, 'services' | 'urls' | 'commitBases' | 'steps' | 'whenBase'> {
    if (kind !== 'release' && kind !== 'rollback') return { ...f, steps: [], whenBase: null }
    const steps = planStepsOf(dep, (i, n) => holder?.stepKey.get(`${runId}:${i}:${n}`) ?? '').filter((p) => kind === 'release' || p.alsoOnRollback === true)
    const { shas, tag } = f.commitBases
    const tagCommit = tagCommits?.[dep.id]?.tagCommit ?? null
    const whenBase = kind === 'rollback' ? null : shas.length === 1 && !tag ? shas[0] : shas.length === 0 && tag && tagCommit !== null && SHA.test(tagCommit) ? tagCommit : null
    return { ...f, steps, whenBase }
  }

  /** One alias per distinct hop path, so two hosts behind the same jump host share its hop. */
  private planHosts(environmentId: string, infos: Info[]): PlanHost[] {
    const aliases = new Map<string, string>()
    const aliasOf = (path: string): string => {
      let a = aliases.get(path)
      if (!a) {
        a = `od-${aliases.size}`
        aliases.set(path, a)
      }
      return a
    }
    const out: PlanHost[] = []
    for (const hostId of [...new Set(infos.map((i) => i.dep.hostId))]) {
      const resolved = this.d.resolve(hostId, environmentId)
      const label = this.inv.hostLabel(hostId, environmentId)
      const chain = [
        ...resolved.chain.map((h) => ({ hostId: h.hostId as string | null, label: h.label, address: h.address, port: h.port, identity: h.identity })),
        { hostId: hostId as string | null, label, address: resolved.address, port: resolved.port.value, identity: resolved.identity },
      ]
      const path: string[] = []
      const hops: PlanHop[] = chain.map((h) => {
        path.push(h.hostId ?? `${h.address}:${h.port}`)
        const id = h.identity
        return {
          alias: aliasOf(path.join('>')),
          hostId: h.hostId,
          label: h.label,
          address: h.address,
          port: h.port,
          user: id.username,
          auth: id.source === 'global' ? 'default' : id.auth === 'agent' ? 'agent' : 'key',
        }
      })
      out.push({ hostId, label, alias: hops[hops.length - 1].alias, hops })
    }
    return out
  }

  /**
   * Decrypts what a plan needs, once. `env` false resolves only the sudo passwords (preflight). `values` false
   * names the same keys and references without decrypting anything (the playbook preview). With `env`, the custom
   * steps of `scope` (a release's, or the rollback's `alsoOnRollback` ones) get their secrets too, each of which
   * must be one the environment's env templates or sudo passwords already use (S12).
   */
  private resolveSecrets(infos: Info[], o: { env: boolean; values?: boolean; scope?: 'release' | 'rollback'; flow?: PlanFlow | null; opSteps?: { i: number; step: StepBody }[] }): Holder {
    const environmentId = infos[0]?.dep.environmentId
    const values: Record<string, string> = {}
    const known = new Set<string>()
    const cache = new Map<string, string>()
    const value = (secretId: string): string => {
      if (o.values === false) return ''
      let v = cache.get(secretId)
      if (v === undefined) {
        v = this.d.secrets.value(secretId, environmentId)
        cache.set(secretId, v)
        if (v) known.add(v)
      }
      return v
    }
    const holder: Holder = { secrets: null, envKey: new Map(), becomeKey: new Map(), stepKey: new Map(), secretIds: [], refs: {} }
    const allowed = o.env || o.opSteps ? this.usedSecrets(environmentId) : new Set<string>()
    for (const { run, dep } of infos) {
      if (dep.becomeSecretId) {
        const key = `BECOME_${run.id.replace(/-/g, '_')}`
        values[key] = value(dep.becomeSecretId)
        holder.becomeKey.set(run.id, key)
        holder.refs[key] = { secretId: dep.becomeSecretId }
      }
      if (o.env && dep.managedEnv && dep.envTemplate) {
        const parsed = parseEnvTemplate(dep.envTemplate)
        if (parsed.errors.length > 0) throw new Error(`The .env template of ${dep.name} is invalid`)
        const resolved = new Map(parsed.secretIds.map((sid) => [sid, value(sid)]))
        const key = `ENV_${run.id.replace(/-/g, '_')}`
        values[key] = o.values === false ? '' : renderEnvTemplate(parsed.lines, resolved)
        for (const l of o.values === false ? [] : parsed.lines) {
          if ('key' in l) {
            const v = l.value.kind === 'text' ? l.value.text : (resolved.get(l.value.secretId) ?? '')
            if (v) known.add(v)
          }
        }
        holder.envKey.set(run.id, key)
        holder.refs[key] = { envTemplate: { deploymentId: dep.id } }
      }
      if (!o.env) continue
      effectiveSteps(dep).forEach((st, i) => {
        if ((o.scope ?? 'release') === 'rollback' && !st.alsoOnRollback) return
        st.secrets.forEach((x, n) => {
          if (!allowed.has(x.secretId)) throw new DeployError('VALIDATION', STEP_SECRET_UNUSED_MESSAGE)
          const key = `STEP_${run.id.replace(/-/g, '_')}_${i}_${n}`
          values[key] = value(x.secretId)
          holder.stepKey.set(`${run.id}:${i}:${n}`, key)
          holder.refs[key] = { secretId: x.secretId }
        })
      })
    }
    // A flow's step stages, under the keys flowStages gave them, held to the same rule (S12).
    for (const st of o.env ? (o.flow?.stages ?? []) : []) {
      if (st.kind !== 'step') continue
      st.step.secretKeys.forEach((x, n) => {
        const secretId = st.step.step.secrets[n]?.secretId
        if (secretId === undefined || !allowed.has(secretId)) throw new DeployError('VALIDATION', STEP_SECRET_UNUSED_MESSAGE)
        values[x.key] = value(secretId)
        holder.refs[x.key] = { secretId }
      })
    }
    // An operation's steps, once for every run (the item is the same on each), held to the same rule (S12).
    for (const { i, step } of o.opSteps ?? []) {
      step.secrets.forEach((x, n) => {
        if (!allowed.has(x.secretId)) throw new DeployError('VALIDATION', STEP_SECRET_UNUSED_MESSAGE)
        const key = `OPSTEP_${i}_${n}`
        values[key] = value(x.secretId)
        holder.stepKey.set(`op:${i}:${n}`, key)
        holder.refs[key] = { secretId: x.secretId }
      })
    }
    holder.secrets = { values, known: [...known] }
    holder.secretIds = [...cache.keys()]
    return holder
  }

  /** The secrets the environment already uses: every checkout's sudo password and managed env template's secrets. */
  private usedSecrets(environmentId: string | undefined): Set<string> {
    const out = new Set<string>()
    if (environmentId === undefined) return out
    for (const d of this.d.deploys.list(environmentId)) {
      if (d.becomeSecretId) out.add(d.becomeSecretId)
      if (d.managedEnv && d.envTemplate) for (const id of parseEnvTemplate(d.envTemplate).secretIds) out.add(id)
    }
    return out
  }

  /**
   * The services a start of this release leaves out: each `skippable` one (unchanged since its last deploy) not
   * forced, with each run's selection after them. Refuses a forced id the release does not run, and a start
   * whose every run would be left out.
   */
  private skips(rel: ReleaseDetail, force: readonly string[] = []): Skips {
    const runs = new Set(rel.serviceIds)
    if (force.some((x) => !runs.has(x))) throw new DeployError('VALIDATION', 'forceServiceIds names a service this release does not run')
    const forced = new Set(force)
    const commits = rel.preflight?.serviceCommits ?? {}
    // A service a flow step stage is bound to always deploys, so its step runs (and its row is never left pending).
    const bound = stepBound(this.d.deploys.settings(rel.environmentId).flow)
    const skip = new Set(Object.entries(commits).flatMap(([x, c]) => (c.skippable === true && !forced.has(x) && !bound.has(x) ? [x] : [])))
    const out: Skips = { skipped: [], sels: new Map() }
    for (const run of rel.runs) {
      const r = skipServices(selectionOf(run), skip)
      if (r.skipped.length === 0) continue
      out.sels.set(run.id, r.sel)
      for (const x of r.skipped) out.skipped.push({ id: x, since: commits[x]?.since ?? null })
    }
    if (rel.runs.length > 0 && rel.runs.every((r) => out.sels.get(r.id) === null)) throw new DeployError('INVALID_STATE', NOTHING_SELECTED_MESSAGE)
    return out
  }

  /**
   * Writes a start's skips: a run left with nothing is skipped (and its steps), the others keep what is left.
   * Returns the skipped runs' steps for the caller to hold once the transaction has committed.
   */
  private applySkips(rel: ReleaseDetail, skips: Skips): Map<string, DeploymentRunMeta['steps']> {
    const out = new Map<string, DeploymentRunMeta['steps']>()
    for (const run of rel.runs) {
      if (!skips.sels.has(run.id)) continue
      const sel = skips.sels.get(run.id) ?? null
      if (sel === null) {
        const steps = run.steps.map((x) => ({ ...x, state: 'skipped' as const }))
        this.d.releases.updateRun(run.id, { status: 'skipped', steps })
        out.set(run.id, steps)
      } else this.d.releases.setRunServices(run.id, sel.services, sel.whole)
    }
    return out
  }

  /**
   * Rewrites, as pending, the step rows of each run whose rows no longer match what the plan runs (a partial skip,
   * or a flow edited since preflight), so a finished run never keeps a row for a step it did not have. Returns them.
   */
  private reseed(rel: ReleaseDetail, plan: DeployPlan): Map<string, DeploymentRunMeta['steps']> {
    const out = new Map<string, DeploymentRunMeta['steps']>()
    const list = stepList('release', plan.deployments, plan.flow)
    for (const run of rel.runs) {
      const want = list.get(run.id)
      if (want === undefined || want.map((x) => x.key).join() === run.steps.map((x) => x.key).join()) continue
      const steps = want.map((x) => ({ stepId: `${run.id}:${x.key}`, kind: x.kind, label: x.label, key: x.key, state: 'pending' as const, startedAt: null, finishedAt: null }))
      this.d.releases.updateRun(run.id, { steps })
      out.set(run.id, steps)
    }
    return out
  }

  // ---- bookkeeping ----

  private infosOf(rel: ReleaseDetail): Info[] {
    const infos = this.infosFor(rel)
    for (const { run } of infos) if (!this.steps.has(run.id)) this.steps.set(run.id, run.steps.map((x) => ({ ...x })))
    return infos
  }

  /** `infosOf` without taking the runs' step lists into memory. With `skips`, as a start that skips them runs. */
  private infosFor(rel: ReleaseDetail, skips?: Skips): Info[] {
    return rel.runs.flatMap((run) => {
      if (run.deploymentId === null) throw new DeployError('INVALID_STATE', `${run.deploymentName} was removed since preflight; run preflight again`)
      const sel = skips?.sels.has(run.id) ? (skips.sels.get(run.id) ?? null) : selectionOf(run)
      return sel === null ? [] : [{ run, dep: this.d.deploys.get(run.deploymentId), sel }]
    })
  }

  /** The steps the playbook will run for a deployment, as pending rows (8b renders them before any event arrives). */
  private seedSteps(infos: Info[], kind: 'release' | 'rollback', backup: boolean): void {
    const metas = new Map(this.d.services.list(infos[0]?.dep.environmentId).map((s) => [s.id, s]))
    const list = stepList(
      kind,
      infos.map(({ run, dep, sel }) => ({
        runId: run.id,
        backup: kind === 'release' && backup && dep.dbBackup && dep.backupDir ? {} : null,
        envSecretKey: dep.managedEnv && dep.envTemplate ? 'env' : null,
        urls: planFields(dep, sel, metas).urls,
        steps: planStepsOf(dep, () => ''),
      })),
      kind === 'release' && infos.length > 0 ? this.flowOf(infos[0].dep.environmentId, infos) : null,
    )
    for (const { run } of infos) {
      const steps = (list.get(run.id) ?? []).map((x) => ({ stepId: `${run.id}:${x.key}`, kind: x.kind, label: x.label, key: x.key, state: 'pending' as const, startedAt: null, finishedAt: null }))
      this.d.releases.updateRun(run.id, { steps })
      this.steps.set(run.id, steps)
    }
  }

  private depIds(rel: ReleaseDetail): string[] {
    return rel.runs.flatMap((r) => (r.deploymentId === null ? [] : [r.deploymentId]))
  }

  /**
   * One run per environment, MAX_ACTIVE_RELEASES in all. A lock-free read-only operation (`lockFree`) holds no host
   * lock, so it neither waits for nor blocks the one run of its environment; it still counts toward the total.
   */
  private assertCapacity(env: { id: string; name: string }, lockFree = false): void {
    const running = [...this.live.values()].filter((l) => l.phase !== 'preflight')
    const holdsEnv = (l: Live): boolean => l.environmentId === env.id && !(l.op !== null && !l.op.lock && l.op.readOnly)
    if (!lockFree && running.some(holdsEnv)) throw new DeployError('BUSY', `A release is already running on ${env.name}`)
    if (running.length >= MAX_ACTIVE_RELEASES) throw new DeployError('BUSY', `At most ${MAX_ACTIVE_RELEASES} releases can run at once`)
  }

  private register(id: string, env: { id: string; name: string }, phase: Phase, label: string, actor: Actor): Live {
    // The guards above ran before an await; the check here is the one that cannot interleave.
    if (this.live.has(id)) throw new DeployError('INVALID_STATE', 'This release is busy')
    const live: Live = {
      id,
      actor,
      environmentId: env.id,
      environmentName: env.name,
      phase,
      runId: null,
      cancelRequested: false,
      vaultReset: false,
      done: Promise.resolve(),
      runStatus: new Map(),
      checkedOut: new Set(),
      upped: new Set(),
      killBuilds: [],
      runIds: new Set(),
      failure: null,
      versionError: null,
      busyText: null,
      known: [],
      label,
      failedStep: null,
      finalize: null,
      op: null,
    }
    this.live.set(id, live)
    return live
  }

  private unregister(live: Live): void {
    if (this.live.get(live.id) === live) this.live.delete(live.id)
  }

  private async guard(
    actor: Actor,
    action: DeployAction,
    auditAction: AuditAction,
    env: { id: string; name: string },
    deploymentIds: string[],
    releaseId?: string,
    counts?: ReleaseCounts,
  ): Promise<void> {
    const res = await this.d.access.check(actor, action, { environmentId: env.id, deploymentIds })
    if (res.allowed) return
    this.d.audit.append({
      actor,
      action: auditAction,
      outcome: 'denied',
      targetType: releaseId ? 'release' : 'environment',
      targetId: releaseId ?? env.id,
      targetLabel: releaseId ? `${env.name} release` : env.name,
      details: { reason: 'access', ...(releaseId ? this.rowCounts(releaseId) : counts) },
    })
    throw new DeployError('DENIED', redact(res.reason ?? 'Not allowed'))
  }

  private audit(action: AuditAction, outcome: 'success' | 'failure' | 'denied' | 'info', live: Live, details: Record<string, unknown>, actor?: Actor): void {
    this.d.audit.append({ actor: actor ?? live.actor, action, outcome, targetType: 'release', targetId: live.id, targetLabel: `${live.environmentName} ${live.label}`, details })
  }

  /**
   * Audit rows name the release and carry ids and counts only: never a host label, address, path or secret. A
   * `release.*` row gets the release's stored counts.
   */
  private auditRelease(actor: Actor, action: AuditAction, outcome: 'success' | 'failure' | 'denied' | 'info', releaseId: string, envName: string, label: string, details: Record<string, unknown>): void {
    const counts = action.startsWith('release.') ? this.rowCounts(releaseId) : {}
    this.d.audit.append({ actor, action, outcome, targetType: 'release', targetId: releaseId, targetLabel: `${envName} ${label}`, details: { ...details, ...counts } })
  }

  /** The counts a release row derives from its runs. */
  private rowCounts(releaseId: string): ReleaseCounts {
    const r = this.d.releases.get(releaseId)
    return { serviceCount: r.serviceCount, deploymentCount: r.deploymentCount, hostCount: r.hostCount }
  }

  /** Wipes the decrypted values in place (anything still holding the object sees nothing) and lets go of it. */
  private drop(holder: Holder | null | undefined): void {
    if (!holder) return
    if (holder.secrets) {
      for (const k of Object.keys(holder.secrets.values)) delete holder.secrets.values[k]
      holder.secrets.known.length = 0
    }
    holder.secrets = null
  }

  private hostCount(infos: Info[]): number {
    return new Set(infos.map((i) => i.dep.hostId)).size
  }

  private counts(infos: Info[]): { serviceCount: number; deploymentCount: number } {
    return { serviceCount: infos.reduce((n, i) => n + i.sel.services.length, 0), deploymentCount: infos.length }
  }

  /** Each run's services must still be what preflight saw: same checkout, same compose name, and no checkout gained or lost one. */
  private assertSelectionCurrent(rel: ReleaseDetail): void {
    const now = new Map(this.d.services.list(rel.environmentId).flatMap((s) => (s.kind === 'service' ? [[s.id, s] as const] : [])))
    for (const run of rel.runs) {
      for (const e of run.services) {
        const cur = now.get(e.id)
        if (!cur || cur.deploymentId !== run.deploymentId || cur.composeService !== e.composeService) {
          throw new DeployError('INVALID_STATE', `${e.name} changed since preflight; run preflight again`)
        }
        // Another release deployed it after this preflight: the entry's previous commit is stale.
        if (cur.lastDeployedCommit !== e.previousCommit || cur.lastReleaseId !== e.previousReleaseId) {
          throw new DeployError('INVALID_STATE', `${e.name} was deployed since preflight; run preflight again`)
        }
      }
      if (run.deploymentId === null || (run.services.length === 0 && !run.wholeCheckout)) continue
      const inCheckout = [...now.values()].filter((s) => s.deploymentId === run.deploymentId).map((s) => s.id)
      const mine = new Set(run.services.map((e) => e.id))
      // A whole run lists every service the checkout had; a partial one left at least one out.
      const changed = run.wholeCheckout ? inCheckout.length !== mine.size || inCheckout.some((id) => !mine.has(id)) : inCheckout.length <= mine.size
      if (changed) throw new DeployError('INVALID_STATE', `${run.deploymentName} changed since preflight; run preflight again`)
    }
  }

  /**
   * Manual rollback only while every service it rebuilds is still where this release left it: no later release or
   * rollback has deployed it, other than a rollback of a release newer than this one, and its record is on this release
   * when this release recorded it, or on the release it was on before when this release's run did not. Rolling back R2
   * moves the record back to R1, so R1 can be rolled back next; rolling back R1 blocks a later R2.
   */
  private assertStillCurrent(src: ReleaseDetail, eligible: DeploymentRunMeta[]): void {
    const entries = [...eligible].reverse().flatMap((run) => run.services.map((e) => ({ e, recorded: run.status === 'succeeded' && !run.rolledBack && e.deployedCommit !== null })))
    const now = new Map(this.d.services.list(src.environmentId).flatMap((s) => (s.kind === 'service' ? [[s.id, s.lastReleaseId] as const] : [])))
    // A later deploy blocks even when the record matches: one that reported no commit left the record alone, and a
    // rollback of an earlier release put it back where this release expects it.
    const later = this.d.releases.latestTouching(entries.map(({ e }) => e.id), src.id)
    // Services in run order, though the rollback walks the runs last first, grouped by the release each is on now.
    const moved = new Map<string | null, string[]>()
    for (const { e, recorded } of entries) {
      // A deleted service has nothing to restore.
      if (!now.has(e.id)) continue
      const newer = later.get(e.id)
      const cur = newer !== undefined && newer > src.id ? newer : (now.get(e.id) ?? null)
      if (cur === (recorded ? src.id : e.previousReleaseId)) continue
      const names = moved.get(cur) ?? []
      if (!names.includes(e.name)) moved.set(cur, [...names, e.name])
    }
    if (moved.size === 0) return
    if (src.status === 'rolled_back') throw new DeployError('INVALID_STATE', 'Nothing to roll back: this release was already rolled back')
    const parts = [...moved].map(([id, names]) => `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} now on ${id === null ? 'no recorded release' : this.releaseLabel(id)}`)
    throw new DeployError('INVALID_STATE', `Can't roll back: ${parts.join('; ')}`)
  }

  /** "release 1.4.0", or "the rollback of 1.4.0"; a release with no version goes by its id's first 8 characters. */
  private releaseLabel(id: string): string {
    const summary = (x: string): ReleaseSummary | null => {
      try {
        return this.d.releases.get(x)
      } catch {
        return null
      }
    }
    const rel = summary(id)
    if (rel?.kind === 'rollback' && rel.rollbackOf !== null) return `the rollback of ${summary(rel.rollbackOf)?.version ?? rel.rollbackOf.slice(0, 8)}`
    return `release ${rel?.version ?? id.slice(0, 8)}`
  }

  /** Runs that ended succeeded fill their entries' deployedCommit and become their services' last deploy. */
  private recordDeployedRuns(live: Live, out: RunOutcome | null): void {
    try {
      const recorded: { serviceId: string; commit: string | null; releaseId: string | null }[] = []
      for (const run of this.d.releases.detail(live.id).runs) {
        if (run.status !== 'succeeded' || run.rolledBack || run.services.length === 0) continue
        // No full sha means no known commit; a service's last known one stays.
        const commit = shaOrNull(out?.commits[run.id]?.deployed ?? run.deployedCommit)
        if (commit === null) continue
        if (commit !== run.deployedCommit) this.d.releases.updateRun(run.id, { deployedCommit: commit })
        this.d.releases.setRunServices(run.id, run.services.map((e) => ({ ...e, deployedCommit: commit })))
        for (const e of run.services) recorded.push({ serviceId: e.id, commit, releaseId: live.id })
      }
      this.d.services.recordDeployed(recorded)
    } catch (e) {
      this.push(live.id, { type: 'log', stepId: null, hostId: null, stream: 'err', line: this.red(live, `Recording the deployed commits failed: ${e instanceof Error ? e.message : String(e)}`) })
    }
  }

  /**
   * After a rollback: each run's services now run the commit the rollback checked out, and go back to the release
   * that deployed them before `before`. A store error here is logged, not raised: the hosts were rolled back.
   */
  private restoreServices(live: Live, runs: { services: RunService[]; commit: string | null }[], before: string): void {
    try {
      this.d.services.recordDeployed(
        runs.flatMap((r) => r.services.map((e) => ({ serviceId: e.id, commit: shaOrNull(r.commit), releaseId: this.d.releases.previousRelease(e.id, before) }))),
      )
    } catch (e) {
      console.warn(this.red(live, `Restoring the deployed commits failed: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  /** The typed-name rule of Phase 7: every protected environment the target hosts serve counts, not only this one. */
  /** `details` adds to a refusal's audit row (an operation's name and counts). */
  private confirmProtected(
    actor: Actor,
    action: AuditAction,
    rel: { id: string; version: string | null },
    env: { id: string; name: string; protected: boolean },
    hostIds: string[],
    typedName: string | undefined,
    details: Record<string, unknown> = {},
  ): void {
    const memberships = this.inv.environmentsOfHosts([...new Set(hostIds)])
    let message = CONFIRM_MESSAGE
    try {
      const needed = confirmNeeded(protectionFor({ id: env.id, name: env.name, protected: env.protected }, memberships), 1, true)
      if (needed === null || typedName === needed) return
    } catch (e) {
      if (!(e instanceof ProtectError)) throw e
      message = e.message
    }
    this.auditRelease(actor, action, 'denied', rel.id, env.name, rel.version ?? 'release', { reason: 'confirm', ...details })
    throw new DeployError('CONFIRM_REQUIRED', message)
  }

  private who(actor: Actor): string {
    return `${actor.osUser}@${actor.machine}`
  }

  private red(live: Live, text: string): string {
    return redact(text, withBase64Forms(live.known))
  }

  /**
   * With parallel prepare on, two selected checkouts in one repo on one host must deploy the same branch: their
   * prepares run one after the other there, so the second checkout would replace the tree the first one built.
   */
  private sharedRepoChecks(environmentId: string, infos: Info[]): PreflightCheck[] {
    if (!this.d.deploys.settings(environmentId).parallelPrepare) return []
    const first = new Map<string, Info>()
    const out: PreflightCheck[] = []
    for (const i of infos) {
      const key = `${i.dep.hostId}\0${i.dep.repoPath}`
      const a = first.get(key)
      if (!a) {
        first.set(key, i)
        continue
      }
      if (a.dep.defaultBranch === i.dep.defaultBranch) continue
      out.push({
        id: 'shared-repo',
        deploymentId: i.dep.id,
        hostId: i.dep.hostId,
        label: 'shared repo',
        level: 'block',
        message: `${a.dep.name} and ${i.dep.name} share ${i.dep.repoPath} on this host but deploy different branches; deploy them in separate releases, or turn off parallel prepare`,
      })
    }
    return out
  }

  private block(id: string, message: string): PreflightCheck {
    return { id, deploymentId: null, hostId: '', label: id === 'ansible' ? 'ansible' : 'preflight', level: 'block', message }
  }

  private setStatus(id: string, status: ReleaseStatus, extra: Parameters<ReleaseStore['setStatus']>[2] = {}): void {
    this.d.releases.setStatus(id, status, extra)
    this.emitState(id)
  }

  private emitState(id: string): void {
    this.d.emitState(this.d.releases.get(id))
  }

  private clearSteps(live: Live): void {
    for (const r of live.runIds) {
      this.steps.delete(r)
      this.dirty.delete(r)
    }
  }

  // ---- the event stream ----

  private push(releaseId: string, body: RunEventBody): void {
    const live = this.live.get(releaseId)
    // An operation's param values are masked like secrets wherever its output carries them.
    if (live?.op && body.type === 'log' && live.known.length > 0) body = { ...body, line: this.red(live, body.line) }
    this.apply(live, body)
    const q = this.queue.get(releaseId)
    if (q) q.push(body)
    else this.queue.set(releaseId, [body])
    if (this.timer === null) this.timer = this.d.clock.setTimeout(() => this.flush(), EVENT_BATCH_MS)
  }

  /** Persists and pushes whatever is queued. */
  flush(): void {
    if (this.timer !== null) {
      this.d.clock.clearTimeout(this.timer)
      this.timer = null
    }
    const all: RunEvent[] = []
    const pending = [...this.queue]
    this.queue.clear()
    this.d.releases.transaction(() => {
      for (const [releaseId, bodies] of pending) {
        if (bodies.length > 0) all.push(...this.d.releases.appendEvents(releaseId, bodies))
      }
      for (const runId of this.dirty) {
        const steps = this.steps.get(runId)
        if (!steps) continue
        try {
          this.d.releases.updateRun(runId, { steps })
        } catch {
          /* not one of our runs */
        }
      }
      this.dirty.clear()
    })
    if (all.length === 0) return
    this.d.emit(all)
    for (const fn of this.listeners) {
      try {
        fn(all)
      } catch {
        /* a bad listener must not stop the others */
      }
    }
  }

  /** The service's view of what an event means: run rows, step rows and the facts a failure needs. */
  private apply(live: Live | undefined, body: RunEventBody): void {
    switch (body.type) {
      case 'deployment.updated':
        this.applyRun(live, body)
        break
      case 'step.started': {
        if (live && body.kind === 'checkout' && body.deploymentRunId) live.checkedOut.add(body.deploymentRunId)
        if (live && body.kind === 'up' && body.deploymentRunId) live.upped.add(body.deploymentRunId)
        if (!body.deploymentRunId) break
        const list = this.stepsOf(body.deploymentRunId)
        const entry = { stepId: body.stepId, kind: body.kind, state: 'running' as const, startedAt: this.d.now().toISOString(), finishedAt: null }
        const i = list.findIndex((s) => s.stepId === body.stepId)
        // The seeded row keeps its label and key.
        if (i >= 0) list[i] = { ...list[i], ...entry }
        else list.push(entry)
        this.saveSteps(body.deploymentRunId)
        break
      }
      case 'step.done':
      case 'step.failed': {
        if (body.type === 'step.failed' && live) {
          live.failure ??= body.error
          live.failedStep ??= body.stepId
          if (body.stepId === 'release:version') live.versionError = body.error
        }
        const runId = body.stepId.split(':')[0]
        const list = this.steps.get(runId)
        const i = list ? list.findIndex((s) => s.stepId === body.stepId) : -1
        if (list && i >= 0) {
          list[i] = { ...list[i], state: body.type === 'step.failed' ? 'failed' : body.state, finishedAt: this.d.now().toISOString(), ...(body.type === 'step.failed' ? { error: body.error } : {}) }
          this.saveSteps(runId)
        }
        break
      }
      case 'lock.busy':
        if (live) live.busyText = body.text
        break
      default:
        break
    }
  }

  private applyRun(live: Live | undefined, ev: Extract<RunEventBody, { type: 'deployment.updated' }>): void {
    live?.runStatus.set(ev.deploymentRunId, ev.status)
    const now = this.d.now().toISOString()
    const terminal = ev.status !== 'running' && ev.status !== 'pending'
    try {
      this.d.releases.updateRun(ev.deploymentRunId, {
        status: ev.status,
        ...(ev.status === 'rolled_back' ? { rolledBack: true } : {}),
        ...(ev.previousCommit !== undefined ? { previousCommit: ev.previousCommit } : {}),
        ...(ev.deployedCommit !== undefined ? { deployedCommit: ev.deployedCommit } : {}),
        ...(ev.backupFile !== undefined ? { backupFile: ev.backupFile } : {}),
        ...(ev.status === 'running' ? { startedAt: now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
      })
    } catch {
      /* an event for a run that is not ours (or was removed) is ignored */
    }
  }

  private stepsOf(runId: string): DeploymentRunMeta['steps'] {
    let list = this.steps.get(runId)
    if (!list) {
      list = []
      this.steps.set(runId, list)
    }
    return list
  }

  private saveSteps(runId: string): void {
    this.dirty.add(runId)
    if (this.timer === null) this.timer = this.d.clock.setTimeout(() => this.flush(), EVENT_BATCH_MS)
  }
}

/** A commit as the record keeps it: a full sha, else null (an old or hand-edited value is not a commit). */
function shaOrNull(commit: string | null | undefined): string | null {
  return commit != null && SHA.test(commit) ? commit : null
}

/** A stored run's selection as planning reads it; a run stored before services has none and is its whole checkout. */
function selectionOf(run: Pick<DeploymentRunMeta, 'services' | 'wholeCheckout'>): RunSelection {
  return { services: run.services, whole: run.wholeCheckout }
}

/**
 * For each service of each run: how many of its checkout's commits (newest first) come before its last
 * deployed commit, falling back to the deploy tag's commit. Zero is known only when that commit is origin's head
 * as the host resolved it; only then, with nothing hidden or cut and not a first deploy, is it skippable.
 */
function serviceCommits(infos: Info[], commits: PreflightReport['commits'], services: ServiceMeta[], bound: ReadonlySet<string>): PreflightReport['serviceCommits'] {
  const skips = new Set(services.flatMap((s) => (s.kind === 'service' && s.skipUnchanged && !bound.has(s.id) ? [s.id] : [])))
  const out: PreflightReport['serviceCommits'] = {}
  for (const { dep, sel } of infos) {
    const entry = commits[dep.id]
    const list = entry?.commits ?? []
    const originHead = entry?.originHead ?? null
    // Nothing else is reliable for "unchanged": the list is by date, so a merged older branch can sit after `since`.
    const clean = !!entry && entry.truncated === 0 && entry.hiddenPairs === 0 && !entry.firstDeploy
    for (const s of sel.services) {
      const since = shaOrNull(s.previousCommit) ?? entry?.tagCommit ?? null
      if (since !== null && originHead !== null && SHA.test(originHead) && since === originHead) {
        out[s.id] = { since, count: 0, known: true, skippable: skips.has(s.id) && clean }
        continue
      }
      // A count to show. First place in the list is not proof of zero (only origin's head is), so it is unknown.
      const idx = since === null ? -1 : list.findIndex((c) => c.sha === since)
      out[s.id] = idx > 0 ? { since, count: idx, known: true, skippable: false } : { since, count: list.length, known: false, skippable: false }
    }
  }
  return out
}

/** A checkout's effective steps as plan steps (`c_<index>`), each secret keyed by `key(step index, secret index)`. */
function planStepsOf(dep: DeploymentMeta, key: (i: number, n: number) => string): PlanStep[] {
  return effectiveSteps(dep).map(({ anchor, alsoOnRollback, ...step }: Step, i) => ({
    key: `c_${i}`,
    label: stepLabel(step),
    step,
    anchor,
    alsoOnRollback,
    secretKeys: step.secrets.map((x, n) => ({ envName: x.envName, key: key(i, n) })),
    paramKeys: [],
  }))
}

/** Each run left with some services after its skips: the origin head the skips were decided against. */
function originHeads(rel: ReleaseDetail, skips: Skips): Map<string, string> {
  const out = new Map<string, string>()
  for (const run of rel.runs) {
    if (!skips.sels.get(run.id)) continue
    const head = rel.preflight?.commits[run.deploymentId as string]?.originHead ?? null
    // A skip is only ever decided at a known head; without one there is nothing to hold the run to.
    if (head === null || !SHA.test(head)) throw new DeployError('INVALID_STATE', 'Preflight again: origin head unknown')
    out.set(run.id, head)
  }
  return out
}

/**
 * The review hash: of the playbook alone when nothing is skipped and there is no flow; with a flow, also of the
 * inventory (it holds `od` and become then); with skips, also of the skipped ids and their commits.
 */
const lineCount = (text: string): number => text.split('\n').length

/** Notes with `note` added as their last paragraph (once). */
function withNote(notes: string | null, note: string): string {
  if (notes === null || notes.trim() === '') return note
  return notes.includes(note) ? notes : `${notes.trimEnd()}\n\n${note}`
}

function reviewHash(playbook: string, skips: Skips, inventory: string | null): string {
  const text = inventory === null ? playbook : `${playbook}\0${inventory}`
  return skips.skipped.length === 0 ? sha256(text) : sha256(`${text}\0${JSON.stringify(skips.skipped.map((x) => [x.id, x.since]))}`)
}

/** The services a flow's step stages are bound to. */
function stepBound(flow: ReleaseFlow | null): Set<string> {
  return new Set((flow?.stages ?? []).flatMap((st) => (st.kind === 'step' ? [st.serviceId] : [])))
}

/** A review belongs to one person: the Hub user when there is one, else the OS user on the machine. */
function reviewKey(releaseId: string, actor: Actor): string {
  return JSON.stringify([releaseId, actor.hubUserId ?? null, actor.osUser, actor.machine])
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** What an operation's preflight still blocks on: reaching the host and running compose there, its lock, and the disk a backup or pull needs. The rest (a dirty tree, new commits, tags) only warns. */
function operationChecks(checks: PreflightCheck[], rb: Pick<Runbook, 'lock' | 'items'>): PreflightCheck[] {
  const keep = new Set(['reachable', 'auth', 'ansible', 'tools', 'docker', 'repo', 'compose'])
  if (rb.lock) keep.add('lock')
  if (rb.items.some((i) => i.type === 'builtin' && ONCE_BUILTINS.includes(i.builtin))) keep.add('disk')
  return checks.map((c) => (c.level === 'block' && !keep.has(c.id) ? { ...c, level: 'warn' as const } : c))
}

/** `OD_PARAM_<NAME>`: the env name a step reads a param from. */
const paramEnv = (name: string): string => `OD_PARAM_${name.toUpperCase()}`

const NO_SKIPS: Skips = { skipped: [], sels: new Map() }

type EnvironmentLike = Pick<EnvironmentMeta, 'id' | 'name' | 'protected'>

/**
 * A runbook's items as a plan carries them: a step under `c_<item index>` with its secrets' keys from `holder` and
 * every param as base64 under `OD_PARAM_<NAME>`. Without a holder the keys are blank (step rows only).
 */
function opItems(rb: Pick<Runbook, 'items' | 'params'>, params: Record<string, string>, holder: Holder | null): PlanOperation['items'] {
  return rb.items.map((it, i) => {
    if (it.type === 'builtin') return { ...it }
    const step: StepBody = it.step
    return {
      type: 'step' as const,
      step: {
        key: `c_${i}`,
        label: stepLabel(step),
        step,
        anchor: null,
        secretKeys: step.secrets.map((x, n) => ({ envName: x.envName, key: holder?.stepKey.get(`op:${i}:${n}`) ?? '' })),
        paramKeys: rb.params.flatMap((p) => (p.name in params ? [{ envName: paramEnv(p.name), valueB64: Buffer.from(params[p.name], 'utf8').toString('base64') }] : [])),
      },
    }
  })
}
