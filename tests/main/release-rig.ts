import { localAllowAll, type DeployAccess } from '../../src/main/deploy/access'
import { noopFinalize, type FinalizeSteps } from '../../src/main/deploy/finalize'
import { ReleaseService } from '../../src/main/deploy/release-service'
import type { DeployPlan, DeployRunner, RunOutcome, RunSecrets } from '../../src/main/deploy/runner'
import { resolveHost } from '../../src/main/inventory/resolve'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_RELEASE_OPTIONS, type DeploymentMeta, type PreflightCheck, type PreflightReport, type RunEvent, type RunEventBody } from '../../src/shared/deploy'
import type { AppServiceMeta } from '../../src/shared/services'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'

/** The Phase 8a release rig: a real ReleaseService over the deploy fixture with a scripted DeployRunner. */
export const A = 'a'.repeat(40)
export const B = 'b'.repeat(40)
export const C = 'c'.repeat(40)
export const NOW = Date.parse('2026-10-19T12:00:00Z')
export const SECRET = 'sekret-value-1'

export type Emit = (body: RunEventBody) => void
export type Handler = (plan: DeployPlan, secrets: RunSecrets, emit: Emit, runId: string) => Promise<Partial<RunOutcome> | void> | Partial<RunOutcome> | void

export class FakeRunner implements DeployRunner {
  calls: { plan: DeployPlan; secrets: RunSecrets; seen: { values: Record<string, string>; known: string[] } }[] = []
  cancels: string[] = []
  commitsTotal = 1
  checks: PreflightCheck[] = []
  locks: PreflightReport['locks'] = {}
  /** Overrides per plan kind; the default is a clean run. */
  on: Partial<Record<DeployPlan['kind'], Handler>> = {}
  onCancel: (runId: string) => void = () => undefined
  private listeners = new Set<(releaseId: string, body: RunEventBody) => void>()
  private n = 0

  get kinds(): string[] {
    return this.calls.map((c) => c.plan.kind)
  }
  call(kind: DeployPlan['kind'], i = 0): DeployPlan {
    return this.calls.filter((c) => c.plan.kind === kind)[i].plan
  }

  start(plan: DeployPlan, secrets: RunSecrets) {
    this.calls.push({ plan, secrets, seen: { values: { ...secrets.values }, known: [...secrets.known] } })
    const runId = `fake-run-${++this.n}`
    const emit: Emit = (b) => this.listeners.forEach((l) => l(plan.releaseId, b))
    const done = Promise.resolve()
      .then(async () => {
        const h = this.on[plan.kind]
        const res = h ? await h(plan, secrets, emit, runId) : undefined
        const base: RunOutcome = { exitCode: 0, signal: null, cancelled: false, failedDeploymentRunIds: [], reachedCheckout: [], commits: {} }
        if (plan.kind === 'preflight') {
          base.preflight = {
            checks: this.checks,
            commits: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, { commits: [], hiddenPairs: 0, truncated: 0, firstDeploy: false, head: A, tagCommit: null }])),
            dockerModes: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, 'plain' as const])),
            composeServices: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, null])),
            locks: this.locks,
            commitsTotal: this.commitsTotal,
            blocked: this.checks.some((c) => c.level === 'block'),
          }
        }
        const out = { ...base, ...(res ?? {}) }
        if (plan.kind === 'release') {
          const failed = new Set(out.failedDeploymentRunIds)
          const reached = new Set(out.reachedCheckout)
          for (const d of plan.deployments) {
            if (failed.size > 0 && !reached.has(d.runId)) continue
            if (out.exitCode !== 0 && failed.size === 0 && !reached.has(d.runId)) continue
            emit({
              type: 'deployment.updated',
              deploymentRunId: d.runId,
              status: failed.has(d.runId) || (out.exitCode !== 0 && failed.size === 0) ? 'failed' : 'succeeded',
              ...(out.commits[d.runId]?.previous ? { previousCommit: out.commits[d.runId].previous } : {}),
            })
          }
        }
        return out
      })
    return { runId, done }
  }
  cancel(runId: string): void {
    this.cancels.push(runId)
    this.onCancel(runId)
  }
  onEvent(fn: (releaseId: string, body: RunEventBody) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}

