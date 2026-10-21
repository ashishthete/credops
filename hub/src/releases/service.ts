import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Actor, PlaybookPreview, PreflightRequest, ReleaseConfirm, ReleaseDetail, ReleaseListFilter, ReleaseStatus, ReleaseSummary, RunEvent } from '../../../src/shared/deploy'
import { READY_RELEASE_TTL_MS, type HubAction, type HubDecision, type HubEnvManifest, type HubEnvLock, type HubGroup, type HubLiveMessage, type HubUser } from '../../../src/shared/hub'
import { startPrivateAgent, type ChildLike } from '../../../src/main/deploy/agent'
import { DeployError } from '../../../src/main/deploy/access'
import { noopFinalize, type FinalizeSteps } from '../../../src/main/deploy/finalize'
import { prepareHosts } from '../../../src/main/deploy/hostkeys'
import { LocalRunner, nodeFs, nodeSpawn } from '../../../src/main/deploy/local-runner'
import { startTap } from '../../../src/main/deploy/log-tap'
import { ReleaseService } from '../../../src/main/deploy/release-service'
import { ReleaseStore } from '../../../src/main/deploy/release-store'
import type { DeployRunner, RunSecrets } from '../../../src/main/deploy/runner'
import { detectTools } from '../../../src/main/deploy/tooling'
import { connectChain } from '../../../src/main/ssh/connect'
import { redact } from '../../../src/main/security/redact'
import type { Directory } from '../access/directory'
import { decide, viewScope, type ViewScope } from '../access/policy'
import type { HubAudit } from '../audit'
import type { HubConfig } from '../config'
import type { HubDb } from '../db'
import { HubHttpError } from '../errors'
import type { LiveBus } from '../live/bus'
import type { EnvLocks } from '../locks'
import type { Registry } from '../registry'
import type { DeployKeys } from '../secrets/deploykeys'
import type { SecretStore } from '../secrets/store'
import { HubDeployAccess, hubAudit, hubDeploys, hubIdentities, hubInventory, hubResolve, hubRunbooks, hubSecrets, hubServices, hubVerify } from './adapters'
import { scopeDetail, scopeEvents, scopeSummary, visibleIn, type Visible } from './scope'

/** Statuses after which a release holds no lock: it has ended, or it can never start. */
const LOCK_FREE: ReadonlySet<ReleaseStatus> = new Set(['blocked', 'succeeded', 'failed', 'rolled_back', 'cancelled', 'discarded'])
export const RESTART_MESSAGE = 'Hub restarted'
const MAX_EVENTS = 5000

export interface HubReleasesDeps {
  config: HubConfig
  db: HubDb
  audit: HubAudit
  directory: Pick<Directory, 'get' | 'listGroups'>
  registry: Registry
  locks: EnvLocks
  secrets: SecretStore
  deployKeys: DeployKeys
  live: LiveBus
  now: () => Date
  ids: () => string
  /** Tests inject a scripted runner; the Hub runs ansible through Phase 8's LocalRunner. */
  runner?: DeployRunner
  /** Phase 9's notes, notify and QA steps on Hub secrets; none when omitted. */
  finalize?: FinalizeSteps
  /** Integration secrets in use right now (see HubNotify.held); masked in the live stream and error bodies. */
  heldSecrets?: () => string[]
  /** Where lock-release failures are reported; the message is already redacted. */
  log?: (message: string) => void
}

/** What the Hub asks of a runbook run: the services to run it on, with its param values. */
export interface OperationRequest {
  environmentId: string
  runbookId: string
  serviceIds: string[]
  params: Record<string, string>
}
export type EditValidation = { ok: true; canonical: string; sha256: string } | { ok: false; errors: { line: number; message: string }[] }

/** The ReleaseService methods the operation and edit routes call; they arrive with the operations and playbook-edit work on the service. */
interface OpsApi {
  preflightOperation(req: OperationRequest, ctx?: { actor: Actor }): Promise<{ releaseId: string }>
  validateEdit(releaseId: string, text: string, ctx?: { actor: Actor }): EditValidation | Promise<EditValidation>
}

export const runRootOf = (config: HubConfig): string => config.runRoot ?? join(config.dataDir, 'runs')

