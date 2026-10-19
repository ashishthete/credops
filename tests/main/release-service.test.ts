import { describe, expect, it } from 'vitest'
import { DeployError, localAllowAll, type DeployAccess } from '../../src/main/deploy/access'
import { noopFinalize, type FinalizeSteps } from '../../src/main/deploy/finalize'
import { ReleaseService } from '../../src/main/deploy/release-service'
import { INTERRUPTED_MESSAGE } from '../../src/main/deploy/release-store'
import type { DeployPlan, DeployRunner, RunOutcome, RunSecrets } from '../../src/main/deploy/runner'
import { ToolingError } from '../../src/main/deploy/tooling'
import { resolveHost } from '../../src/main/inventory/resolve'
import { SecretStore } from '../../src/main/vault/secret-store'
import { CONFIRM_MESSAGE } from '../../src/shared/ops'
import { BREAK_LOCK_CONFIRM_MESSAGE, DEFAULT_RELEASE_OPTIONS, type PreflightCheck, type PreflightReport, type RunEvent, type RunEventBody } from '../../src/shared/deploy'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const NOW = Date.parse('2026-10-19T12:00:00Z')
const SECRET = 'sekret-value-1'

type Emit = (body: RunEventBody) => void
type Handler = (plan: DeployPlan, secrets: RunSecrets, emit: Emit, runId: string) => Promise<Partial<RunOutcome> | void> | Partial<RunOutcome> | void

class FakeRunner implements DeployRunner {
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
            commits: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, { commits: [], hiddenPairs: 0, truncated: 0, firstDeploy: false, head: A }])),
            dockerModes: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, 'plain' as const])),
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

