import { describe, expect, it, vi } from 'vitest'
import { DeployError, type DeployAccess } from '../../src/main/deploy/access'
import type { FinalizeSteps } from '../../src/main/deploy/finalize'
import { INTERRUPTED_MESSAGE } from '../../src/main/deploy/release-store'
import { RESET_CUT_ROLLBACK } from '../../src/main/deploy/release-service'
import { REDACTED } from '../../src/main/security/redact'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { ToolingError } from '../../src/main/deploy/tooling'
import { CONFIRM_MESSAGE } from '../../src/shared/ops'
import { BREAK_LOCK_CONFIRM_MESSAGE, DEFAULT_RELEASE_OPTIONS, LOCK_LEFT_MESSAGE, PREPARE_FAILED_MESSAGE, PREPARE_FETCH_FAILED_MESSAGE, type CommitInfo, type DeploymentMeta, type PreflightCheck, type RunEvent, type StepKind } from '../../src/shared/deploy'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import type { AppServiceMeta } from '../../src/shared/services'
import { A, B, C, NOW, SECRET, dep, opReady, ready, rig, runbook, tracked, type Rig } from './release-rig'
import { PRODUCT } from './inventory-helpers'

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
    expect(ev[0].details).toEqual({ deployments: [d.runs[0].deploymentId], commits: 1, blockers: 0, hostCount: 1, serviceCount: 1, deploymentCount: 1 })
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

  it("a rollback whose health check fails ends the release failed, naming the rollback's failure", async () => {
    const r = await rig()
    const one = dep(r, 'one', { urls: [{ url: 'https://one.example/up', from: 'host' }] })
    const id = await ready(r, [one])
    r.runner.on.release = (plan) => {
      const [r1] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r1], reachedCheckout: [r1], commits: { [r1]: { previous: A } } }
    }
    r.runner.on.rollback = (plan, _s, emit) => {
      const [r1] = runIds(plan)
      emit({ type: 'step.started', stepId: `${r1}:rb_health`, kind: 'rb_health', name: 'Rollback health one', hostId: r.f.host.id, deploymentRunId: r1 })
      emit({ type: 'step.failed', stepId: `${r1}:rb_health`, error: 'Rollback health one failed with exit code 1: OD-HEALTH timeout last=503', durationMs: 1 })
      emit({ type: 'deployment.updated', deploymentRunId: r1, status: 'rollback_failed' })
      // the rollback block rescues its failure, so ansible exits 0
      return { exitCode: 0 }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    expect(d.error).toContain('the rollback also failed: Rollback health one failed')
    expect(r.svc.events(id, 0).find((e) => e.type === 'rollback.done')).toMatchObject({ ok: false })
  })

  it("a manual rollback lists its health check among the run's steps", async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
    const one = dep(r, 'one', { urls: [{ url: 'https://one.example/up', from: 'mac' }] })
    const two = dep(r, 'two')
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous: C }])) })
    const id = await ready(r, [one, two])
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const { releaseId } = await r.svc.rollback(id, {})
    await r.svc.whenIdle()
    const kinds = Object.fromEntries(r.svc.detail(releaseId).runs.map((run) => [run.deploymentName, run.steps.map((s) => s.kind)]))
    expect(kinds.one).toEqual(['rb_checkout', 'rb_build', 'rb_up', 'rb_health', 'rb_tag'])
    expect(kinds.two).toEqual(['rb_checkout', 'rb_build', 'rb_up', 'rb_tag'])
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

  it('auto-rollback off ends failed and rollback() refuses a release whose services were deployed since', async () => {
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

    await expect(r.svc.rollback(failing, {})).rejects.toThrow(`Can't roll back: one-0 and two-1 are now on release ${newer.slice(0, 8)}`)
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
    await expect(r.svc.rollback(releaseId, {})).rejects.toThrow('Only a release can be rolled back')
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

  it('a vault reset cancels a running release, and still releases the deploy lock', async () => {
    const r = await rig()
    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.release = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const id = await ready(r)
    await r.svc.start(id, {})
    r.svc.vaultReset()
    await r.svc.whenIdle()
    expect(r.runner.cancels).toHaveLength(1)
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    expect(r.svc.detail(id).status).toBe('cancelled')
    expect(r.svc.hasActive()).toBe(false)
  })

  it('a vault reset cancels an auto-rollback too, which a plain cancel lets finish, and drops the secrets before the unlock', async () => {
    const r = await rig()
    const d = dep(r, 'one', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const id = await ready(r, [d])
    r.runner.on.release = (plan) => {
      const [r1] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r1], reachedCheckout: [r1], commits: { [r1]: { previous: A } } }
    }
    const g = gate()
    const rolling = gate()
    r.runner.onCancel = g.open
    r.runner.on.rollback = async () => {
      rolling.open()
      await g.p
      return { cancelled: true, exitCode: null }
    }
    let atUnlock: Record<string, string> | null = null
    r.runner.on.unlock = () => {
      atUnlock = { ...r.runner.calls.find((c) => c.plan.kind === 'rollback')!.secrets.values }
      // Late output after the drop still goes through the release's redaction.
      throw new Error(`ssh: permission denied near ${SECRET}`)
    }
    await r.svc.start(id, {})
    await rolling.p
    expect(JSON.stringify(r.runner.calls.find((c) => c.plan.kind === 'rollback')!.secrets.values)).toContain(SECRET)
    const cancelled = r.svc.cancel(id)
    await vi.waitFor(() => expect(audits(r, 'release.cancel')).toHaveLength(1))
    expect(r.runner.cancels).toEqual([])
    r.svc.vaultReset()
    await cancelled
    await r.svc.whenIdle()
    expect(r.runner.cancels).toHaveLength(1)
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'rollback', 'unlock'])
    expect(atUnlock).toEqual({})
    expect(r.svc.detail(id)).toMatchObject({ status: 'cancelled', error: `${RESET_CUT_ROLLBACK}. ${LOCK_LEFT_MESSAGE}` })
    expect(r.svc.hasActive()).toBe(false)
    const lines = r.svc.events(id, 0).flatMap((e) => (e.type === 'log' ? [e.line] : []))
    expect(lines).toContain(`Could not release the deploy lock: ssh: permission denied near ${REDACTED}`)
    expect(JSON.stringify({ events: r.svc.events(id, 0), detail: r.svc.detail(id) })).not.toContain(SECRET)
  })

  it('a vault reset flags every release before cancelling, so one failing cancel never skips the rest', async () => {
    const r = await rig()
    const qa = r.f.envs.create({ productId: PRODUCT, name: 'qa', color: '#334455' })
    r.f.envs.putHost(qa.id, r.f.host.id, 'app')
    const ids = [await ready(r, [dep(r, 'api')]), await ready(r, [dep(r, 'web', { environmentId: qa.id, deployTag: 'deploy_qa' })], { envId: qa.id })]
    const g = gate()
    let started = 0
    const both = gate()
    r.runner.on.release = async () => {
      if (++started === 2) both.open()
      await g.p
      return { cancelled: true, exitCode: null }
    }
    r.runner.onCancel = () => {
      if (r.runner.cancels.length === 1) throw new Error('kill failed')
      g.open()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const id of ids) await r.svc.start(id, {})
    await both.p
    r.svc.vaultReset()
    await r.svc.whenIdle()
    expect(r.runner.cancels).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kill failed'))
    warn.mockRestore()
    for (const id of ids) expect(r.svc.detail(id).status).toBe('cancelled')
    expect(r.svc.hasActive()).toBe(false)
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
      const env = r.f.envs.create({ productId: PRODUCT, name: `env${i}`, color: '#112233' })
      r.f.envs.putHost(env.id, r.f.host.id, 'app')
      const d = dep(r, `svc${i}`, { environmentId: env.id })
      const id = await ready(r, [d], { envId: env.id })
      await r.svc.start(id, {})
      started.push(id)
    }
    const env = r.f.envs.create({ productId: PRODUCT, name: 'env-extra', color: '#112233' })
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

  it('a deploy-lock release that fails at the end says the lock may still be on the hosts', async () => {
    const r = await rig()
    const id = await ready(r)
    r.runner.on.unlock = () => {
      throw new Error("Couldn't read the credentials for app1: vault locked")
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id)).toMatchObject({ status: 'succeeded', error: LOCK_LEFT_MESSAGE })
    const finished = r.svc.events(id, 0).find((e) => e.type === 'run.finished')
    expect(finished).toMatchObject({ status: 'succeeded', error: LOCK_LEFT_MESSAGE })
  })

  it('cancel and a vault lock abort a slow finalize; the run stays succeeded', async () => {
    for (const how of ['cancel', 'lock'] as const) {
      let entered!: () => void
      const inNotes = new Promise<void>((res) => (entered = res))
      const finalize: FinalizeSteps = {
        releaseNotes: (ctx) =>
          new Promise((res) => {
            ctx.signal.addEventListener('abort', () => res('## fallback'))
            entered()
          }),
        notify: async () => undefined,
        qa: async () => undefined,
      }
      const r = await rig({ finalize })
      const id = await ready(r)
      await r.svc.start(id, {})
      await inNotes
      if (how === 'cancel') await r.svc.cancel(id)
      else r.svc.vaultLocked()
      await r.svc.whenIdle()
      expect(r.svc.detail(id).status, how).toBe('succeeded')
      expect(r.svc.detail(id).releaseNotes, how).toBe('## fallback')
    }
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
      serviceIds: [],
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
    const other = r.f.envs.create({ productId: PRODUCT, name: 'dr', color: '#aa0000', protected: true })
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
    // the hook runs as its migrated step, c_0, in the old slot
    expect(planned.map((x) => x.kind)).toEqual(['record', 'fetch', 'checkout', 'custom', 'build', 'up', 'health', 'tag'])
    expect(planned[3]).toMatchObject({ key: 'c_0', label: 'pre-hook' })
    expect(planned.every((x) => x.state === 'pending' && x.stepId === `${runId}:${x.key}`)).toBe(true)
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
    expect(start.details).toEqual({ kind: 'release', version: 'v1.5.0', bump: 'minor', redeploy: false, deployments: [d.id], hostCount: 1, serviceCount: 1, deploymentCount: 1, credentialIds: [r.f.secretId], skippedServiceIds: [] })
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

  it('every release audit row carries its counts, denials, cancels and discards included', async () => {
    const counts = { serviceCount: 1, deploymentCount: 1, hostCount: 1 }
    const denied = await rig({ access: { check: async (_a, action) => (action === 'deploy.view' ? { allowed: false, reason: 'no' } : { allowed: true }) } })
    await expect(ready(denied)).rejects.toThrow(/no/)
    expect(audits(denied, 'release.preflight')[0].details).toEqual({ reason: 'access', ...counts })

    const r = await rig()
    r.f.envs.update(r.f.staging.id, { protected: true })
    const id = await ready(r)
    await expect(r.svc.start(id, {})).rejects.toThrow(DeployError)
    expect(audits(r, 'release.start')[0].details).toEqual({ reason: 'confirm', ...counts })
    await r.svc.discard(id)
    expect(audits(r, 'release.discard')[0].details).toEqual(counts)

    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.release = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const id2 = await ready(r, r.f.deploys.list(r.f.staging.id))
    await r.svc.start(id2, { typedName: 'staging' })
    await r.svc.cancel(id2)
    await r.svc.whenIdle()
    expect(audits(r, 'release.cancel')[0].details).toEqual({ releaseId: id2, ...counts })
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

  it('discard during preflight aborts the checks and ends the release discarded', async () => {
    const r = await rig()
    const g = gate()
    r.runner.on.preflight = async () => {
      await g.p
    }
    r.runner.onCancel = () => g.open()
    const d = dep(r, 'api')
    const { releaseId: id } = await r.svc.preflight({ environmentId: r.f.staging.id, serviceIds: tracked(r, d).map((s) => s.id), bump: 'none', options: DEFAULT_RELEASE_OPTIONS })
    expect(r.svc.detail(id).status).toBe('preflight')
    await r.svc.discard(id)
    expect(r.runner.cancels).toHaveLength(1)
    expect(r.svc.detail(id).status).toBe('discarded')
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('discarded')
    expect(r.states.filter((x) => x === `${id}:ready` || x === `${id}:blocked`)).toEqual([])
    expect(r.f.db.prepare("SELECT count(*) AS n FROM releases WHERE status IN ('ready', 'blocked', 'preflight')").get()).toEqual({ n: 0 })
    expect(audits(r, 'release.discard')).toHaveLength(1)
    // The stream closes once.
    expect(r.svc.events(id, 0).filter((e) => e.type === 'run.finished')).toHaveLength(1)
  })

  it('discard during preflight still ends discarded when the checks finish at the same moment', async () => {
    for (const blocked of [false, true]) {
      const r = await rig()
      const g = gate()
      if (blocked) r.runner.checks = [{ id: 'disk', deploymentId: null, hostId: r.f.host.id, label: 'disk', level: 'block', message: 'full' }]
      // The run ignores the cancel and completes normally as soon as the discard is under way.
      r.runner.on.preflight = async () => {
        await g.p
      }
      const d = dep(r, 'api')
      const { releaseId: id } = await r.svc.preflight({ environmentId: r.f.staging.id, serviceIds: tracked(r, d).map((s) => s.id), bump: 'none', options: DEFAULT_RELEASE_OPTIONS })
      const discard = r.svc.discard(id)
      g.open()
      await discard
      await r.svc.whenIdle()
      expect(r.svc.detail(id).status).toBe('discarded')
      expect(r.states.filter((x) => x === `${id}:ready` || x === `${id}:blocked`)).toEqual([])
    }
    // Checks that finished before the discard reached the row: discarded from ready.
    const r = await rig()
    const id = await ready(r)
    await r.svc.discard(id)
    expect(r.svc.detail(id).status).toBe('discarded')
  })

  it('a denied discard during preflight leaves the checks running', async () => {
    const access: DeployAccess = { check: async (_a, action) => (action === 'deploy.edit' ? { allowed: false, reason: 'read only' } : { allowed: true }) }
    const r = await rig({ access })
    const g = gate()
    r.runner.on.preflight = async () => {
      await g.p
    }
    const d = dep(r, 'api')
    const { releaseId: id } = await r.svc.preflight({ environmentId: r.f.staging.id, serviceIds: tracked(r, d).map((s) => s.id), bump: 'none', options: DEFAULT_RELEASE_OPTIONS })
    await expect(r.svc.discard(id)).rejects.toThrow()
    expect(r.runner.cancels).toEqual([])
    g.open()
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('ready')
  })

  it('discard still refuses a release that is running', async () => {
    const r = await rig()
    const g = gate()
    r.runner.on.release = async () => {
      await g.p
    }
    const id = await ready(r)
    await r.svc.start(id, {})
    await expect(r.svc.discard(id)).rejects.toThrow('This release is busy')
    expect(r.runner.cancels).toEqual([])
    g.open()
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
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

describe('service selection', () => {
  const D = 'd'.repeat(40)
  const E = 'e'.repeat(40)
  const svcIn = (r: Rig, d: DeploymentMeta, name: string, over: { url?: string; urlCheckFrom?: 'host' | 'mac'; composeService?: string } = {}) =>
    r.f.services.create({ kind: 'service', environmentId: d.environmentId, name, deploymentId: d.id, ...over }) as AppServiceMeta
  const runRows = (r: Rig, id: string) =>
    r.f.db.prepare('SELECT deployment_name AS name, services, whole_checkout AS whole FROM deployment_runs WHERE release_id = ? ORDER BY position').all(id) as unknown as { name: string; services: string; whole: number }[]
  /** shop (web, worker), billing (pay) and an untouched checkout, in that position order. */
  const shopRig = async () => {
    const r = await rig()
    const shop = dep(r, 'shop')
    const billing = dep(r, 'billing', { urls: [{ url: 'https://billing.example/up', from: 'mac' }] })
    const idle = dep(r, 'idle')
    const web = svcIn(r, shop, 'web', { url: 'https://web.example/up', urlCheckFrom: 'host' })
    const worker = svcIn(r, shop, 'worker', { composeService: 'queue-worker' })
    const pay = svcIn(r, billing, 'pay')
    svcIn(r, idle, 'idler')
    return { r, shop, billing, idle, web, worker, pay }
  }

  it('preflight plans only affected checkouts, with services null when whole and the list when partial', async () => {
    const { r, web, worker, pay } = await shopRig()
    const id = await ready(r, [], { serviceIds: [pay.id, web.id] })
    expect(r.svc.detail(id).status).toBe('ready')
    const pf = r.runner.call('preflight').deployments
    expect(pf.map((d) => [d.name, d.services])).toEqual([
      ['shop', ['web']],
      ['billing', null],
    ])
    // Start plans the same form from the stored runs.
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.runner.call('release').deployments.map((d) => [d.name, d.services])).toEqual([
      ['shop', ['web']],
      ['billing', null],
    ])
    const all = await ready(r, [], { serviceIds: [worker.id, web.id] })
    expect(r.runner.call('preflight', 1).deployments.map((d) => [d.name, d.services])).toEqual([['shop', null]])
    expect(r.svc.detail(all).runs).toHaveLength(1)
  })

  it("health uses the selected services' urls with url_check_from, else the checkout's urls", async () => {
    const { r, shop, web, worker, pay, idle } = await shopRig()
    const id = await ready(r, [], { serviceIds: [web.id, worker.id, pay.id, ...r.f.services.forCheckout(idle.id).map((s) => s.id)] })
    const plan = r.runner.call('preflight')
    expect(plan.deployments.map((d) => [d.name, d.urls])).toEqual([
      ['shop', [{ url: 'https://web.example/up', from: 'host' }]],
      ['billing', [{ url: 'https://billing.example/up', from: 'mac' }]],
      ['idle', []],
    ])
    const steps = r.svc.detail(id).runs.map((run) => [run.deploymentName, run.steps.some((s) => s.kind === 'health')])
    expect(steps).toEqual([
      ['shop', true],
      ['billing', true],
      ['idle', false],
    ])
    // a partial selection without a url falls back to the checkout's urls (shop has none: no health)
    const partial = await ready(r, [], { serviceIds: [worker.id] })
    expect(r.runner.call('preflight', 1).deployments[0].urls).toEqual(shop.urls)
    expect(r.svc.detail(partial).runs[0].steps.some((s) => s.kind === 'health')).toBe(false)
  })

  it('preflight stores service_ids and per-run services with previous commits', async () => {
    const { r, shop, web, worker, pay } = await shopRig()
    const r0 = await ready(r, [], { serviceIds: [web.id] })
    r.f.services.recordDeployed([{ serviceId: web.id, commit: A, releaseId: r0 }])
    const id = await ready(r, [], { serviceIds: [pay.id, web.id] })
    const row = r.f.db.prepare('SELECT service_ids FROM releases WHERE id = ?').get(id) as { service_ids: string }
    expect(JSON.parse(row.service_ids)).toEqual([web.id, pay.id])
    expect(runRows(r, id).map((x) => ({ ...x, services: JSON.parse(x.services) }))).toEqual([
      { name: 'shop', whole: 0, services: [{ id: web.id, name: 'web', composeService: 'web', previousCommit: A, previousReleaseId: r0, deployedCommit: null }] },
      { name: 'billing', whole: 1, services: [{ id: pay.id, name: 'pay', composeService: 'pay', previousCommit: null, previousReleaseId: null, deployedCommit: null }] },
    ])
    // a whole checkout stores every tracked service
    const whole = await ready(r, [], { serviceIds: [worker.id, web.id] })
    expect(runRows(r, whole).map((x) => [x.whole, JSON.parse(x.services).map((e: { composeService: string }) => e.composeService)])).toEqual([[1, ['web', 'queue-worker']]])
    // a checkout with no services is chosen by checkoutIds and stores none
    const bare = dep(r, 'bare')
    const b = await ready(r, [], { serviceIds: [], checkoutIds: [bare.id] })
    expect(runRows(r, b).map((x) => [x.name, x.whole, x.services])).toEqual([['bare', 1, '[]']])
    expect(JSON.parse((r.f.db.prepare('SELECT service_ids FROM releases WHERE id = ?').get(b) as { service_ids: string }).service_ids)).toEqual([])
    await expect(r.svc.preflight({ environmentId: r.f.staging.id, serviceIds: [], checkoutIds: [shop.id], bump: 'none', options: DEFAULT_RELEASE_OPTIONS })).rejects.toThrow(
      'shop has services; pick them instead',
    )
  })

  it('the schema refuses a db service on a checkout, so a whole checkout never holds one', async () => {
    const { r, shop, web, worker } = await shopRig()
    const pg = r.f.services.create({ kind: 'db', environmentId: r.f.staging.id, name: 'pg', dbEngine: 'postgres', dbAddress: '10.0.0.5' })
    expect(() => r.f.db.prepare('UPDATE services SET deployment_id = ? WHERE id = ?').run(shop.id, pg.id)).toThrow(/CHECK/)
    await ready(r, [], { serviceIds: [web.id, worker.id] })
    const pf = r.runner.call('preflight').deployments
    expect(pf.map((d) => [d.name, d.services])).toEqual([['shop', null]])
    await expect(r.svc.preflight({ environmentId: r.f.staging.id, serviceIds: [web.id, pg.id], bump: 'none', options: DEFAULT_RELEASE_OPTIONS })).rejects.toThrow(
      'pg is a database; databases are never deployed',
    )
  })

  it('access receives deploy.view with the affected checkout ids', async () => {
    const seen: { action: string; deploymentIds: string[] }[] = []
    const access: DeployAccess = {
      check: async (_a, action, scope) => {
        seen.push({ action, deploymentIds: scope.deploymentIds ?? [] })
        return { allowed: true }
      },
    }
    const r = await rig({ access })
    const shop = dep(r, 'shop')
    const billing = dep(r, 'billing')
    dep(r, 'idle')
    const web = svcIn(r, shop, 'web')
    svcIn(r, shop, 'worker')
    const pay = svcIn(r, billing, 'pay')
    const id = await ready(r, [], { serviceIds: [web.id, pay.id] })
    expect(seen[0]).toEqual({ action: 'deploy.view', deploymentIds: [shop.id, billing.id] })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(seen.find((x) => x.action === 'release.start')).toEqual({ action: 'release.start', deploymentIds: [shop.id, billing.id] })
  })

  it('partial preflight passes the deps warning through to the report', async () => {
    const { r, shop, web } = await shopRig()
    const warn: PreflightCheck = { id: 'deps', deploymentId: shop.id, hostId: r.f.host.id, label: 'shop', level: 'warn', message: "web depends on db, which isn't running. --no-deps won't start it" }
    r.runner.checks = [warn]
    const id = await ready(r, [], { serviceIds: [web.id] })
    const d = r.svc.detail(id)
    expect(d.status).toBe('ready')
    expect(d.preflight?.checks).toContainEqual(warn)
    expect(r.svc.events(id, 0).some((e) => e.type === 'preflight.check' && e.check.id === 'deps')).toBe(true)
  })

  it("serviceCommits counts commits since each service's last commit and falls back to the tag", async () => {
    const { r, shop, billing, web, worker, pay } = await shopRig()
    const api = svcIn(r, shop, 'api')
    r.f.services.recordDeployed([
      { serviceId: web.id, commit: B, releaseId: null },
      { serviceId: api.id, commit: E, releaseId: null },
    ])
    const ci = (sha: string, deploymentId: string): CommitInfo => ({ sha, subject: `s ${sha[0]}`, author: 'dev', date: '2026-10-18T00:00:00Z', deploymentId })
    r.runner.on.preflight = (plan) => ({
      preflight: {
        checks: [],
        commits: {
          [shop.id]: { commits: [D, C, B, A].map((x) => ci(x, shop.id)), hiddenPairs: 0, truncated: 0, firstDeploy: false, head: D, tagCommit: A },
          [billing.id]: { commits: [C].map((x) => ci(x, billing.id)), hiddenPairs: 0, truncated: 0, firstDeploy: true, head: C, tagCommit: null },
        },
        dockerModes: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, 'plain' as const])),
        composeServices: {},
        locks: {},
        commitsTotal: 5,
        blocked: false,
      },
    })
    const id = await ready(r, [], { serviceIds: [web.id, worker.id, api.id, pay.id] })
    expect(r.svc.detail(id).preflight?.serviceCommits).toEqual({
      [web.id]: { since: B, count: 2, known: true, skippable: false },
      // no last commit: the tag's commit
      [worker.id]: { since: A, count: 3, known: true, skippable: false },
      // not in the list: the whole list
      [api.id]: { since: E, count: 4, known: false, skippable: false },
      // first deploy, no tag: every commit
      [pay.id]: { since: null, count: 1, known: false, skippable: false },
    })
  })
})

describe('per-service record', () => {
  const svcIn = (r: Rig, d: DeploymentMeta, name: string, over: { composeService?: string } = {}) =>
    r.f.services.create({ kind: 'service', environmentId: d.environmentId, name, deploymentId: d.id, ...over }) as AppServiceMeta
  /** platform (esg, ui), billing (pay) and idle (idler), in that position order. */
  const platformRig = async () => {
    const r = await rig()
    const platform = dep(r, 'platform')
    const billing = dep(r, 'billing')
    const idle = dep(r, 'idle')
    const esg = svcIn(r, platform, 'esg')
    const ui = svcIn(r, platform, 'ui')
    const pay = svcIn(r, billing, 'pay')
    const idler = svcIn(r, idle, 'idler')
    return { r, platform, billing, idle, esg, ui, pay, idler }
  }
  /** Every run checks out `deployed` over `previous`. */
  const deploys = (previous: string, deployed: string) => (plan: DeployPlan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous, deployed }])) })
  const last = (r: Rig, id: string) => {
    const s = r.f.services.get(id) as AppServiceMeta
    return [s.lastDeployedCommit, s.lastReleaseId]
  }
  const release = async (r: Rig, serviceIds: string[], previous: string, deployed: string): Promise<string> => {
    const id = await ready(r, [], { serviceIds })
    r.runner.on.release = deploys(previous, deployed)
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    return id
  }
  const rowOf = (r: Rig, id: string) => r.f.db.prepare('SELECT service_ids FROM releases WHERE id = ?').get(id) as { service_ids: string }

  it('success records last_deployed_commit and last_release_id for deployed services only', async () => {
    const { r, esg, ui, pay, idler } = await platformRig()
    const ok = await release(r, [esg.id, pay.id], A, B)
    expect(last(r, esg.id)).toEqual([B, ok])
    expect(last(r, pay.id)).toEqual([B, ok])
    expect(last(r, ui.id)).toEqual([null, null])
    expect(r.svc.detail(ok).runs.map((x) => x.services.map((e) => [e.name, e.previousCommit, e.deployedCommit]))).toEqual([[['esg', null, B]], [['pay', null, B]]])

    // A later run fails with auto-rollback off: the run that succeeded is recorded, the failed one is not.
    r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
    const bad = await ready(r, [], { serviceIds: [esg.id, pay.id, idler.id] })
    r.runner.on.release = (plan) => {
      const [r1, r2, r3] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r1]: { previous: B, deployed: C }, [r2]: { previous: B, deployed: C }, [r3]: {} } }
    }
    await r.svc.start(bad, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(bad).status).toBe('failed')
    expect(last(r, esg.id)).toEqual([C, bad])
    expect(last(r, pay.id)).toEqual([B, ok])
    expect(last(r, idler.id)).toEqual([null, null])
  })

  it('start refuses when a selected service changed since preflight', async () => {
    const { r, platform, billing, esg, ui, pay } = await platformRig()
    const refused = async (serviceIds: string[], change: () => void, name: string) => {
      const id = await ready(r, [], { serviceIds })
      change()
      const err = await r.svc.start(id, {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('INVALID_STATE')
      expect((err as DeployError).message).toBe(`${name} changed since preflight; run preflight again`)
    }
    await refused([esg.id], () => r.f.services.update(esg.id, { composeService: 'esg-api' }), 'esg')
    await refused([esg.id], () => r.f.services.update(esg.id, { deploymentId: billing.id }), 'esg')
    r.f.services.update(esg.id, { deploymentId: platform.id })
    await refused([pay.id], () => r.f.services.delete(pay.id), 'pay')
    // whole platform gains a service; partial platform loses the one it left out
    await refused([esg.id, ui.id], () => svcIn(r, platform, 'cron'), 'platform')
    const cron = r.f.services.forCheckout(platform.id).find((s) => s.name === 'cron') as AppServiceMeta
    await refused([esg.id, ui.id], () => r.f.services.delete(cron.id), 'platform')
    await refused([esg.id], () => r.f.services.delete(ui.id), 'platform')
    expect(r.runner.kinds).not.toContain('release')
  })

  it('a checkout with no services, deployed whole, refuses a start once it gains one and records it after', async () => {
    const r = await rig()
    const bare = dep(r, 'bare')
    const id = await ready(r, [], { checkoutIds: [bare.id] })
    expect(r.svc.detail(id).runs.map((x) => [x.deploymentName, x.wholeCheckout, x.services])).toEqual([['bare', true, []]])
    const late = svcIn(r, bare, 'late')
    const err = await r.svc.start(id, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).message).toBe('bare changed since preflight; run preflight again')
    expect(r.runner.kinds).not.toContain('release')

    // It has a service now, so it's picked by service.
    const again = await ready(r, [], { serviceIds: [late.id] })
    r.runner.on.release = deploys(A, B)
    await r.svc.start(again, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(again).status).toBe('succeeded')
    expect(last(r, late.id)).toEqual([B, again])
  })

  it("auto-rollback rolls back only selected services, in reverse, in the release's form", async () => {
    const { r, esg, ui, pay, idler } = await platformRig()
    const r0 = await release(r, [esg.id, pay.id], C, A)
    const id = await ready(r, [], { serviceIds: [esg.id, pay.id, idler.id] })
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r1]: { previous: A, deployed: B }, [r2]: { previous: A, deployed: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('rolled_back')
    const [r1, r2] = runIds(r.runner.call('release', 1))
    const rb = r.runner.call('rollback')
    expect(rb.deployments.map((d) => [d.runId, d.name, d.services, d.previousCommit])).toEqual([
      [r2, 'billing', null, A],
      [r1, 'platform', ['esg'], A],
    ])
    // esg was recorded at B when its run succeeded, then restored with the rollback.
    expect(r.svc.detail(id).runs[0].services.map((e) => [e.name, e.previousCommit, e.deployedCommit])).toEqual([['esg', A, B]])
    expect(last(r, esg.id)).toEqual([A, r0])
    expect(last(r, pay.id)).toEqual([A, r0])
    expect(last(r, ui.id)).toEqual([null, null])
    expect(last(r, idler.id)).toEqual([null, null])
  })

  it('rollback of R1 is allowed after R2 touched only a sibling, and rebuilds esg only', async () => {
    const { r, esg, ui } = await platformRig()
    const r1 = await release(r, [esg.id], A, B)
    await release(r, [ui.id], A, C)
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(r.runner.call('rollback').deployments.map((d) => [d.name, d.services, d.previousCommit])).toEqual([['platform', ['esg'], A]])
    expect(r.svc.detail(r1).status).toBe('rolled_back')
  })

  it('rollback of R1 is refused after R2 redeployed esg, naming esg', async () => {
    const { r, esg, ui, pay } = await platformRig()
    const r1 = await release(r, [esg.id], A, B)
    const r2 = await release(r, [esg.id, ui.id], B, C)
    const err = await r.svc.rollback(r1, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).code).toBe('INVALID_STATE')
    expect((err as DeployError).message).toBe(`Can't roll back: esg is now on release ${r2.slice(0, 8)}`)
    const r3 = await release(r, [ui.id, pay.id], C, A)
    const r4 = await release(r, [ui.id, pay.id], A, B)
    await expect(r.svc.rollback(r3, {})).rejects.toThrow(`Can't roll back: ui and pay are now on release ${r4.slice(0, 8)}`)
    expect(r.runner.kinds).not.toContain('rollback')
  })

  it('a failed, auto-rolled-back R2 leaves R1 the one to roll back, and a succeeded R2 still blocks it', async () => {
    const { r, esg, ui } = await platformRig()
    const r1 = await release(r, [esg.id], A, B)
    const failR2 = async (reached: boolean) => {
      const id = await ready(r, [], { serviceIds: [esg.id] })
      r.runner.on.release = (plan) => {
        const [x] = runIds(plan)
        return { exitCode: 2, failedDeploymentRunIds: [x], reachedCheckout: reached ? [x] : [], commits: { [x]: reached ? { previous: B } : {} } }
      }
      await r.svc.start(id, {})
      await r.svc.whenIdle()
      return id
    }
    const r2 = await failR2(true)
    expect(r.svc.detail(r2).status).toBe('rolled_back')
    expect(last(r, esg.id)).toEqual([B, r1])
    // R2 failing before checkout counts no more than R2 rolled back.
    const r3 = await failR2(false)
    expect(r.svc.detail(r3).status).toBe('failed')
    expect(Object.fromEntries(r.f.releases.latestTouching([esg.id]))).toEqual({ [esg.id]: r1 })
    await expect(r.svc.rollback(r2, {})).rejects.toThrow('Nothing to roll back: this release was already rolled back')
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(r.runner.call('rollback', r.runner.kinds.filter((k) => k === 'rollback').length - 1).deployments.map((d) => [d.name, d.services, d.previousCommit])).toEqual([['platform', ['esg'], A]])

    // A succeeded R2 is a real redeploy.
    const r4 = await release(r, [ui.id], A, B)
    const r5 = await release(r, [ui.id], B, C)
    await expect(r.svc.rollback(r4, {})).rejects.toThrow(`Can't roll back: ui is now on release ${r5.slice(0, 8)}`)
  })

  it('after rolling back R2 by hand, R1 can be rolled back too, rebuilding at its previous commit', async () => {
    const { r, esg, pay } = await platformRig()
    const r1 = await release(r, [esg.id, pay.id], A, B)
    const r2 = await release(r, [esg.id, pay.id], B, C)
    const err = await r.svc.rollback(r1, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).message).toBe(`Can't roll back: esg and pay are now on release ${r2.slice(0, 8)}`)
    await r.svc.rollback(r2, {})
    await r.svc.whenIdle()
    expect(last(r, esg.id)).toEqual([B, r1])
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(r.runner.call('rollback', 1).deployments.map((d) => [d.name, d.services, d.previousCommit])).toEqual([
      ['billing', null, A],
      ['platform', ['esg'], A],
    ])
    expect(last(r, esg.id)).toEqual([A, null])
    await expect(r.svc.rollback(r1, {})).rejects.toThrow('Nothing to roll back: this release was already rolled back')
    expect(r.runner.kinds.filter((k) => k === 'rollback')).toHaveLength(2)
  })

  it('with auto-rollback off, rolling back R1 blocks rolling back the later failed R2, record or none', async () => {
    for (const recorded of [true, false]) {
      const { r, esg } = await platformRig()
      r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
      // With a record, R0 put esg at A; without, esg was never recorded and the host is at A.
      if (recorded) await release(r, [esg.id], C, A)
      const fail = async (previous: string, deployed: string) => {
        const id = await ready(r, [], { serviceIds: [esg.id] })
        r.runner.on.release = (plan) => {
          const [x] = runIds(plan)
          return { exitCode: 2, failedDeploymentRunIds: [x], reachedCheckout: [x], commits: { [x]: { previous, deployed } } }
        }
        await r.svc.start(id, {})
        await r.svc.whenIdle()
        expect(r.svc.detail(id).status).toBe('failed')
        return id
      }
      const r1 = await fail(A, B)
      const r2 = await fail(B, C)
      const { releaseId: rb1 } = await r.svc.rollback(r1, {})
      await r.svc.whenIdle()
      expect(r.svc.detail(rb1).status).toBe('succeeded')
      // R2's previous commit is R1's failed one: rolling R2 back now would put it back.
      const err = await r.svc.rollback(r2, {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).message).toBe(`Can't roll back: esg is now on the rollback of ${r1.slice(0, 8)}`)
      expect(r.runner.kinds.filter((k) => k === 'rollback')).toHaveLength(1)
    }
  })

  it('after rolling back R2, a later R3 undone by hand or automatically leaves R1 on record and rollbackable', async () => {
    for (const auto of [false, true]) {
      const { r, esg } = await platformRig()
      const r1 = await release(r, [esg.id], A, B)
      const r2 = await release(r, [esg.id], B, C)
      await r.svc.rollback(r2, {})
      await r.svc.whenIdle()
      if (auto) {
        const id = await ready(r, [], { serviceIds: [esg.id] })
        r.runner.on.release = (plan) => {
          const [x] = runIds(plan)
          return { exitCode: 2, failedDeploymentRunIds: [x], reachedCheckout: [x], commits: { [x]: { previous: B, deployed: C } } }
        }
        await r.svc.start(id, {})
        await r.svc.whenIdle()
        expect(r.svc.detail(id).status).toBe('rolled_back')
      } else {
        const r3 = await release(r, [esg.id], B, C)
        await r.svc.rollback(r3, {})
        await r.svc.whenIdle()
      }
      // The record names the release the host is back on, never a rollback.
      expect(last(r, esg.id)).toEqual([B, r1])
      const { releaseId } = await r.svc.rollback(r1, {})
      await r.svc.whenIdle()
      expect(r.svc.detail(releaseId).status).toBe('succeeded')
      expect(last(r, esg.id)).toEqual([A, null])
    }
  })

  it('rollback restores last_deployed_commit to the commit it checked out', async () => {
    const { r, esg, pay } = await platformRig()
    const r0 = await release(r, [esg.id], C, A)
    const r1 = await release(r, [esg.id, pay.id], A, B)
    expect(last(r, esg.id)).toEqual([B, r1])
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(last(r, esg.id)).toEqual([A, r0])
    // pay's first deploy had no commit of its own, but the rollback rebuilt it at the checkout's A.
    expect(last(r, pay.id)).toEqual([A, null])
  })

  it("a manual rollback records the checkout's previous commit, not the service's own", async () => {
    const { r, esg, ui } = await platformRig()
    const r0 = await release(r, [esg.id], C, A)
    await release(r, [ui.id], A, B)
    // esg's entry remembers A, while the checkout it moves from is at B.
    const r2 = await release(r, [esg.id], B, C)
    expect(r.svc.detail(r2).runs[0].services.map((e) => [e.previousCommit, e.deployedCommit])).toEqual([[A, C]])
    const { releaseId } = await r.svc.rollback(r2, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(r.runner.call('rollback').deployments.map((d) => [d.services, d.previousCommit])).toEqual([[['esg'], B]])
    expect(r.svc.detail(releaseId).runs[0].services.map((e) => [e.name, e.previousCommit, e.deployedCommit])).toEqual([['esg', C, B]])
    expect(last(r, esg.id)).toEqual([B, r0])
  })

  it("an auto-rollback restores the checkout's previous commit, not the service's own", async () => {
    const { r, esg, ui, pay } = await platformRig()
    const r0 = await release(r, [esg.id], C, A)
    await release(r, [ui.id], A, B)
    const id = await ready(r, [], { serviceIds: [esg.id, pay.id] })
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], commits: { [r1]: { previous: B, deployed: C }, [r2]: { previous: B, deployed: C } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('rolled_back')
    expect(last(r, esg.id)).toEqual([B, r0])
    expect(last(r, pay.id)).toEqual([B, null])
  })

  it('start refuses a release whose services were deployed since its preflight', async () => {
    const { r, esg, pay } = await platformRig()
    const p1 = await ready(r, [], { serviceIds: [esg.id] })
    const p2 = await ready(r, [], { serviceIds: [esg.id] })
    r.runner.on.release = deploys(A, B)
    await r.svc.start(p2, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(p2).status).toBe('succeeded')
    const err = await r.svc.start(p1, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).code).toBe('INVALID_STATE')
    expect((err as DeployError).message).toBe('esg was deployed since preflight; run preflight again')
    // The same commit deployed again by a newer release still counts.
    const p3 = await ready(r, [], { serviceIds: [esg.id, pay.id] })
    const p4 = await ready(r, [], { serviceIds: [esg.id] })
    await r.svc.start(p4, {})
    await r.svc.whenIdle()
    expect(last(r, esg.id)).toEqual([B, p4])
    await expect(r.svc.start(p3, {})).rejects.toThrow('esg was deployed since preflight; run preflight again')
    expect(r.runner.kinds.filter((k) => k === 'release')).toHaveLength(2)
  })

  it('a rollback ignores the first-deploy services of its source when checking for newer deploys', async () => {
    const { r, esg, pay } = await platformRig()
    const r1 = await ready(r, [], { serviceIds: [esg.id, pay.id] })
    // platform is a first deploy (no previous commit); billing moves from A.
    r.runner.on.release = (plan) => {
      const [x, y] = runIds(plan)
      return { commits: { [x]: { deployed: B }, [y]: { previous: A, deployed: B } } }
    }
    await r.svc.start(r1, {})
    await r.svc.whenIdle()
    await release(r, [esg.id], B, C)
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
    expect(r.runner.call('rollback').deployments.map((d) => d.name)).toEqual(['billing'])
    expect(last(r, esg.id)).toEqual([C, expect.any(String)])
  })

  it('rolling back an auto-rolled-back release says it was already rolled back', async () => {
    const { r, esg } = await platformRig()
    const id = await ready(r, [], { serviceIds: [esg.id] })
    r.runner.on.release = (plan) => {
      const [x] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [x], reachedCheckout: [x], commits: { [x]: { previous: A } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('rolled_back')
    const err = await r.svc.rollback(id, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).message).toBe('Nothing to roll back: this release was already rolled back')
    expect(r.runner.kinds.filter((k) => k === 'rollback')).toHaveLength(1)
  })

  it('a run with no deployed commit never erases a known one', async () => {
    const { r, esg } = await platformRig()
    const r1 = await release(r, [esg.id], A, B)
    const id = await ready(r, [], { serviceIds: [esg.id] })
    r.runner.on.release = () => ({ commits: {} })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    expect(last(r, esg.id)).toEqual([B, r1])
    // A deployed value that is not a full sha counts as none.
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous: B, deployed: 'HEAD' }])) })
    const id2 = await ready(r, [], { serviceIds: [esg.id] })
    await r.svc.start(id2, {})
    await r.svc.whenIdle()
    expect(last(r, esg.id)).toEqual([B, r1])
  })

  it('a store error while restoring does not fail a rollback that succeeded', async () => {
    const { r, esg } = await platformRig()
    const r1 = await release(r, [esg.id], A, B)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const spy = vi.spyOn(r.f.services, 'recordDeployed').mockImplementation(() => {
      throw new Error('disk full')
    })
    try {
      const { releaseId } = await r.svc.rollback(r1, {})
      await r.svc.whenIdle()
      expect(r.svc.detail(releaseId).status).toBe('succeeded')
      expect(r.svc.detail(r1).status).toBe('rolled_back')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0].join(' '))).toContain('disk full')
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })

  it('a rollback release records the same services as its source', async () => {
    const { r, esg, pay } = await platformRig()
    r.f.services.recordDeployed([{ serviceId: esg.id, commit: A, releaseId: null }, { serviceId: pay.id, commit: A, releaseId: null }])
    const r1 = await release(r, [esg.id, pay.id], A, B)
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    const rb = r.svc.detail(releaseId)
    expect([...rb.serviceIds].sort()).toEqual([esg.id, pay.id].sort())
    expect(JSON.parse(rowOf(r, releaseId).service_ids)).toEqual(rb.serviceIds)
    expect(rb.serviceCount).toBe(2)
    expect(rb.runs.map((x) => [x.deploymentName, x.wholeCheckout, x.services.map((e) => [e.name, e.previousCommit, e.deployedCommit])])).toEqual([
      ['billing', true, [['pay', B, A]]],
      ['platform', false, [['esg', B, A]]],
    ])
    expect(Object.fromEntries(r.f.releases.latestTouching([esg.id, pay.id]))).toEqual({ [esg.id]: releaseId, [pay.id]: releaseId })
  })

  it('a previous commit that is not a full sha is kept as recorded but never used as a commit', async () => {
    const { r, esg } = await platformRig()
    r.f.services.recordDeployed([{ serviceId: esg.id, commit: 'v1.2', releaseId: null }])
    const r1 = await release(r, [esg.id], A, B)
    expect(r.svc.detail(r1).runs[0].services[0]).toMatchObject({ previousCommit: 'v1.2', deployedCommit: B })
    // The count falls back to the tag (none here) rather than looking for 'v1.2'.
    expect(r.svc.detail(r1).preflight?.serviceCommits[esg.id]).toEqual({ since: null, count: 0, known: false, skippable: false })
    const { releaseId } = await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).runs[0].services.map((e) => [e.previousCommit, e.deployedCommit])).toEqual([[B, A]])
    expect(last(r, esg.id)).toEqual([A, null])
  })

  it('after rolling back R1, rolling back R1 again is refused', async () => {
    const { r, esg, pay } = await platformRig()
    const r1 = await release(r, [esg.id, pay.id], A, B)
    await r.svc.rollback(r1, {})
    await r.svc.whenIdle()
    await expect(r.svc.rollback(r1, {})).rejects.toThrow('Nothing to roll back: this release was already rolled back')
    expect(r.runner.kinds.filter((k) => k === 'rollback')).toHaveLength(1)
  })

  it('protected rollback still needs the typed name', async () => {
    const r = await rig()
    r.f.envs.putHost(r.f.prod.id, r.f.host.id, 'app')
    const d = dep(r, 'api', { environmentId: r.f.prod.id, deployTag: 'deploy_prod' })
    const id = await ready(r, [d], { envId: r.f.prod.id })
    r.runner.on.release = deploys(A, B)
    await r.svc.start(id, { typedName: 'prod' })
    await r.svc.whenIdle()
    for (const typedName of [undefined, 'Prod']) {
      const err = await r.svc.rollback(id, { typedName }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    }
    expect(audits(r, 'release.rollback').map((e) => e.outcome)).toEqual(['denied', 'denied'])
    const { releaseId } = await r.svc.rollback(id, { typedName: 'prod' })
    await r.svc.whenIdle()
    expect(r.svc.detail(releaseId).status).toBe('succeeded')
  })

  it('a checkout-only release counts its run entries the same at start, finish and in its summary', async () => {
    const r = await rig()
    const bare = dep(r, 'bare')
    const id = await ready(r, [], { serviceIds: [], checkoutIds: [bare.id] })
    r.runner.on.release = deploys(A, B)
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    const count = r.svc.detail(id).runs.reduce((n, x) => n + x.services.length, 0)
    for (const action of ['release.preflight', 'release.start', 'release.finish']) {
      expect(audits(r, action).find((e) => e.targetId === id)?.details).toMatchObject({ serviceCount: count, deploymentCount: 1 })
    }
    expect(r.svc.detail(id).serviceCount).toBe(count)
  })

  it('release audits carry serviceCount, deploymentCount and hostCount and no host ids or labels', async () => {
    const { r, esg, ui, pay } = await platformRig()
    const id = await release(r, [esg.id, ui.id, pay.id], A, B)
    const counts = { serviceCount: 3, deploymentCount: 2, hostCount: 1 }
    for (const action of ['release.preflight', 'release.start', 'release.finish']) {
      expect(audits(r, action).find((e) => e.targetId === id)?.details).toMatchObject(counts)
    }
    const { releaseId } = await r.svc.rollback(id, {})
    await r.svc.whenIdle()
    expect(audits(r, 'release.rollback')[0].details).toMatchObject({ rollbackOf: id, serviceCount: 3, deploymentCount: 2, hostCount: 1 })
    expect(audits(r, 'release.finish').find((e) => e.targetId === releaseId)?.details).toMatchObject({ status: 'succeeded', serviceCount: 3, deploymentCount: 2, hostCount: 1 })
    const all = JSON.stringify(r.f.audit.list({ actions: ['release.preflight', 'release.start', 'release.finish', 'release.rollback'] }))
    for (const bad of ['app1', '10.0.0.7', r.f.host.id]) expect(all).not.toContain(bad)
  })

  it('ctx actor overrides the constructor actor in rows and audit', async () => {
    const seen: { actor: unknown; action: string }[] = []
    const checked: unknown[] = []
    const access: DeployAccess = { check: async (actor) => (checked.push(actor), { allowed: true }) }
    let late!: Rig
    const r = await rig({ access, audit: { append: (input) => (seen.push({ actor: input.actor, action: input.action }), late.f.audit.append(input)) } })
    late = r
    const hub = { osUser: 'ada@example.com', machine: 'hub-1', hubUserId: 'oid-1' }
    const { releaseId } = await r.svc.preflight(
      { environmentId: r.f.staging.id, serviceIds: tracked(r, dep(r, 'api')).map((s) => s.id), bump: 'none', options: DEFAULT_RELEASE_OPTIONS },
      { actor: hub },
    )
    for (let i = 0; i < 200 && r.svc.detail(releaseId).status === 'preflight'; i++) await new Promise((res) => setImmediate(res))
    await r.svc.start(releaseId, {}, { actor: hub })
    await r.svc.whenIdle()
    expect(r.svc.list().find((x) => x.id === releaseId)?.triggeredBy).toBe('ada@example.com@hub-1')
    expect(r.runner.call('release').actor).toEqual(hub)
    expect(checked.every((a) => a === hub)).toBe(true)
    const mine = seen.filter((x) => ['release.preflight', 'release.start', 'release.finish'].includes(x.action))
    expect(mine.map((x) => x.action)).toEqual(['release.preflight', 'release.start', 'release.finish'])
    expect(mine.every((x) => x.actor === hub)).toBe(true)
    // Without a ctx the constructor's actor is still used.
    const id2 = await ready(r, [dep(r, 'web')])
    expect(r.svc.list().find((x) => x.id === id2)?.triggeredBy).toBe('tester@box')
  })
})