export interface Rig {
  f: DeployFixture
  svc: ReleaseService
  runner: FakeRunner
  batches: RunEvent[][]
  states: string[]
  timers: (() => void)[]
  tick(): void
  valueCalls: string[]
  setup: { access: DeployAccess; finalize: FinalizeSteps }
}

export async function rig(over: { access?: DeployAccess; finalize?: FinalizeSteps; maxEvents?: number } = {}): Promise<Rig> {
  const f = await makeDeployFixture({ maxEvents: over.maxEvents })
  // The fixture shares app1 with protected prod; most tests want an unprotected staging, so unshare it here.
  f.db.prepare('DELETE FROM environment_hosts WHERE environment_id = ?').run(f.prod.id)
  const runner = new FakeRunner()
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const store = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const valueCalls: string[] = []
  const batches: RunEvent[][] = []
  const states: string[] = []
  const timers: (() => void)[] = []
  const setup = { access: over.access ?? localAllowAll, finalize: over.finalize ?? noopFinalize }
  const svc = new ReleaseService({
    db: f.db,
    deploys: f.deploys,
    services: f.services,
    releases: f.releases,
    runner,
    access: setup.access,
    finalize: setup.finalize,
    audit: f.audit,
    vault: f.vault,
    resolve: (hostId, envId) => resolveHost(f.db, hostId, envId, { localUser: 'tester' }),
    secrets: {
      value: (id: string) => {
        valueCalls.push(id)
        return store.value(id)
      },
    },
    emit: (b) => void batches.push(b),
    emitState: (s) => void states.push(`${s.id}:${s.status}`),
    actor: { osUser: 'tester', machine: 'box' },
    now: () => new Date(NOW),
    clock: { setTimeout: (fn) => timers.push(fn) as unknown, clearTimeout: () => undefined },
  })
  return { f, svc, runner, batches, states, timers, tick: () => timers.splice(0).forEach((t) => t()), valueCalls, setup }
}

export const dep = (r: Rig, name: string, over: Record<string, unknown> = {}) =>
  r.f.deploys.create(r.f.input({ name, repoPath: `/srv/${name}`, deployTag: `deploy_${name}`, ...over }))

/** The checkout's tracked services, or one new service named after it (`<name>-<n>`) when it has none. */
export const tracked = (r: Rig, d: DeploymentMeta): AppServiceMeta[] => {
  const have = r.f.services.forCheckout(d.id)
  if (have.length) return have
  const n = r.f.services.list(d.environmentId).length
  return [r.f.services.create({ kind: 'service', environmentId: d.environmentId, name: `${d.name}-${n}`, deploymentId: d.id }) as AppServiceMeta]
}

/** Preflights every tracked service of `deps` (each checkout whole), or exactly `serviceIds`/`checkoutIds` when given. */
export async function ready(
  r: Rig,
  deps = [dep(r, 'api')],
  over: { bump?: 'major' | 'minor' | 'patch' | 'none'; envId?: string; serviceIds?: string[]; checkoutIds?: string[] } = {},
): Promise<string> {
  const { releaseId } = await r.svc.preflight({
    environmentId: over.envId ?? r.f.staging.id,
    serviceIds: over.serviceIds ?? deps.flatMap((d) => tracked(r, d).map((s) => s.id)),
    ...(over.checkoutIds ? { checkoutIds: over.checkoutIds } : {}),
    bump: over.bump ?? 'none',
    options: DEFAULT_RELEASE_OPTIONS,
  })
  for (let i = 0; i < 200 && r.svc.detail(releaseId).status === 'preflight'; i++) await new Promise((res) => setImmediate(res))
  return releaseId
}