interface Rig {
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

async function rig(over: { access?: DeployAccess; finalize?: FinalizeSteps; maxEvents?: number } = {}): Promise<Rig> {
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

const dep = (r: Rig, name: string, over: Record<string, unknown> = {}) =>
  r.f.deploys.create(r.f.input({ name, repoPath: `/srv/${name}`, deployTag: `deploy_${name}`, ...over }))

async function ready(r: Rig, deps = [dep(r, 'api')], over: { bump?: 'major' | 'minor' | 'patch' | 'none'; envId?: string } = {}): Promise<string> {
  const { releaseId } = await r.svc.preflight({
    environmentId: over.envId ?? r.f.staging.id,
    deploymentIds: deps.map((d) => d.id),
    bump: over.bump ?? 'none',
    options: DEFAULT_RELEASE_OPTIONS,
  })
  for (let i = 0; i < 200 && r.svc.detail(releaseId).status === 'preflight'; i++) await new Promise((res) => setImmediate(res))
  return releaseId
}

const audits = (r: Rig, action: string) => r.f.audit.list({ actions: [action as never] })
const runIds = (plan: DeployPlan): string[] => plan.deployments.map((d) => d.runId)
const gate = () => {
  let open!: () => void
  const p = new Promise<void>((res) => (open = res))
  return { p, open }
}

describe('ReleaseService', () => {
  it('preflight stores a ready report and audits release.preflight', async () => {
    const r = await rig()
    const id = await ready(r)
    const d = r.svc.detail(id)
    expect(d.status).toBe('ready')
    expect(d.preflight?.blocked).toBe(false)
    expect(d.preflight?.checks.find((c) => c.id === 'ansible')?.level).toBe('ok')
    expect(d.runs).toHaveLength(1)
    expect(r.svc.events(id, 0).map((e) => e.type)).toEqual(['preflight.check', 'preflight.done'])
    const ev = audits(r, 'release.preflight')
    expect(ev).toHaveLength(1)
    expect(ev[0].outcome).toBe('success')
    expect(ev[0]).toMatchObject({ targetType: 'release', targetId: id, targetLabel: 'staging release' })
    expect(ev[0].details).toEqual({ deployments: [d.runs[0].deploymentId], commits: 1, blockers: 0 })
    expect(r.states).toContain(`${id}:ready`)
  })

  it('a missing ansible blocks the preflight with an ansible check', async () => {
    const r = await rig()
    r.runner.on.preflight = () => {
      throw new ToolingError('ansible-missing', 'ansible-playbook was not found')
    }
    const id = await ready(r)
    const d = r.svc.detail(id)
    expect(d.status).toBe('blocked')
    expect(d.preflight?.checks).toEqual([expect.objectContaining({ id: 'ansible', level: 'block', message: 'ansible-playbook was not found' })])
  })

  it('blocked preflight cannot start', async () => {
    const r = await rig()
    r.runner.checks = [{ id: 'repo', deploymentId: null, hostId: r.f.host.id, label: 'api', level: 'block', message: 'missing repo' }]
    const id = await ready(r)
    expect(r.svc.detail(id).status).toBe('blocked')
    await expect(r.svc.start(id, {})).rejects.toThrow(/blocked/)
    expect(r.runner.kinds).toEqual(['preflight'])
  })

  it('protected start without the typed name is CONFIRM_REQUIRED and audited denied', async () => {
    const r = await rig()
    r.f.envs.putHost(r.f.prod.id, r.f.host.id, 'app')
    const d = dep(r, 'api', { environmentId: r.f.prod.id, deployTag: 'deploy_prod' })
    const id = await ready(r, [d], { envId: r.f.prod.id })
    for (const typedName of [undefined, 'Prod', 'prod ']) {
      const err = await r.svc.start(id, { typedName }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
      expect((err as DeployError).message).toBe(CONFIRM_MESSAGE)
    }
    expect(audits(r, 'release.start').map((e) => e.outcome)).toEqual(['denied', 'denied', 'denied'])
    expect(r.runner.kinds).toEqual(['preflight'])
    await r.svc.start(id, { typedName: 'prod' })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it('zero commits needs redeploy confirm, forces bump none and stores redeploy', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    r.runner.commitsTotal = 0
    const id = await ready(r, [dep(r, 'api')], { bump: 'minor' })
    const err = await r.svc.start(id, {}).catch((e: unknown) => e)
    expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    expect(r.svc.detail(id).status).toBe('ready')
    await r.svc.start(id, { redeploy: true })
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('succeeded')
    expect(d.redeploy).toBe(true)
    expect(d.version).toBe('v1.4.0')
    expect((r.f.db.prepare('SELECT version_bump AS b FROM releases WHERE id = ?').get(id) as { b: string }).b).toBe('none')
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v1.4.0')
  })

  it('success on a versioned env runs version then commits current_version', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    const id = await ready(r, [dep(r, 'api')], { bump: 'minor' })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'version', 'unlock'])
    expect(r.runner.call('preflight').version).toBe('v1.5.0')
    expect(r.runner.call('version').version).toBe('v1.5.0')
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v1.5.0')
    const d = r.svc.detail(id)
    expect(d.status).toBe('succeeded')
    expect(d.version).toBe('v1.5.0')
    expect(d.previousVersion).toBe('v1.4.0')
    const events = r.svc.events(id, 0)
    expect(events.find((e) => e.type === 'version.bumped')).toMatchObject({ from: 'v1.4.0', to: 'v1.5.0' })
    expect(events.map((e) => e.type)).toContain('run.started')
    expect(events[events.length - 1]).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(audits(r, 'release.finish').map((e) => e.outcome)).toEqual(['success'])
    expect(d.playbook).toBeTruthy()
  })

  it('version tag failure fails the release without rollback and keeps current_version', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    r.runner.on.version = (_p, _s, emit) => {
      emit({ type: 'step.failed', stepId: 'release:version', error: 'tag already exists', durationMs: 1 })
      return { exitCode: 2 }
    }
    const id = await ready(r, [dep(r, 'api')], { bump: 'minor' })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    expect(d.error).toBe('Deployed, but tagging v1.5.0 failed: tag already exists')
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'version', 'unlock'])
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v1.4.0')
    expect(d.runs.every((x) => x.status === 'succeeded')).toBe(true)

    // The tag can be retried without redeploying.
    r.runner.on.version = undefined
    await r.svc.retryVersion(id)
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    expect(r.runner.kinds.slice(-2)).toEqual(['version', 'unlock'])
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v1.5.0')
  })

  it('auto-rollback reverts in reverse order', async () => {
    const r = await rig()
    const deps = [dep(r, 'one'), dep(r, 'two'), dep(r, 'three')]
    const id = await ready(r, deps)
    r.runner.on.release = (plan) => {
      const [r1, r2, r3] = runIds(plan)
      void r3
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r1]: { previous: A }, [r2]: { previous: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const [r1, r2] = runIds(r.runner.call('release'))
    const rb = r.runner.call('rollback')
    expect(runIds(rb)).toEqual([r2, r1])
    expect(rb.deployments.map((d) => d.previousCommit)).toEqual([B, A])
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'rollback', 'unlock'])
    const d = r.svc.detail(id)
    expect(d.status).toBe('rolled_back')
    const types = r.svc.events(id, 0).map((e) => e.type)
    expect(types).toContain('rollback.started')
    expect(types).toContain('rollback.done')
    expect(d.runs.filter((x) => x.rolledBack).map((x) => x.id).sort()).toEqual([r1, r2].sort())
  })

  it('a first deploy is left out of the rollback plan', async () => {
    const r = await rig()
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r2]: { previous: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(runIds(r.runner.call('rollback'))).toEqual([runIds(r.runner.call('release'))[1]])
  })

  it('auto-rollback off ends failed and rollback() later works on the latest release only', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
    const deps = [dep(r, 'one'), dep(r, 'two')]
    const failing = await ready(r, deps)
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r1]: { previous: A }, [r2]: { previous: B } } }
    }
    await r.svc.start(failing, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(failing).status).toBe('failed')
    expect(r.runner.kinds).not.toContain('rollback')

    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous: C }])) })
    const newer = await ready(r, deps)
    await r.svc.start(newer, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(newer).status).toBe('succeeded')

    await expect(r.svc.rollback(failing, {})).rejects.toThrow('Only the latest release of staging can be rolled back')
    const { releaseId } = await r.svc.rollback(newer, {})
    await r.svc.whenIdle()
    const rb = r.svc.detail(releaseId)
    expect(rb.kind).toBe('rollback')
    expect(rb.rollbackOf).toBe(newer)
    expect(rb.status).toBe('succeeded')
    expect(r.svc.detail(newer).status).toBe('rolled_back')
    const plan = r.runner.call('rollback')
    expect(plan.deployments.map((d) => d.name)).toEqual(['two', 'one'])
    expect(plan.deployments.every((d) => d.previousCommit === C)).toBe(true)
    expect(r.runner.kinds.slice(-2)).toEqual(['rollback', 'unlock'])
    expect(audits(r, 'release.rollback')).toHaveLength(1)
  })

  it('unlock always runs', async () => {
    const scenarios: [string, (r: Rig) => Promise<void>][] = [
      ['success', async () => undefined],
      [
        'failure',
        async (r) => {
          r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
          r.runner.on.release = () => ({ exitCode: 2 })
        },
      ],
      [
        'rollback',
        async (r) => {
          r.runner.on.release = (plan) => ({ exitCode: 2, failedDeploymentRunIds: runIds(plan), reachedCheckout: runIds(plan), commits: { [runIds(plan)[0]]: { previous: A } } })
        },
      ],
      [
        'done rejects',
        async (r) => {
          r.runner.on.release = () => {
            throw new Error('spawn exploded')
          }
        },
      ],
    ]
    for (const [name, setup] of scenarios) {
      const r = await rig()
      await setup(r)
      const id = await ready(r)
      await r.svc.start(id, {})
      await r.svc.whenIdle()
      expect(r.runner.kinds[r.runner.kinds.length - 1], name).toBe('unlock')
      expect(r.svc.hasActive(), name).toBe(false)
    }
    const r = await rig()
    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.release = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const id = await ready(r)
    await r.svc.start(id, {})
    expect(r.svc.hasActive()).toBe(true)
    await r.svc.cancel(id)
    await r.svc.whenIdle()
    expect(r.runner.cancels).toHaveLength(1)
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    expect(r.svc.detail(id).status).toBe('cancelled')
    expect(audits(r, 'release.cancel')).toHaveLength(1)
  })

  it('a thrown runner error is redacted and never carries a secret', async () => {
    const r = await rig()
    const d = dep(r, 'api', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    r.runner.on.release = () => {
      throw new Error(`boom with ${SECRET} inside`)
    }
    const id = await ready(r, [d])
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const detail = r.svc.detail(id)
    expect(detail.error).not.toContain(SECRET)
    expect(detail.error).toContain('boom')
    expect(JSON.stringify(r.svc.events(id, 0))).not.toContain(SECRET)
    expect(JSON.stringify(r.f.audit.list({}))).not.toContain(SECRET)
  })

  it('busy names the holder', async () => {
    const r = await rig()
    const id = await ready(r)
    r.runner.on.release = (plan, _s, emit) => {
      emit({
        type: 'lock.busy',
        hostId: r.f.host.id,
        holder: { releaseId: 'x', user: 'ana', machine: 'mbp', environment: 'staging', version: 'v1.5.0', startedAt: '2026-10-19T11:00:00Z' },
        stale: false,
        text: 'ana@mbp is deploying v1.5.0 since 2026-10-19T11:00:00Z',
      })
      return { exitCode: 2, failedDeploymentRunIds: [], reachedCheckout: runIds(plan) }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    expect(d.error).toContain('ana@mbp')
    expect(r.runner.kinds).not.toContain('rollback')
  })

  it('break-lock needs stale + typed label', async () => {
    const r = await rig()
    const holder = (minutes: number) => ({ releaseId: 'x', user: 'ana', machine: 'mbp', environment: 'staging', version: null, startedAt: new Date(NOW - minutes * 60000).toISOString() })
    r.runner.locks = { [r.f.host.id]: { holder: holder(12), stale: false, raw: 'raw-fresh' } }
    const fresh = await ready(r)
    await expect(r.svc.breakLock(fresh, r.f.host.id, { typedLabel: 'app1' })).rejects.toThrow('The lock is only 12 minutes old; wait or ask ana@mbp')

    r.runner.locks = { [r.f.host.id]: { holder: holder(180), stale: true, raw: 'raw-stale' } }
    const first = r.f.deploys.list(r.f.staging.id)[0]
    r.runner.checks = [{ id: 'lock', deploymentId: first.id, hostId: r.f.host.id, label: 'api', level: 'block', message: 'locked by ana@mbp' }]
    const stale = await ready(r, [first])
    expect(r.svc.detail(stale).status).toBe('blocked')
    const err = await r.svc.breakLock(stale, r.f.host.id, { typedLabel: 'APP1' }).catch((e: unknown) => e)
    expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    expect((err as DeployError).message).toBe(BREAK_LOCK_CONFIRM_MESSAGE)
    expect(audits(r, 'deploy.lock_break').map((e) => e.outcome)).toEqual(['denied'])

    r.runner.locks = {}
    r.runner.checks = []
    await r.svc.breakLock(stale, r.f.host.id, { typedLabel: 'app1' })
    expect(r.runner.kinds.slice(-2)).toEqual(['break-lock', 'preflight'])
    expect(r.runner.call('break-lock').lock.expectRaw).toEqual({ [r.f.host.id]: 'raw-stale' })
    expect(r.runner.call('break-lock').deployments.length).toBeGreaterThan(0)
    const d = r.svc.detail(stale)
    expect(d.status).toBe('ready')
    expect(d.preflight?.locks[r.f.host.id]).toBeNull()
    expect(audits(r, 'deploy.lock_break').map((e) => e.outcome).sort()).toEqual(['denied', 'success'])
  })

  it('one active release per environment; MAX_ACTIVE_RELEASES', async () => {
    const r = await rig()
    const g = gate()
    r.runner.on.release = async () => {
      await g.p
    }
    const first = await ready(r)
    await r.svc.start(first, {})
    const second = await ready(r, [r.f.deploys.list(r.f.staging.id)[0]])
    await expect(r.svc.start(second, {})).rejects.toThrow('A release is already running on staging')

    // Three more environments fill the remaining slots; the fifth run is refused.
    const started: string[] = [first]
    for (let i = 0; i < 3; i++) {
      const env = r.f.envs.create({ name: `env${i}`, color: '#112233' })
      r.f.envs.putHost(env.id, r.f.host.id, 'app')
      const d = dep(r, `svc${i}`, { environmentId: env.id })
      const id = await ready(r, [d], { envId: env.id })
      await r.svc.start(id, {})
      started.push(id)
    }
    const env = r.f.envs.create({ name: 'env-extra', color: '#112233' })
    r.f.envs.putHost(env.id, r.f.host.id, 'app')
    const extra = await ready(r, [dep(r, 'extra', { environmentId: env.id })], { envId: env.id })
    await expect(r.svc.start(extra, {})).rejects.toThrow(/At most 4 releases/)
    g.open()
    await r.svc.whenIdle()
    for (const id of started) expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it('finalize runs notes → notify → qa after success; a throw marks only that step', async () => {
    const order: string[] = []
    const finalize: FinalizeSteps = {
      releaseNotes: async (ctx) => {
        order.push('notes')
        expect(ctx.run.environmentName).toBe('staging')
        expect(ctx.run.deployments.map((d) => d.name)).toEqual(['api'])
        return '## notes'
      },
      notify: async () => {
        order.push('notify')
        throw new Error('slack is down')
      },
      qa: async () => {
        order.push('qa')
      },
    }
    const r = await rig({ finalize })
    const id = await ready(r)
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(order).toEqual(['notes', 'notify', 'qa'])
    const d = r.svc.detail(id)
    expect(d.status).toBe('succeeded')
    expect(d.releaseNotes).toBe('## notes')
    const steps = r.svc.events(id, 0).filter((e) => 'stepId' in e && (e.stepId ?? '').startsWith('release:finalize_'))
    expect(steps.map((e) => `${(e as { stepId: string }).stepId}:${e.type}`)).toEqual([
      'release:finalize_notes:step.started',
      'release:finalize_notes:step.done',
      'release:finalize_notify:step.started',
      'release:finalize_notify:step.failed',
      'release:finalize_qa:step.started',
      'release:finalize_qa:step.done',
    ])

    // Never after a failure.
    const r2 = await rig({ finalize })
    order.length = 0
    r2.runner.on.release = () => ({ exitCode: 2 })
    const id2 = await ready(r2)
    await r2.svc.start(id2, {})
    await r2.svc.whenIdle()
    expect(order).toEqual([])
  })

  it('noop finalize steps are reported skipped', async () => {
    const r = await rig()
    const id = await ready(r)
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const done = r.svc.events(id, 0).filter((e) => e.type === 'step.done' && e.stepId.startsWith('release:finalize_'))
    expect(done.map((e) => (e as { state: string }).state)).toEqual(['skipped', 'skipped', 'skipped'])
  })

  it('secrets resolved once at start and dropped at the end', async () => {
    const r = await rig()
    const d = dep(r, 'api', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}\nMODE=prod` })
    r.runner.on.release = (plan) => ({ exitCode: 2, failedDeploymentRunIds: runIds(plan), reachedCheckout: runIds(plan), commits: { [runIds(plan)[0]]: { previous: A } } })
    const id = await ready(r, [d])
    expect(r.valueCalls).toEqual([])
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    // One decrypt for the whole release, shared by the release and rollback runs.
    expect(r.valueCalls).toEqual([r.f.secretId])
    const rel = r.runner.calls.find((c) => c.plan.kind === 'release')!
    const rb = r.runner.calls.find((c) => c.plan.kind === 'rollback')!
    expect(rb.secrets).toBe(rel.secrets)
    const key = rel.plan.deployments[0].envSecretKey as string
    expect(rel.seen.values[key]).toContain(SECRET)
    expect(rel.seen.known).toEqual(expect.arrayContaining([SECRET, 'prod']))
    // The unlock plan needs no secrets.
    const unlock = r.runner.calls.find((c) => c.plan.kind === 'unlock')!
    expect(unlock.seen.values).toEqual({})
    expect(unlock.plan.secretRefs).toEqual({})
    expect(JSON.stringify(rel.plan)).not.toContain(SECRET)
    expect((r.svc as unknown as { live: Map<string, unknown> }).live.size).toBe(0)
    // Dropped for real: the object the runner was given has been wiped, not merely unreferenced.
    expect(rel.secrets.values).toEqual({})
    expect(rel.secrets.known).toEqual([])

    const ref = new WeakRef(rel.secrets)
    r.runner.calls.length = 0
    ;(rel as { secrets: unknown }).secrets = null
    const gc = (globalThis as { gc?: () => void }).gc
    if (gc) {
      await new Promise((res) => setTimeout(res, 0))
      gc()
      expect(ref.deref()).toBeUndefined()
    }
  })

  it('events are batched, persisted with seq and pushed', async () => {
    const r = await rig()
    const id = await ready(r)
    r.batches.length = 0
    const seen: RunEvent[][] = []
    const off = r.svc.onEvent((b) => seen.push(b))
    let midRun = -1
    r.runner.on.release = (_p, _s, emit) => {
      for (const line of ['one', 'two', 'three']) emit({ type: 'log', stepId: null, hostId: null, stream: 'out', line })
      midRun = r.batches.flat().filter((e) => e.type === 'log').length
      r.tick()
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    off()
    expect(midRun).toBe(0)
    const pushed = r.batches.flat()
    const logs = pushed.filter((e) => e.type === 'log')
    expect(logs.map((e) => (e as { line: string }).line)).toEqual(['one', 'two', 'three'])
    expect(r.batches.some((b) => b.filter((e) => e.type === 'log').length === 3)).toBe(true)
    const stored = r.f.releases.events(id, 0, 100)
    expect(stored.map((e) => e.seq)).toEqual([...stored.map((_, i) => i + 1)])
    expect(stored.filter((e) => e.type === 'log').map((e) => e.seq)).toEqual(logs.map((e) => e.seq))
    expect(seen.flat().map((e) => e.id)).toEqual(pushed.map((e) => e.id))
  })

  it('startup recovery marks interrupted releases failed', async () => {
    const r = await rig({ maxEvents: 2 })
    const release = r.f.releases.createRelease({
      environmentId: r.f.staging.id,
      kind: 'release',
      status: 'running',
      version: null,
      previousVersion: null,
      versionBump: 'none',
      redeploy: false,
      rollbackOf: null,
      options: DEFAULT_RELEASE_OPTIONS,
      triggeredBy: 'tester@box',
    })
    r.f.releases.appendEvents(release.id, Array.from({ length: 5 }, (_, i) => ({ type: 'log' as const, stepId: null, hostId: null, stream: 'out' as const, line: `l${i}` })))
    expect(r.f.releases.events(release.id, 0, 50).map((e) => e.type)).toEqual(['log', 'log'])
    const ids = r.svc.recoverInterrupted()
    expect(ids).toEqual([release.id])
    const d = r.svc.detail(release.id)
    expect(d.status).toBe('failed')
    expect(d.error).toBe(INTERRUPTED_MESSAGE)
    // The three dropped logs are flushed as a marker before the final event.
    const types = r.f.releases.events(release.id, 0, 50)
    expect(types.map((e) => e.type)).toEqual(['log', 'log', 'log.truncated', 'run.finished'])
    expect(types[2]).toMatchObject({ dropped: 3 })
    const ev = audits(r, 'release.finish')
    expect(ev).toHaveLength(1)
    expect(ev[0].outcome).toBe('failure')
    expect(ev[0].details).toMatchObject({ interrupted: true, status: 'failed' })
    expect(ev[0]).toMatchObject({ targetType: 'release', targetId: release.id })
    expect(r.svc.recoverInterrupted()).toEqual([])
  })

  it('access denial is audited denied and nothing runs', async () => {
    const access: DeployAccess = { check: async (_a, action) => (action === 'release.start' ? { allowed: false, reason: 'not your environment' } : { allowed: true }) }
    const r = await rig({ access })
    const id = await ready(r)
    const err = await r.svc.start(id, {}).catch((e: unknown) => e)
    expect((err as DeployError).code).toBe('DENIED')
    expect((err as DeployError).message).toBe('not your environment')
    expect(audits(r, 'release.start').map((e) => e.outcome)).toEqual(['denied'])
    expect(r.runner.kinds).toEqual(['preflight'])
    expect(r.svc.detail(id).status).toBe('ready')
  })

  it('discard ends a ready release and closes its stream', async () => {
    const r = await rig()
    const id = await ready(r)
    await r.svc.discard(id)
    expect(r.svc.detail(id).status).toBe('discarded')
    expect(r.svc.events(id, 0).pop()).toMatchObject({ type: 'run.finished' })
    await expect(r.svc.discard(id)).rejects.toThrow(/cannot be discarded/)
    await expect(r.svc.start(id, {})).rejects.toThrow(/discarded/)
  })

  it('a host shared with a protected env requires the typed name', async () => {
    const r = await rig()
    r.f.envs.putHost(r.f.prod.id, r.f.host.id, 'app')
    const id = await ready(r)
    const err = await r.svc.start(id, {}).catch((e: unknown) => e)
    expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    expect(audits(r, 'release.start').map((e) => e.outcome)).toEqual(['denied'])
    expect(r.runner.kinds).toEqual(['preflight'])
    await r.svc.start(id, { typedName: 'prod' })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')

    // Two protected environments on the hosts are refused outright.
    const other = r.f.envs.create({ name: 'dr', color: '#aa0000', protected: true })
    r.f.envs.putHost(other.id, r.f.host.id, 'app')
    const id2 = await ready(r, [r.f.deploys.list(r.f.staging.id)[0]])
    const err2 = await r.svc.start(id2, { typedName: 'prod' }).catch((e: unknown) => e)
    expect((err2 as DeployError).message).toBe('These hosts are in more than one protected environment; run one environment at a time')
  })

  it('step events update deployment_runs.steps, starting from planned pending steps', async () => {
    const r = await rig()
    const d = dep(r, 'api', { preHook: 'echo hi', urls: [{ url: 'http://x/health', from: 'mac' }] } as never)
    const id = await ready(r, [d])
    const planned = r.svc.detail(id).runs[0].steps
    const runId = r.svc.detail(id).runs[0].id
    expect(planned.map((x) => x.kind)).toEqual(['record', 'fetch', 'checkout', 'pre_hook', 'build', 'up', 'health', 'tag'])
    expect(planned.every((x) => x.state === 'pending' && x.stepId === `${runId}:${x.kind}`)).toBe(true)
    r.runner.on.release = (_p, _s, emit) => {
      emit({ type: 'step.started', stepId: `${runId}:record`, kind: 'record', name: 'Record api', hostId: null, deploymentRunId: runId })
      emit({ type: 'step.done', stepId: `${runId}:record`, state: 'ok', durationMs: 3 })
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const steps = r.svc.detail(id).runs[0].steps
    expect(steps).toHaveLength(planned.length)
    expect(steps[0]).toMatchObject({ kind: 'record', state: 'ok' })
    expect(steps[0].startedAt).not.toBeNull()
    expect(steps[1].state).toBe('pending')
  })

  it('a stale preflight version cannot start', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    const a = await ready(r, [dep(r, 'api')], { bump: 'major' })
    const b = await ready(r, [r.f.deploys.list(r.f.staging.id)[0]], { bump: 'minor' })
    await r.svc.start(a, {})
    await r.svc.whenIdle()
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v2.0.0')
    await expect(r.svc.start(b, {})).rejects.toThrow('The version changed since preflight; run preflight again')
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v2.0.0')
    expect(r.svc.detail(b).status).toBe('ready')
  })

  it('a release that is in flight rejects start, discard, break-lock, retry and rollback', async () => {
    const r = await rig()
    const g = gate()
    r.runner.locks = { [r.f.host.id]: { holder: { releaseId: 'x', user: 'ana', machine: 'mbp', environment: 'staging', version: null, startedAt: new Date(NOW - 180 * 60000).toISOString() }, stale: true, raw: 'raw' } }
    const id = await ready(r)
    // Break-lock in flight: everything else on the same release is refused, and whenIdle waits for it.
    r.runner.on['break-lock'] = async () => {
      await g.p
    }
    const brk = r.svc.breakLock(id, r.f.host.id, { typedLabel: 'app1' })
    for (let i = 0; i < 50 && !r.svc.hasActive() && r.runner.kinds.at(-1) !== 'break-lock'; i++) await new Promise((res) => setImmediate(res))
    for (const call of [() => r.svc.start(id, {}), () => r.svc.discard(id), () => r.svc.breakLock(id, r.f.host.id, { typedLabel: 'app1' }), () => r.svc.retryVersion(id), () => r.svc.rollback(id, {})]) {
      await expect(call()).rejects.toThrow('This release is busy')
    }
    const idle = r.svc.whenIdle()
    g.open()
    await brk
    await idle
    expect(r.svc.detail(id).status).toBe('ready')
  })

  it('audit rows name the release and carry ids and counts, never host details', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    const d = dep(r, 'api', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const id = await ready(r, [d], { bump: 'minor' })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const start = audits(r, 'release.start')[0]
    expect(start).toMatchObject({ targetType: 'release', targetId: id, targetLabel: 'staging v1.5.0' })
    expect(start.details).toEqual({ kind: 'release', version: 'v1.5.0', bump: 'minor', redeploy: false, deployments: [d.id], hostCount: 1, credentialIds: [r.f.secretId] })
    const fin = audits(r, 'release.finish')[0]
    expect(fin).toMatchObject({ targetType: 'release', targetId: id, targetLabel: 'staging v1.5.0' })
    expect(fin.details).toMatchObject({ status: 'succeeded', version: 'v1.5.0' })
    expect(typeof (fin.details as { durationSec: number }).durationSec).toBe('number')
    const all = JSON.stringify(r.f.audit.list({ actions: ['release.preflight', 'release.start', 'release.finish'] }))
    for (const bad of ['app1', '10.0.0.7', r.f.host.id, '/srv/api']) expect(all).not.toContain(bad)

    const failing = await rig()
    failing.runner.on.release = (_p, _s, emit) => {
      emit({ type: 'step.failed', stepId: 'x:build', error: 'compose broke', durationMs: 1 })
      return { exitCode: 2 }
    }
    failing.f.deploys.updateSettings(failing.f.staging.id, { autoRollback: false })
    const fid = await ready(failing)
    await failing.svc.start(fid, {})
    await failing.svc.whenIdle()
    expect(audits(failing, 'release.finish')[0].details).toMatchObject({ status: 'failed', failedStep: 'x:build' })
  })

  it('lock-break and discard are audited against the release, without host details', async () => {
    const r = await rig()
    r.runner.locks = { [r.f.host.id]: { holder: { releaseId: 'x', user: 'ana', machine: 'mbp', environment: 'staging', version: null, startedAt: new Date(NOW - 180 * 60000).toISOString() }, stale: true, raw: 'raw' } }
    const id = await ready(r)
    await r.svc.breakLock(id, r.f.host.id, { typedLabel: 'app1' })
    const lb = audits(r, 'deploy.lock_break')[0]
    expect(lb).toMatchObject({ targetType: 'release', targetId: id, outcome: 'success' })
    expect(lb.details).toEqual({ holder: 'ana@mbp', hostCount: 1 })
    await r.svc.discard(id)
    const dis = audits(r, 'release.discard')
    expect(dis).toHaveLength(1)
    expect(dis[0]).toMatchObject({ targetType: 'release', targetId: id, outcome: 'success' })
  })

  it('a throw after the run leaves no stranded row', async () => {
    const r = await rig()
    const id = await ready(r)
    const original = r.f.releases.setStatus.bind(r.f.releases)
    let armed = true
    r.f.releases.setStatus = ((rid: string, status: string, extra?: never) => {
      if (armed && status === 'succeeded') {
        armed = false
        throw new Error('disk full')
      }
      return original(rid, status as never, extra)
    }) as never
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('failed')
    expect(r.svc.events(id, 0).filter((e) => e.type === 'run.finished').length).toBeGreaterThan(0)
  })

  it('concurrent start and discard on one release cannot both pass the guard', async () => {
    const r = await rig()
    const g = gate()
    r.runner.on.release = async () => {
      await g.p
    }
    const id = await ready(r)
    const results = await Promise.allSettled([r.svc.start(id, {}), r.svc.start(id, {}), r.svc.discard(id)])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(2)
    g.open()
    await r.svc.whenIdle()
    expect(r.runner.kinds.filter((k) => k === 'release').length).toBeLessThanOrEqual(1)
  })

  it('discard then start: start refuses and the row stays discarded', async () => {
    const r = await rig()
    const id = await ready(r)
    const results = await Promise.allSettled([r.svc.discard(id), r.svc.start(id, {})])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('discarded')
    expect(r.runner.kinds.filter((k) => k === 'release')).toHaveLength(0)
  })
})