describe('parallel prepare', () => {
  const on = (r: Rig) => r.f.deploys.updateSettings(r.f.staging.id, { parallelPrepare: true })

  it('the release plan carries the prepare cap, and other plans none', async () => {
    const r = await rig()
    on(r)
    r.f.deploys.updateSettings(r.f.staging.id, { prepareCap: 5 })
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    expect(r.runner.call('release').prepare).toEqual({ cap: 5 })
    expect(r.runner.call('preflight').prepare).toBeNull()
    expect(r.runner.call('unlock').prepare).toBeNull()

    const off = await rig()
    const oid = await ready(off)
    await off.svc.start(oid, {})
    await off.svc.whenIdle()
    expect(off.runner.call('release').prepare).toBeNull()
    expect(off.runner.call('unlock').killBuilds).toBeUndefined()
  })

  it('a build that fails in prepare restarts nothing, rolls back nothing and says so', async () => {
    const r = await rig()
    on(r)
    const deps = [dep(r, 'one'), dep(r, 'two')]
    const id = await ready(r, deps)
    r.runner.on.release = (plan, _s, emit) => {
      const [r1, r2] = runIds(plan)
      emit({ type: 'step.started', stepId: `${r2}:build`, kind: 'build', name: 'Build two', hostId: r.f.host.id, deploymentRunId: r2 })
      emit({ type: 'step.failed', stepId: `${r2}:build`, error: 'compose build failed', durationMs: 1 })
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], reachedUp: [], commits: { [r1]: { previous: A }, [r2]: { previous: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    const svc = tracked(r, deps[1]).map((s) => s.name).join(', ')
    expect(d.error).toBe(PREPARE_FAILED_MESSAGE(svc, { checkout: 'left', env: false, others: { env: false } }))
    expect(d.error).toBe(`Build failed for ${svc}: no service was restarted; the checkout is left at the new commit; other checkouts are left at the new commit; running containers are unchanged.`)
    // every launched build is stopped by the unlock
    const plan = r.runner.call('release')
    expect(r.runner.call('unlock').killBuilds).toEqual(plan.deployments.map((x) => ({ runId: x.runId, repoPath: x.repoPath })))
  })

  /** A prepare where `two`'s build fails after its checkout, and its restore step ends as given. */
  const failedPrepare = async (o: { restore: 'ok' | 'first' | 'failed'; env?: boolean; alone?: boolean }) => {
    const r = await rig()
    on(r)
    const envOpts = { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` }
    const deps = o.alone ? [dep(r, 'two', o.env ? envOpts : {})] : [dep(r, 'one'), dep(r, 'two', o.env ? envOpts : {})]
    const id = await ready(r, deps)
    r.runner.on.release = (plan, _s, emit) => {
      const ids = runIds(plan)
      const r2 = ids.at(-1)!
      const host = r.f.host.id
      const step = (key: string, kind: StepKind, end: 'ok' | 'warn' | 'failed', message?: string) => {
        emit({ type: 'step.started', stepId: `${r2}:${key}`, kind, name: `${key} two`, hostId: host, deploymentRunId: r2 })
        if (end === 'failed') emit({ type: 'step.failed', stepId: `${r2}:${key}`, error: message ?? `${key} failed`, durationMs: 1 })
        else emit({ type: 'step.done', stepId: `${r2}:${key}`, state: end, durationMs: 1, ...(message ? { message } : {}) })
      }
      step('checkout', 'checkout', 'ok')
      if (o.env) step('env', 'env', 'ok')
      step('build', 'build', 'failed', 'compose build failed')
      if (o.restore === 'ok') step('restore', 'restore', 'ok')
      if (o.restore === 'first') step('restore', 'restore', 'warn', 'First deploy: there is no previous commit to go back to')
      if (o.restore === 'failed') step('restore', 'restore', 'failed', 'Restore checkout two failed: error: pathspec')
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: ids, reachedUp: [], commits: {} }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    return { error: r.svc.detail(id).error ?? '', svc: tracked(r, deps.at(-1)!).map((s) => s.name).join(', ') }
  }

  it('a build that fails in prepare puts its checkout back on the previous commit and says so', async () => {
    const { error, svc } = await failedPrepare({ restore: 'ok' })
    expect(error).toBe(`Build failed for ${svc}: no service was restarted; the checkout is back on the previous commit; other checkouts are left at the new commit; running containers are unchanged.`)
    // no managed .env: none is mentioned
    expect(error).not.toContain('.env')
    const alone = await failedPrepare({ restore: 'ok', alone: true })
    expect(alone.error).toBe(`Build failed for ${alone.svc}: no service was restarted; the checkout is back on the previous commit; running containers are unchanged.`)
  })

  it('with a managed .env the restore puts the previous .env back too', async () => {
    const { error } = await failedPrepare({ restore: 'ok', env: true, alone: true })
    expect(error).toContain('the checkout is back on the previous commit with the previous .env;')
  })

  it('a first deploy has no previous commit: its checkout is left and the message says why', async () => {
    const { error, svc } = await failedPrepare({ restore: 'first', env: true, alone: true })
    expect(error).toBe(
      `Build failed for ${svc}: no service was restarted; this was its first deploy, so the checkout is left at the new commit with the new .env; running containers are unchanged.`,
    )
  })

  it('a restore that fails says the checkout is still on the new commit', async () => {
    const { error, svc } = await failedPrepare({ restore: 'failed', alone: true })
    expect(error).toBe(
      `Build failed for ${svc}: no service was restarted; putting the checkout back on the previous commit failed, so it is still on the new commit; running containers are unchanged.`,
    )
  })

  it.each([
    ['nothing checked out', false],
    ['another checkout did', true],
  ] as const)('a fetch that fails in prepare says the server is unchanged (%s)', async (_n, other) => {
    const r = await rig()
    on(r)
    const deps = [dep(r, 'one'), dep(r, 'two')]
    const id = await ready(r, deps)
    r.runner.on.release = (plan, _s, emit) => {
      const [r1, r2] = runIds(plan)
      if (other) emit({ type: 'step.started', stepId: `${r1}:checkout`, kind: 'checkout', name: 'Checkout one', hostId: r.f.host.id, deploymentRunId: r1 })
      emit({ type: 'step.started', stepId: `${r2}:fetch`, kind: 'fetch', name: 'Fetch two', hostId: r.f.host.id, deploymentRunId: r2 })
      emit({ type: 'step.failed', stepId: `${r2}:fetch`, error: 'could not fetch', durationMs: 1 })
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: other ? [r1] : [], reachedUp: [], commits: {} }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const svc = tracked(r, deps[1]).map((s) => s.name).join(', ')
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    expect(d.error).toBe(PREPARE_FETCH_FAILED_MESSAGE(svc, other ? { env: false } : null))
    expect(d.error).toContain('still on the old commit')
    // no managed .env anywhere: none is mentioned
    expect(d.error).not.toContain('.env')
    if (!other) expect(d.error).not.toContain('new commit')
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
  })

  it('a checkout that fails in prepare keeps the build-failed text', async () => {
    const r = await rig()
    on(r)
    const deps = [dep(r, 'one')]
    const id = await ready(r, deps)
    r.runner.on.release = (plan, _s, emit) => {
      const [r1] = runIds(plan)
      emit({ type: 'step.started', stepId: `${r1}:checkout`, kind: 'checkout', name: 'Checkout one', hostId: r.f.host.id, deploymentRunId: r1 })
      emit({ type: 'step.failed', stepId: `${r1}:checkout`, error: 'dirty tree', durationMs: 1 })
      return { exitCode: 2, failedDeploymentRunIds: [r1], reachedCheckout: [r1], reachedUp: [], commits: { [r1]: { previous: A } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).error).toBe(PREPARE_FAILED_MESSAGE(tracked(r, deps[0]).map((s) => s.name).join(', '), { checkout: 'left', env: false, others: null }))
  })

  it('with auto-rollback off, a failure after up ends failed with nothing rolled back', async () => {
    const r = await rig()
    on(r)
    r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], reachedUp: [r1, r2], commits: { [r1]: { previous: A }, [r2]: { previous: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('failed')
    // something went up: the reason is the step's, not the prepare text
    expect(d.error ?? '').not.toContain('no service was restarted')
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    expect(r.runner.call('unlock').killBuilds).toHaveLength(2)
  })

  it('a vault reset mid-prepare cancels the release and the unlock still stops the builds', async () => {
    const r = await rig()
    on(r)
    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.release = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    await r.svc.start(id, {})
    r.svc.vaultReset()
    await r.svc.whenIdle()
    expect(r.runner.cancels).toHaveLength(1)
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'unlock'])
    expect(r.svc.detail(id).status).toBe('cancelled')
    expect(r.svc.hasActive()).toBe(false)
    const plan = r.runner.call('release')
    expect(r.runner.call('unlock').killBuilds).toEqual(plan.deployments.map((x) => ({ runId: x.runId, repoPath: x.repoPath })))
  })

  it('a vault reset during the auto-rollback after an up cancels it and still unlocks with the builds', async () => {
    const r = await rig()
    on(r)
    const id = await ready(r, [dep(r, 'one')])
    r.runner.on.release = (plan) => {
      const [r1] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r1], reachedCheckout: [r1], reachedUp: [r1], commits: { [r1]: { previous: A } } }
    }
    const g = gate()
    const rolling = gate()
    r.runner.onCancel = g.open
    r.runner.on.rollback = async () => {
      rolling.open()
      await g.p
      return { cancelled: true, exitCode: null }
    }
    await r.svc.start(id, {})
    await rolling.p
    r.svc.vaultReset()
    await r.svc.whenIdle()
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'rollback', 'unlock'])
    expect(r.svc.detail(id).status).not.toBe('running')
    expect(r.runner.call('unlock').killBuilds).toHaveLength(1)
  })

  it('after a service went up, a failure rolls back only the runs that went up', async () => {
    const r = await rig()
    on(r)
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    r.runner.on.release = (plan) => {
      const [r1, r2] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r2], reachedCheckout: [r1, r2], reachedUp: [r1], commits: { [r1]: { previous: A }, [r2]: { previous: B } } }
    }
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const [r1] = runIds(r.runner.call('release'))
    expect(runIds(r.runner.call('rollback'))).toEqual([r1])
    expect(r.svc.detail(id).status).toBe('rolled_back')
  })

  it('a cancel mid-build stops the launched builds before the lock goes', async () => {
    const r = await rig()
    on(r)
    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.release = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const id = await ready(r, [dep(r, 'one'), dep(r, 'two')])
    await r.svc.start(id, {})
    await r.svc.cancel(id)
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('cancelled')
    const plan = r.runner.call('release')
    expect(r.runner.call('unlock').killBuilds).toEqual(plan.deployments.map((x) => ({ runId: x.runId, repoPath: x.repoPath })))
  })

  it('preflight blocks two checkouts sharing a repo on a host on different branches', async () => {
    const r = await rig()
    on(r)
    const one = dep(r, 'one')
    const two = dep(r, 'two', { repoPath: '/srv/one', defaultBranch: 'next' })
    const id = await ready(r, [one, two])
    const d = r.svc.detail(id)
    expect(d.status).toBe('blocked')
    expect(d.preflight?.checks.find((c) => c.id === 'shared-repo')).toMatchObject({ level: 'block', label: 'shared repo', hostId: r.f.host.id })
    expect(d.preflight?.checks.find((c) => c.id === 'shared-repo')!.message).toContain('turn off parallel prepare')
    // the same branch shares the checkout and is fine; with parallel prepare off nothing is checked
    const same = await rig()
    on(same)
    const sid = await ready(same, [dep(same, 'one'), dep(same, 'two', { repoPath: '/srv/one' })])
    expect(same.svc.detail(sid).preflight?.checks.some((c) => c.id === 'shared-repo')).toBe(false)
    const off = await rig()
    const oid = await ready(off, [dep(off, 'one'), dep(off, 'two', { repoPath: '/srv/one', defaultBranch: 'next' })])
    expect(off.svc.detail(oid).preflight?.checks.some((c) => c.id === 'shared-repo')).toBe(false)
  })
})

describe('ReleaseService operations', () => {
  const PARAM = 'blue-green-77'
  const shell = (id: string, name: string, script: string) => ({
    type: 'step' as const,
    step: { id, name, run: 'shell' as const, service: null, script, cwd: null, sudo: 'docker' as const, timeoutSec: 60, onFailure: 'stop' as const, when: { kind: 'always' as const }, secrets: [] },
  })
  const bounce = (r: Rig, serviceIds: string[], over: Parameters<typeof runbook>[2] = {}) =>
    runbook(r, serviceIds, {
      items: [{ type: 'builtin', builtin: 'restart' }, shell('warm', 'warm-cache', 'echo "$OD_PARAM_TARGET"'), { type: 'builtin', builtin: 'logs', tail: 50 }],
      params: [{ name: 'target', label: 'Target', type: 'text', pattern: 'identifier', choices: [] }],
      ...over,
    })
  const logsOnly = (r: Rig, serviceIds: string[], lock: boolean) => runbook(r, serviceIds, { name: lock ? 'Logs locked' : 'Logs', items: [{ type: 'builtin', builtin: 'logs', tail: 20 }], lock })

  it('preflights, previews and runs an operation that shares the release history without deploying anything', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { versioned: true, currentVersion: 'v1.4.0' })
    const d = dep(r, 'api')
    const [svcA] = tracked(r, d)
    const rb = bounce(r, [svcA.id])
    const id = await opReady(r, rb, { target: PARAM })
    const ready1 = r.svc.detail(id)
    expect(ready1.status).toBe('ready')
    expect(ready1.version).toBeNull()
    expect(ready1.operation).toEqual({ runbookId: rb.id, name: 'Bounce', params: { target: PARAM }, readOnly: false, lock: true, targetServiceIds: [svcA.id] })
    expect(ready1.runs).toHaveLength(1)
    expect(ready1.runs[0].steps.map((x) => [x.key, x.kind, x.label])).toEqual([
      ['op_restart', 'op', 'Restart'],
      ['c_1', 'custom', 'warm-cache'],
      ['op_logs', 'op', 'Logs'],
    ])
    expect(audits(r, 'ops.preflight')).toHaveLength(1)

    const preview = await r.svc.previewPlaybook(id)
    expect(preview.playbook).toContain('op_restart')
    expect(preview.playbook).not.toContain(PARAM)
    await r.svc.start(id, { playbookSha256: preview.sha256 })
    await r.svc.whenIdle()
    const done = r.svc.detail(id)
    expect(done.status).toBe('succeeded')
    expect(done.runs.map((x) => x.status)).toEqual(['succeeded'])
    expect(r.runner.kinds).toEqual(['preflight', 'operation', 'unlock'])
    const plan = r.runner.call('operation')
    expect(plan.operation).toMatchObject({ runbookId: rb.id, name: 'Bounce', lock: true, targets: [{ runId: done.runs[0].id, services: [svcA.composeService] }] })
    expect(plan.operation!.items.map((i) => (i.type === 'step' ? i.step.key : i.builtin))).toEqual(['restart', 'c_1', 'logs'])
    const step = plan.operation!.items[1] as { type: 'step'; step: DeployPlan['deployments'][number]['steps'][number] }
    expect(step.step.paramKeys).toEqual([{ envName: 'OD_PARAM_TARGET', valueB64: Buffer.from(PARAM).toString('base64') }])
    // Nothing about the operation is a deploy: no tag, no finalize, no recorded commit.
    expect(r.svc.events(id, 0).some((e) => 'stepId' in e && String(e.stepId).startsWith('release:finalize'))).toBe(false)
    expect(r.f.deploys.settings(r.f.staging.id).currentVersion).toBe('v1.4.0')
    expect(r.f.services.list(r.f.staging.id).find((x) => x.id === svcA.id)).toMatchObject({ lastReleaseId: null })
    expect(r.svc.list({ operations: 'only' }).map((x) => x.id)).toEqual([id])
    expect(r.svc.list({ operations: 'exclude' }).map((x) => x.id)).not.toContain(id)
  })

  it('an operation is never rolled back, tag-retried or an environment\'s latest release', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const rel = await ready(r, [d])
    await r.svc.start(rel, {})
    await r.svc.whenIdle()
    const ok = await opReady(r, runbook(r, tracked(r, d).map((x) => x.id)))
    await r.svc.start(ok, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(ok).status).toBe('succeeded')
    r.runner.on.operation = () => ({ exitCode: 2 })
    const bad = await opReady(r, runbook(r, tracked(r, d).map((x) => x.id), { name: 'Bounce 2' }))
    await r.svc.start(bad, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(bad).status).toBe('failed')
    expect(r.svc.detail(bad).runs.map((x) => x.status)).toEqual(['failed'])
    // A failed operation is not rolled back on its own either.
    expect(r.runner.kinds).not.toContain('rollback')
    for (const id of [ok, bad]) {
      await expect(r.svc.rollback(id, {})).rejects.toThrow(/operation/i)
      await expect(r.svc.retryVersion(id)).rejects.toThrow(/operation/i)
    }
    expect(r.svc.latestPerEnvironment().find((x) => x.environmentId === r.f.staging.id)?.id).toBe(rel)
  })

  it('a lock-free read-only operation runs beside a release on its environment; one that locks is refused BUSY', async () => {
    const r = await rig()
    const g = gate()
    r.runner.on.release = async () => {
      await g.p
    }
    const d = dep(r, 'api')
    const ids = tracked(r, d).map((x) => x.id)
    const rel = await ready(r, [d])
    await r.svc.start(rel, {})
    const free = await opReady(r, logsOnly(r, ids, false))
    expect(r.svc.detail(free).operation).toMatchObject({ readOnly: true, lock: false })
    await r.svc.start(free, {})
    for (const rb of [logsOnly(r, ids, true), runbook(r, ids, { name: 'Restart' })]) {
      const locking = await opReady(r, rb)
      const err = await r.svc.start(locking, {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('BUSY')
    }
    g.open()
    await r.svc.whenIdle()
    expect(r.svc.detail(free).status).toBe('succeeded')
    expect(r.svc.detail(rel).status).toBe('succeeded')
    // A lock-free run still removes its run directory, and an operation's unlock never stops builds.
    const unlocks = r.runner.calls.filter((c) => c.plan.kind === 'unlock').map((c) => c.plan)
    expect(unlocks.map((p) => p.releaseId).sort()).toEqual([free, rel].sort())
    expect(unlocks.find((p) => p.releaseId === free)?.killBuilds).toBeUndefined()
  })

  it('an operation unlocks after it fails and after it is cancelled, and its unlock never stops builds', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const ids = tracked(r, d).map((x) => x.id)
    r.runner.on.operation = () => ({ exitCode: 2 })
    const bad = await opReady(r, runbook(r, ids))
    await r.svc.start(bad, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(bad).status).toBe('failed')
    expect(r.runner.kinds.slice(-2)).toEqual(['operation', 'unlock'])
    const g = gate()
    r.runner.onCancel = g.open
    r.runner.on.operation = async () => {
      await g.p
      return { cancelled: true, exitCode: null }
    }
    const stopped = await opReady(r, runbook(r, ids, { name: 'Bounce 2' }))
    await r.svc.start(stopped, {})
    await r.svc.cancel(stopped)
    await r.svc.whenIdle()
    expect(r.svc.detail(stopped).status).toBe('cancelled')
    expect(r.runner.kinds.slice(-2)).toEqual(['operation', 'unlock'])
    expect(r.svc.hasActive()).toBe(false)
    const unlocks = r.runner.calls.filter((c) => c.plan.kind === 'unlock').map((c) => c.plan)
    expect(unlocks.map((p) => p.releaseId)).toEqual([bad, stopped])
    for (const p of unlocks) {
      expect(p).not.toHaveProperty('killBuilds')
      expect(generatePlaybook(p)).not.toMatch(/kill_pids|kill -/)
    }
    // The same unlock with builds to stop does carry the kill, so the check above is not vacuous.
    const withKill = { ...unlocks[0], killBuilds: [{ runId: unlocks[0].deployments[0]?.runId ?? 'r', repoPath: '/srv/api' }] }
    expect(generatePlaybook(withKill as DeployPlan)).toMatch(/kill_pids/)
  })

  it('an operation on a protected environment needs the typed name, audited as ops.run', async () => {
    const r = await rig()
    r.f.envs.putHost(r.f.prod.id, r.f.host.id, 'app')
    const d = dep(r, 'api', { environmentId: r.f.prod.id, deployTag: 'deploy_prod' })
    const rb = runbook(r, tracked(r, d).map((x) => x.id), { environmentId: r.f.prod.id })
    const id = await opReady(r, rb)
    const err = await r.svc.start(id, {}).catch((e: unknown) => e)
    expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    expect(audits(r, 'ops.run').map((e) => e.outcome)).toEqual(['denied'])
    expect(audits(r, 'ops.run')[0].details).toMatchObject({ reason: 'confirm', name: rb.name, serviceCount: rb.targetServiceIds.length })
    expect(r.runner.kinds).toEqual(['preflight'])
    await r.svc.start(id, { typedName: 'prod' })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it('audits names, counts and outcome only: no host, address, script or param value anywhere', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const rb = bounce(r, tracked(r, d).map((x) => x.id))
    r.runner.on.operation = (_p, s, emit) => {
      expect(s.known).toContain(PARAM)
      emit({ type: 'log', stepId: null, hostId: null, stream: 'out', line: `restarting for ${PARAM}` })
    }
    const id = await opReady(r, rb, { target: PARAM })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const pre = audits(r, 'ops.preflight')
    expect(pre[0].details).toMatchObject({ name: 'Bounce', serviceCount: 1, deploymentCount: 1, hostCount: 1 })
    const runs = audits(r, 'ops.run')
    expect(runs.map((e) => [e.outcome, (e.details as { outcome: string }).outcome]).sort()).toEqual([
      ['success', 'started'],
      ['success', 'succeeded'],
    ])
    for (const e of runs) expect(e.details).toMatchObject({ name: 'Bounce', serviceCount: 1 })
    expect(audits(r, 'release.start')).toEqual([])
    expect(audits(r, 'release.finish')).toEqual([])
    const all = JSON.stringify([...pre, ...runs])
    for (const leak of [PARAM, 'app1', '10.0.0.7', 'OD_PARAM_TARGET', '/srv/api']) expect(all).not.toContain(leak)
    expect(JSON.stringify(r.svc.events(id, 0))).not.toContain(PARAM)
  })

  it('preflightOperation refuses a service the runbook does not target, a bad param and another environment', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const other = dep(r, 'web')
    const rb = bounce(r, tracked(r, d).map((x) => x.id))
    const base = { environmentId: r.f.staging.id, runbookId: rb.id, serviceIds: rb.targetServiceIds, params: { target: 'ok' } }
    const code = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DeployError).code)
    expect(await code(r.svc.preflightOperation({ ...base, serviceIds: tracked(r, other).map((x) => x.id) }))).toBe('VALIDATION')
    expect(await code(r.svc.preflightOperation({ ...base, serviceIds: [] }))).toBe('VALIDATION')
    expect(await code(r.svc.preflightOperation({ ...base, params: { target: 'no spaces' } }))).toBe('VALIDATION')
    expect(await code(r.svc.preflightOperation({ ...base, params: {} }))).toBe('VALIDATION')
    // Services from another environment fail the selection, as a release preflight's do, before the runbook is read.
    expect(await code(r.svc.preflightOperation({ ...base, environmentId: r.f.prod.id }))).toBe('INVALID_STATE')
    expect(r.runner.kinds).toEqual([])
  })

  it('preflightOperation checks access before it reads the runbook: a denied caller learns nothing about it', async () => {
    const r = await rig({ access: { check: async (_a, action) => (action === 'ops.run' ? { allowed: false, reason: 'no' } : { allowed: true }) } })
    const d = dep(r, 'api')
    const rb = bounce(r, tracked(r, d).map((x) => x.id))
    const base = { environmentId: r.f.staging.id, runbookId: rb.id, serviceIds: rb.targetServiceIds, params: { target: 'ok' } }
    const code = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DeployError).code)
    for (const req of [base, { ...base, runbookId: '00000000-0000-4000-8000-000000000000' }, { ...base, params: { target: 'no spaces' } }, { ...base, params: {} }]) {
      expect(await code(r.svc.preflightOperation(req))).toBe('DENIED')
    }
    const denied = audits(r, 'ops.preflight')
    expect(denied.map((e) => e.outcome)).toEqual(['denied', 'denied', 'denied', 'denied'])
    expect(JSON.stringify(denied)).not.toContain(rb.name)
    expect(r.runner.kinds).toEqual([])
  })

  it('an operation preflight blocks on what it needs only', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const rb = runbook(r, tracked(r, d).map((x) => x.id))
    const chk = (id: string): PreflightCheck => ({ id, deploymentId: d.id, hostId: r.f.host.id, label: id, level: 'block', message: `${id} failed` })
    r.runner.checks = [chk('clean'), chk('commits'), chk('version-tag')]
    const okId = await opReady(r, rb)
    expect(r.svc.detail(okId).status).toBe('ready')
    expect(r.svc.detail(okId).preflight?.checks.filter((c) => ['clean', 'commits', 'version-tag'].includes(c.id)).map((c) => c.level)).toEqual(['warn', 'warn', 'warn'])
    r.runner.checks = [chk('reachable')]
    expect(r.svc.detail(await opReady(r, rb)).status).toBe('blocked')
  })
})
