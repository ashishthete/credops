import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Actor, PreflightRequest, ReleaseConfirm, ReleaseDetail, ReleaseListFilter, ReleaseStatus, ReleaseSummary, RunEvent } from '../../../src/shared/deploy'
import { READY_RELEASE_TTL_MS, type HubAction, type HubEnvManifest, type HubUser } from '../../../src/shared/hub'
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
import { decide } from '../access/policy'
import type { HubAudit } from '../audit'
import type { HubConfig } from '../config'
import type { HubDb } from '../db'
import { HubHttpError } from '../errors'
import type { LiveBus } from '../live/bus'
import type { EnvLocks } from '../locks'
import type { Registry } from '../registry'
import type { DeployKeys } from '../secrets/deploykeys'
import type { SecretStore } from '../secrets/store'
import { HubDeployAccess, hubAudit, hubDeploys, hubIdentities, hubInventory, hubResolve, hubSecrets, hubServices, hubVerify } from './adapters'

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
    // The name people read on cards and in history; the upn when the directory has none.
    return { osUser: user.name || user.upn, machine: this.d.config.name, hubUserId: user.oid }
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
    throw new HubHttpError(403, 'forbidden', decision.reason)
  }

  /** Step 3: a protected environment is deployed to only by someone who types its name. */
  private confirm(user: HubUser, environmentId: string, typedName: string | undefined, attempted: string, releaseId: string): void {
    const row = this.d.db.prepare('SELECT name, protected FROM environments WHERE id = ?').get(environmentId) as { name: string; protected: number }
    if (row.protected === 1 && typedName !== row.name) {
      this.deny(user, attempted, environmentId, 'confirm_required', releaseId)
      throw new HubHttpError(400, 'confirm_required', `Type the environment name "${row.name}" to deploy to a protected environment`)
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

  private selectedDeployments(req: PreflightRequest): string[] {
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

  async start(user: HubUser, releaseId: string, confirm: ReleaseConfirm): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.allow(user, 'release.start', environmentId, this.deploymentsOf(releaseId), 'release.start', releaseId)
    this.confirm(user, environmentId, confirm.typedName, 'release.start', releaseId)
    this.holdsLock(environmentId, releaseId)
    try {
      await this.service.start(releaseId, confirm, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async cancel(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.allow(user, 'release.cancel', environmentId, this.deploymentsOf(releaseId), 'release.cancel', releaseId)
    try {
      await this.service.cancel(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async rollback(user: HubUser, releaseId: string, confirm: ReleaseConfirm): Promise<{ releaseId: string }> {
    const { environmentId } = this.known(releaseId)
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
    this.allow(user, 'lock.break', environmentId, [], 'deploy.lock_break', releaseId)
    try {
      await this.service.breakLock(releaseId, hostId, { typedLabel }, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async discard(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.allow(user, 'release.start', environmentId, this.deploymentsOf(releaseId), 'release.discard', releaseId)
    try {
      await this.service.discard(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  async retryVersion(user: HubUser, releaseId: string): Promise<void> {
    const { environmentId } = this.known(releaseId)
    this.allow(user, 'release.start', environmentId, this.deploymentsOf(releaseId), 'release.retry_version', releaseId)
    try {
      await this.service.retryVersion(releaseId, { actor: this.actorOf(user) })
    } catch (err) {
      this.fail(err)
    }
  }

  // ---- readers: only what the caller can view ----

  private canView(user: HubUser, environmentId: string): boolean {
    return decide(user, this.d.directory.listGroups(), 'deploy.view', { environmentId }).allowed
  }

  private viewable(user: HubUser, list: ReleaseSummary[]): ReleaseSummary[] {
    const seen = new Map<string, boolean>()
    return list.filter((r) => {
      if (!seen.has(r.environmentId)) seen.set(r.environmentId, this.canView(user, r.environmentId))
      return seen.get(r.environmentId)
    })
  }

  list(user: HubUser, filter: ReleaseListFilter): ReleaseSummary[] {
    if (filter.environmentId !== undefined && !this.canView(user, filter.environmentId)) throw new HubHttpError(403, 'forbidden', 'You cannot view this environment')
    return this.viewable(user, this.service.list(filter))
  }

  active(user: HubUser): ReleaseSummary[] {
    return this.viewable(user, this.service.listActive())
  }

  private viewOf(user: HubUser, releaseId: string): void {
    const { environmentId } = this.known(releaseId)
    if (!this.canView(user, environmentId)) throw new HubHttpError(403, 'forbidden', 'You cannot view this environment')
  }

  detail(user: HubUser, releaseId: string): ReleaseDetail {
    this.viewOf(user, releaseId)
    return this.service.detail(releaseId)
  }

  events(user: HubUser, releaseId: string, afterSeq: number, limit: number): RunEvent[] {
    this.viewOf(user, releaseId)
    return this.service.events(releaseId, afterSeq, Math.min(limit, MAX_EVENTS))
  }
}