/** Phase 8's LocalRunner on the Hub: no agent, no prompts, no trust-on-first-use; hosts and keys come from the registry. */
function localRunner(deps: HubReleasesDeps, build: { resolve: ReturnType<typeof hubResolve>; identities: ReturnType<typeof hubIdentities> }): DeployRunner {
  const root = runRootOf(deps.config)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to a directory it creates.
  chmodSync(root, 0o700)
  const home = homedir()
  const toolDeps = {
    env: process.env,
    home,
    ...(deps.config.ansibleBin ? { ansibleBin: deps.config.ansibleBin } : {}),
    execFile: (file: string, args: string[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout: String(stdout), stderr: String(stderr) }))),
      ),
    exists: (path: string) => existsSync(path),
  }
  const unused = (what: string) => (): never => {
    throw new Error(`${what} is not available on the Hub`)
  }
  const verify = hubVerify({ db: deps.db, registry: deps.registry })
  return new LocalRunner({
    tools: () => detectTools(toolDeps),
    prepare: (plan, signal) =>
      prepareHosts(plan, {
        resolve: (hostId) => build.resolve(hostId, plan.environment.id),
        connectChain,
        verify: verify as never,
        prompts: { request: unused('A host key prompt') } as never,
        knownHosts: { check: unused('The app known-hosts store'), trust: unused('The app known-hosts store'), recordMismatch: () => undefined } as never,
        identities: build.identities as never,
        // No ssh-agent and no ~/.ssh on the Hub: the environment's deploy key is the only credential.
        auth: { env: {}, home: root },
        signal,
      }),
    agent: ({ dir, tools, ttlSec }) =>
      startPrivateAgent({
        dir,
        tools,
        ttlSec,
        spawn: (file, args, o) => spawn(file, args, { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike,
      }),
    tap: startTap,
    spawn: nodeSpawn({ spawn: (file, args, o) => spawn(file, args, o) as never, kill: (pid, signal) => void process.kill(pid, signal as NodeJS.Signals) }),
    fs: nodeFs,
    tmpdir: root,
    home: root,
    userAgentSock: null,
  })
}

/**
 * Releases on the Hub: Phase 8's ReleaseService with the Hub's registry, secrets, deploy keys and audit behind it.
 * Every mutating call runs the same checks in the same order: signed in, allowed to do this here, the typed
 * confirmation, the environment lock, and only then the service.
 */
/** A refusal over a release's deployments names none of them: the caller may not be allowed to know them. */
function refusal(decision: Extract<HubDecision, { allowed: false }>, deploymentIds: string[]): string {
  return decision.code === 'no_grant' && deploymentIds.length ? "This release includes deployments you don't have access to." : decision.reason
}

export class HubReleases {
  readonly service: ReleaseService
  /** The deploy key as a runner resolves it; tests drive it as a run would. */
  readonly identities: ReturnType<typeof hubIdentities>
  private readonly store: ReleaseStore
  private readonly runSecrets = new Map<string, string[]>()
  private readonly pems = new Map<string, string>()

  constructor(private readonly d: HubReleasesDeps) {
    const access = new HubDeployAccess({ directory: d.directory })
    this.store = new ReleaseStore({ db: d.db, now: d.now })
    const resolve = hubResolve({ db: d.db, registry: d.registry })
    const identities = hubIdentities({ deployKeys: d.deployKeys, loaded: this.pems })
    this.identities = identities
    const base = d.runner ?? localRunner(d, { resolve, identities })
    const envOfTarget = (type: string | undefined, id: string | undefined): string | null => {
      if (!id) return null
      if (type === 'environment') return id
      if (type !== 'release') return null
      return (d.db.prepare('SELECT environment_id FROM releases WHERE id = ?').get(id) as { environment_id: string } | undefined)?.environment_id ?? null
    }
    // Remembers every secret value of a run while it lives, so the live stream and error bodies can mask them.
    const runner: DeployRunner = {
      start: (plan, secrets: RunSecrets) => {
        this.runSecrets.set(plan.releaseId, [...secrets.known, ...Object.values(secrets.values)])
        const handle = base.start(plan, secrets)
        const settle = (): void => {
          this.runSecrets.delete(plan.releaseId)
          this.pems.delete(plan.environment.id)
        }
        void handle.done.then(settle, settle)
        return handle
      },
      cancel: (runId) => base.cancel(runId),
      // Defense in depth: whatever a runner reports is masked against the run's secrets before the service stores it.
      onEvent: (fn) => base.onEvent((releaseId, body) => fn(releaseId, redact(body, [...(this.runSecrets.get(releaseId) ?? []), ...this.pemSecrets()]))),
    }
    this.service = new ReleaseService({
      db: d.db,
      deploys: hubDeploys(d.db, d.registry),
      services: hubServices(d.db, d.registry),
      releases: this.store,
      runner,
      access,
      finalize: d.finalize ?? noopFinalize,
      audit: hubAudit({ audit: d.audit, directory: d.directory, access, envOfTarget }),
      vault: { assertUnlocked: () => undefined },
      resolve,
      identities,
      secrets: hubSecrets({ secrets: d.secrets, registry: d.registry }),
      inventory: hubInventory(d.db, d.registry),
      emit: (batch) => this.publishEvents(batch),
      emitState: (summary) => this.onState(summary),
      actor: { osUser: 'hub', machine: d.config.name },
      now: d.now,
      clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    })
  }

  /** Values the live stream and error bodies must mask while releases run. */
  knownSecrets(): string[] {
    return [...this.runKnownSecrets(), ...(this.d.heldSecrets?.() ?? [])]
  }

  /** Each loaded deploy key and every line of its body, so a log line carrying only part of a key is still masked. */
  private pemSecrets(): string[] {
    return [...this.pems.values()].flatMap((pem) => [pem, ...pem.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'))])
  }

  /** The run secrets and deploy keys alone. */
  runKnownSecrets(): string[] {
    return [...[...this.runSecrets.values()].flat(), ...this.pemSecrets()]
  }

  /**
   * A 'ready' release that never started holds its environment lock; past the TTL it is discarded, which frees
   * the lock through the normal state path. Returns how many it discarded.
   */
  expireReady(): number {
    const cutoff = new Date(this.d.now().getTime() - READY_RELEASE_TTL_MS).toISOString()
    const rows = this.d.db
      .prepare("SELECT r.id AS id, r.environment_id AS environment_id FROM releases r JOIN env_locks l ON l.release_id = r.id AND l.kind = 'release' WHERE r.status = 'ready' AND l.created_at <= ?")
      .all(cutoff) as { id: string; environment_id: string }[]
    let n = 0
    for (const row of rows) {
      // A break-lock or preflight is still working on it and would write its status over ours.
      if (this.service.isBusy(row.id) || this.store.get(row.id).status !== 'ready') continue
      this.store.setStatus(row.id, 'discarded', { finishedAt: this.d.now().toISOString() })
      this.d.audit.append({
        action: 'release.discard',
        outcome: 'success',
        actor: null,
        targetType: 'release',
        targetId: row.id,
        targetLabel: this.d.registry.nameOf(row.environment_id),
        details: { reason: 'expired' },
      })
      this.onState(this.store.get(row.id))
      n++
    }
    return n
  }

  async whenIdle(): Promise<void> {
    await this.service.whenIdle()
  }

  close(): void {
    this.service.close()
  }

  /** At boot nothing is running: drop the release locks and fail what the restart interrupted. Returns how many it failed. */
  recover(): number {
    this.d.locks.clearReleaseLocks()
    return this.service.recoverInterrupted(RESTART_MESSAGE).length
  }

  // ---- live ----

  private publishEvents(batch: RunEvent[]): void {
    const byRelease = new Map<string, RunEvent[]>()
    for (const e of batch) byRelease.set(e.runId, [...(byRelease.get(e.runId) ?? []), e])
    for (const [releaseId, events] of byRelease) {
      // The environment comes from the Hub's own release row, never from the payload.
      const environmentId = this.envOf(releaseId)
      if (environmentId !== null) this.d.live.publish({ type: 'deploy.events', environmentId, events })
    }
  }

  private onState(summary: ReleaseSummary): void {
    // After the status is committed and outside any transaction: the lock helpers open their own.
    if (LOCK_FREE.has(summary.status)) {
      try {
        this.d.locks.releaseFor(summary.id)
      } catch (err) {
        // A failure here leaves the environment locked: say so (redacted), but still tell watchers the release ended.
        this.d.log?.(redact(`releasing the lock of release ${summary.id} failed: ${err instanceof Error ? err.message : String(err)}`, this.knownSecrets()))
      }
    }
    this.d.live.publish({ type: 'release.state', summary })
  }

  // ---- checks ----

  private envOf(releaseId: string): string | null {
    return (this.d.db.prepare('SELECT environment_id FROM releases WHERE id = ?').get(releaseId) as { environment_id: string } | undefined)?.environment_id ?? null
  }

  private known(releaseId: string): { environmentId: string; name: string } {
    const environmentId = this.envOf(releaseId)
    const name = environmentId === null ? null : this.d.registry.nameOf(environmentId)
    if (environmentId === null || name === null) throw new HubHttpError(404, 'not_found', 'That release was not found')
    return { environmentId, name }
  }

  private actorOf(user: HubUser): Actor {
    return { osUser: user.upn, machine: this.d.config.name, hubUserId: user.oid }
  }

  private deploymentsOf(releaseId: string): string[] {
    return this.store.detail(releaseId).runs.flatMap((r) => (r.deploymentId ? [r.deploymentId] : []))
  }

  private deny(user: HubUser, attempted: string, environmentId: string, code: string, releaseId: string | null): void {
    this.d.audit.append({
      action: 'access.denied',
      outcome: 'denied',
      actor: { oid: user.oid, upn: user.upn, name: user.name, role: user.role },
      targetType: releaseId ? 'release' : 'environment',
      targetId: releaseId ?? environmentId,
      details: { attempted, code, environmentId },
    })
  }

  /** Step 2: the policy decision. A denial is audited and nothing else happens. */
  private allow(user: HubUser, action: HubAction, environmentId: string, deploymentIds: string[], attempted: string, releaseId: string | null): void {
    const decision = decide(user, this.d.directory.listGroups(), action, { environmentId, ...(deploymentIds.length ? { deploymentIds } : {}) })
    if (decision.allowed) return
    this.deny(user, attempted, environmentId, 'forbidden', releaseId)
    throw new HubHttpError(403, 'forbidden', refusal(decision, deploymentIds))
  }

  /** Step 3: a protected environment is deployed to only by someone who types its name. */
  private confirm(user: HubUser, environmentId: string, typedName: string | undefined, attempted: string, releaseId: string): void {
    const row = this.d.db.prepare('SELECT name, protected FROM environments WHERE id = ?').get(environmentId) as { name: string; protected: number }
    if (row.protected === 1 && typedName !== row.name) {
      this.deny(user, attempted, environmentId, 'confirm_required', releaseId)
      throw new HubHttpError(400, 'confirm_required', `Type the environment name "${row.name}" to ${attempted === 'release.rollback' ? 'roll back in' : 'deploy to'} a protected environment`)
    }
  }

  /** Step 4: the release must be the one holding the environment's lock. */
  private holdsLock(environmentId: string, releaseId: string): void {
    if (this.d.locks.get(environmentId)?.releaseId !== releaseId) {
      throw new HubHttpError(409, 'conflict', 'This release no longer holds the environment lock. Run a new preflight.')
    }
  }

  /** Moves a lock taken under a provisional id to the release row, or lets it go if the release has already ended. */
  private bind(environmentId: string, provisional: string, releaseId: string): void {
    const status = this.store.get(releaseId).status
    if (LOCK_FREE.has(status)) this.d.locks.releaseFor(provisional)
    else this.d.locks.rebind(environmentId, provisional, releaseId)
  }

  private fail(err: unknown, generic: 'rethrow' | 'bad_request' = 'rethrow'): never {
    if (err instanceof HubHttpError) throw err
    if (err instanceof DeployError) {
      const message = redact(err.message, this.knownSecrets())
      if (err.code === 'CONFIRM_REQUIRED') throw new HubHttpError(400, 'confirm_required', message)
      if (err.code === 'DENIED') throw new HubHttpError(403, 'forbidden', message)
      throw new HubHttpError(409, 'conflict', message)
    }
    if (generic === 'bad_request' && err instanceof Error) throw new HubHttpError(400, 'bad_request', redact(err.message, this.knownSecrets()))
    throw err
  }

  private ops(): OpsApi {
    const s = this.service as unknown as Partial<OpsApi>
    if (typeof s.preflightOperation !== 'function' || typeof s.validateEdit !== 'function') {
      throw new HubHttpError(503, 'unavailable', 'This Hub build cannot run operations or validate playbook edits')
    }
    return s as OpsApi
  }

  /** The access action a release is started under: a runbook run is `ops.run`, a deploy `release.start`. */
  private startAction(releaseId: string): HubAction {
    return this.store.get(releaseId).operation ? 'ops.run' : 'release.start'
  }

  /** Editing a playbook needs the Hub setting and an admin. A refusal is audited like any other. */
  private editGuard(user: HubUser, environmentId: string, attempted: string, releaseId: string): void {
    if (this.d.config.allowPlaybookEdits !== true) {
      this.deny(user, attempted, environmentId, 'edits_off', releaseId)
      throw new HubHttpError(403, 'forbidden', 'Playbook editing is turned off on this Hub')
    }
    this.allow(user, 'playbook.edit', environmentId, [], attempted, releaseId)
  }

  private selectedDeployments(req: Pick<PreflightRequest, 'environmentId' | 'serviceIds' | 'checkoutIds'>): string[] {
    const m = this.d.registry.exists(req.environmentId) ? this.d.registry.get(req.environmentId) : null
    const byId = new Map<string, HubEnvManifest['services'][number]>((m?.services ?? []).map((s) => [s.id, s]))
    const ids = [...req.serviceIds.flatMap((id) => byId.get(id)?.deploymentId ?? []), ...(req.checkoutIds ?? [])]
    return [...new Set(ids)]
  }

  // ---- mutations ----

  async preflight(user: HubUser, req: PreflightRequest): Promise<{ releaseId: string }> {
    this.allow(user, 'release.start', req.environmentId, this.selectedDeployments(req), 'release.preflight', null)
    if (this.d.registry.nameOf(req.environmentId) === null) throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
    const provisional = this.d.ids()
    this.d.locks.acquireRelease(req.environmentId, provisional, { oid: user.oid, name: user.name })
    let res: { releaseId: string }
    try {
      res = await this.service.preflight(req, { actor: this.actorOf(user) })
    } catch (err) {
      this.d.locks.releaseFor(provisional)
      return this.fail(err, 'bad_request')
    }
    this.bind(req.environmentId, provisional, res.releaseId)
    return res
  }

  /** Starts a runbook run: the same lock and typed-name rules as a release, unless the runbook only reads and takes no lock. */
  async preflightOperation(user: HubUser, req: OperationRequest): Promise<{ releaseId: string }> {
    this.allow(user, 'ops.run', req.environmentId, this.selectedDeployments(req), 'ops.preflight', null)
    if (this.d.registry.nameOf(req.environmentId) === null) throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
    const ops = this.ops()
    let runbook
    try {
      runbook = hubRunbooks(this.d.db, this.d.registry).get(req.runbookId)
    } catch {
      throw new HubHttpError(404, 'not_found', 'That runbook was not found')
    }
    if (runbook.environmentId !== req.environmentId) throw new HubHttpError(404, 'not_found', 'That runbook was not found')
    if (!runbook.lock) {
      try {
        return await ops.preflightOperation(req, { actor: this.actorOf(user) })
      } catch (err) {
        return this.fail(err, 'bad_request')
      }
    }
    const provisional = this.d.ids()
    this.d.locks.acquireRelease(req.environmentId, provisional, { oid: user.oid, name: user.name })
    let res: { releaseId: string }
    try {
      res = await ops.preflightOperation(req, { actor: this.actorOf(user) })
    } catch (err) {
      this.d.locks.releaseFor(provisional)
      return this.fail(err, 'bad_request')
    }
    this.bind(req.environmentId, provisional, res.releaseId)
    return res
  }

  /** Checks an edited playbook without storing it. Only an admin on a Hub that allows edits. */
  async validateEdit(user: HubUser, releaseId: string, text: string): Promise<EditValidation> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'playbook.edit')
    this.editGuard(user, environmentId, 'playbook.edit', releaseId)
    const ops = this.ops()
    try {
      return await ops.validateEdit(releaseId, text, { actor: this.actorOf(user) })
    } catch (err) {
      return this.fail(err, 'bad_request')
    }
  }

  /**
   * The playbook a start would run, for review on the desktop. Generating it writes nothing and takes no lock.
   * It is a read: a refusal writes no audit row (like `detail`, and like the desktop's own preview).
   */
  async previewPlaybook(user: HubUser, releaseId: string, forceServiceIds?: string[]): Promise<PlaybookPreview> {
    const { environmentId } = this.known(releaseId)
    // A release the caller cannot view is unknown to them; one they view only part of is refused below.
    this.viewOf(user, releaseId)
    const deploymentIds = this.deploymentsOf(releaseId)
    // Only a service of this release can be forced, and never more of them than it has.
    const forced = forceServiceIds === undefined ? undefined : [...new Set(forceServiceIds)]
    if (forced) {
      const own = new Set(this.store.get(releaseId).serviceIds)
      if (forced.length > own.size || forced.some((id) => !own.has(id))) throw new HubHttpError(400, 'bad_request', 'forceServiceIds names a service this release does not run')
    }
    const decision = decide(user, this.d.directory.listGroups(), this.startAction(releaseId), { environmentId, ...(deploymentIds.length ? { deploymentIds } : {}) })
    if (!decision.allowed) throw new HubHttpError(403, 'forbidden', refusal(decision, deploymentIds))
    try {
      return await this.service.previewPlaybook(releaseId, { actor: this.actorOf(user) }, forced)
    } catch (err) {
      return this.fail(err)
    }
  }

  async start(user: HubUser, releaseId: string, confirm: ReleaseConfirm): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'release.start')
    const operation = this.store.get(releaseId).operation
    const action = this.startAction(releaseId)
    this.allow(user, action, environmentId, this.deploymentsOf(releaseId), action, releaseId)
    if (confirm.editedPlaybook !== undefined) this.editGuard(user, environmentId, 'playbook.edit', releaseId)
    this.confirm(user, environmentId, confirm.typedName, 'release.start', releaseId)
    // A read-only runbook takes no environment lock, so there is none to hold.
    if (!operation || operation.lock) this.holdsLock(environmentId, releaseId)
    try {
      await this.service.start(releaseId, confirm, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async cancel(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'release.cancel')
    this.allow(user, 'release.cancel', environmentId, this.deploymentsOf(releaseId), 'release.cancel', releaseId)
    try {
      await this.service.cancel(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async rollback(user: HubUser, releaseId: string, confirm: ReleaseConfirm): Promise<{ releaseId: string }> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'release.rollback')
    this.allow(user, 'release.rollback', environmentId, this.deploymentsOf(releaseId), 'release.rollback', releaseId)
    this.confirm(user, environmentId, confirm.typedName, 'release.rollback', releaseId)
    // A rollback is a release of its own and takes the environment lock itself.
    const provisional = this.d.ids()
    this.d.locks.acquireRelease(environmentId, provisional, { oid: user.oid, name: user.name })
    let res: { releaseId: string }
    try {
      res = await this.service.rollback(releaseId, confirm, { actor: this.actorOf(user) })
    } catch (err) {
      this.d.locks.releaseFor(provisional)
      return this.fail(err)
    }
    this.bind(environmentId, provisional, res.releaseId)
    return res
  }

  async breakLock(user: HubUser, releaseId: string, hostId: string, typedLabel: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'deploy.lock_break')
    this.allow(user, 'lock.break', environmentId, [], 'deploy.lock_break', releaseId)
    try {
      await this.service.breakLock(releaseId, hostId, { typedLabel }, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async discard(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'release.discard')
    this.allow(user, 'release.start', environmentId, this.deploymentsOf(releaseId), 'release.discard', releaseId)
    try {
      await this.service.discard(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async retryVersion(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.reachable(user, releaseId, environmentId, 'release.retry_version')
    this.allow(user, 'release.start', environmentId, this.deploymentsOf(releaseId), 'release.retry_version', releaseId)
    // The retry runs again, so it holds the environment lock like any release: a freeze or another release refuses it.
    this.d.locks.acquireRelease(environmentId, releaseId, { oid: user.oid, name: user.name })
    try {
      await this.service.retryVersion(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.d.locks.releaseFor(releaseId)
      this.fail(err)
    }
  }

  // ---- readers: only what the caller can view ----

  /**
   * The groups a read of `environmentId` is judged by. An unpublished environment has no grants of its own any
   * more; the ones it had (kept at unpublish) count, so its former viewers still read its history.
   */
  private groupsFor(environmentId: string): HubGroup[] {
    const groups = this.d.directory.listGroups()
    if (!this.d.registry.historyOf(environmentId)?.unpublished) return groups
    const former = this.d.registry.formerGrants(environmentId)
    return groups.map((g) => ({ ...g, grants: [...g.grants, ...former.filter((x) => x.groupId === g.id)] }))
  }

  private scopeOf(user: HubUser, environmentId: string): ViewScope | null {
    return viewScope(user, this.groupsFor(environmentId), environmentId)
  }

  /** Marks the releases of an unpublished environment. */
  private marked<T extends ReleaseSummary>(r: T, unpublished = this.d.registry.historyOf(r.environmentId)?.unpublished ?? false): T {
    return unpublished ? { ...r, unpublished: true } : r
  }

  /** The caller's copy of a summary: whole, cut to their deployments, or null when they see none of it. */
  private shown(scope: ViewScope | null, r: ReleaseSummary, unpublished?: boolean): ReleaseSummary | null {
    if (scope === null) return null
    if (scope.all) return this.marked(r, unpublished)
    const v = visibleIn(this.d.db, scope.deploymentIds, r.id)
    return v ? this.marked(scopeSummary(r, v), unpublished) : null
  }

  /**
   * Newest first. The query itself keeps only releases the caller sees (whole environments, or releases with a run
   * of one of their deployments), so the limit counts only those and a request never scans past them.
   */
  list(user: HubUser, filter: ReleaseListFilter): ReleaseSummary[] {
    if (filter.environmentId !== undefined && this.scopeOf(user, filter.environmentId) === null) throw new HubHttpError(403, 'forbidden', 'You cannot view this environment')
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 50), 200))
    const envs = (
      filter.environmentId !== undefined
        ? this.d.db.prepare('SELECT id, unpublished_at FROM environments WHERE id = ?').all(filter.environmentId)
        : this.d.db.prepare('SELECT id, unpublished_at FROM environments').all()
    ) as { id: string; unpublished_at: string | null }[]
    const scopes = new Map<string, { scope: ViewScope; unpublished: boolean }>()
    const whole: string[] = []
    const parts: string[] = []
    const args: string[] = []
    for (const e of envs) {
      const scope = this.scopeOf(user, e.id)
      if (scope === null) continue
      scopes.set(e.id, { scope, unpublished: e.unpublished_at !== null })
      if (scope.all) whole.push(e.id)
      else {
        const ph = [...scope.deploymentIds].map(() => '?').join(', ')
        // An operation is listed only when every checkout it targets is covered.
        parts.push(
          `(r.environment_id = ? AND EXISTS (SELECT 1 FROM deployment_runs d WHERE d.release_id = r.id AND d.deployment_id IN (${ph}))
            AND (r.operation IS NULL OR NOT EXISTS (SELECT 1 FROM deployment_runs d2 WHERE d2.release_id = r.id AND (d2.deployment_id IS NULL OR d2.deployment_id NOT IN (${ph})))))`,
        )
        args.push(e.id, ...scope.deploymentIds, ...scope.deploymentIds)
      }
    }
    if (whole.length) parts.unshift(`r.environment_id IN (${whole.map(() => '?').join(', ')})`)
    if (parts.length === 0) return []
    const where = [
      `(${parts.join(' OR ')})`,
      ...(filter.before !== undefined ? ['r.id < ?'] : []),
      ...(filter.operations === 'only' ? ['r.operation IS NOT NULL'] : filter.operations === 'exclude' ? ['r.operation IS NULL'] : []),
    ]
    const rows = this.d.db
      .prepare(`SELECT r.id, r.environment_id FROM releases r WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
      .all(...whole, ...args, ...(filter.before !== undefined ? [filter.before] : []), limit) as { id: string; environment_id: string }[]
    return rows.flatMap((row) => {
      const e = scopes.get(row.environment_id)!
      return this.shown(e.scope, this.store.get(row.id), e.unpublished) ?? []
    })
  }

  active(user: HubUser): ReleaseSummary[] {
    const scopes = new Map<string, ViewScope | null>()
    return this.service.listActive().flatMap((r) => {
      if (!scopes.has(r.environmentId)) scopes.set(r.environmentId, this.scopeOf(user, r.environmentId))
      return this.shown(scopes.get(r.environmentId)!, r) ?? []
    })
  }

  /**
   * What of a release the caller sees: everything (null) or their deployments' part. One they cannot view at all
   * is a 404 like an unknown one, so its existence does not leak.
   */
  private viewOf(user: HubUser, releaseId: string): Visible | null {
    const environmentId = this.envOf(releaseId)
    const scope = environmentId === null || this.d.registry.historyOf(environmentId) === null ? null : this.scopeOf(user, environmentId)
    if (scope?.all) return null
    const visible = scope ? visibleIn(this.d.db, scope.deploymentIds, releaseId) : null
    if (!visible) throw new HubHttpError(404, 'not_found', 'That release was not found')
    return visible
  }

  /** For a change: a release the caller cannot view is a 404, and the attempt is audited like any refusal. */
  private reachable(user: HubUser, releaseId: string, environmentId: string, attempted: string): void {
    try {
      this.viewOf(user, releaseId)
    } catch (err) {
      this.deny(user, attempted, environmentId, 'not_visible', releaseId)
      throw err
    }
  }

  detail(user: HubUser, releaseId: string): ReleaseDetail {
    const visible = this.viewOf(user, releaseId)
    const d = this.marked(this.service.detail(releaseId))
    return visible ? scopeDetail(d, visible) : d
  }

  /** A page is filled with events the caller sees; `afterSeq` of the last one fetches the next. */
  events(user: HubUser, releaseId: string, afterSeq: number, limit: number): RunEvent[] {
    const visible = this.viewOf(user, releaseId)
    const max = Math.min(limit, MAX_EVENTS)
    if (!visible) return this.service.events(releaseId, afterSeq, max)
    const out: RunEvent[] = []
    let after = afterSeq
    for (;;) {
      const page = this.service.events(releaseId, after, max)
      for (const e of scopeEvents(page, visible)) {
        out.push(e)
        if (out.length === max) return out
      }
      if (page.length < max) return out
      after = page[page.length - 1].seq
    }
  }

  /** An environment lock as the caller may see it: the id of a release they cannot view is left out. */
  lockView(user: HubUser, groups: HubGroup[], lock: HubEnvLock | null): HubEnvLock | null {
    if (lock === null || lock.releaseId === null) return lock
    const scope = viewScope(user, groups, lock.environmentId)
    if (scope?.all) return lock
    return scope && visibleIn(this.d.db, scope.deploymentIds, lock.releaseId) ? lock : { ...lock, releaseId: null }
  }

  /** The live feed's copy of a message for one subscriber: unchanged, cut to their deployments, or null. */
  liveView(user: HubUser, groups: HubGroup[], msg: HubLiveMessage): HubLiveMessage | null {
    if (msg.type === 'lock.updated') {
      const lock = this.lockView(user, groups, msg.lock)
      return lock === msg.lock ? msg : { ...msg, lock }
    }
    if (msg.type !== 'deploy.events' && msg.type !== 'release.state') return msg
    const environmentId = msg.type === 'release.state' ? msg.summary.environmentId : msg.environmentId
    const scope = viewScope(user, groups, environmentId)
    if (scope === null) return null
    if (scope.all) return msg
    if (msg.type === 'release.state') {
      const v = visibleIn(this.d.db, scope.deploymentIds, msg.summary.id)
      return v ? { ...msg, summary: scopeSummary(msg.summary, v) } : null
    }
    const events = [...new Set(msg.events.map((e) => e.runId))].flatMap((id) => {
      const v = visibleIn(this.d.db, scope.deploymentIds, id)
      return v ? scopeEvents(msg.events.filter((e) => e.runId === id), v) : []
    })
    return events.length ? { ...msg, events } : null
  }
}
