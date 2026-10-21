import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { NOTHING_SELECTED_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, STEP_SECRET_UNUSED_MESSAGE } from '../../src/main/deploy/release-service'
import { REDEPLOY_CONFIRM_MESSAGE } from '../../src/shared/deploy'
import type { DeployPlan } from '../../src/main/deploy/runner'
import type { CommitInfo, DeploymentMeta } from '../../src/shared/deploy'
import type { AppServiceMeta } from '../../src/shared/services'
import type { Step } from '../../src/shared/steps'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { A, B, C, SECRET, dep, ready, rig, type Rig } from './release-rig'

/* Task 5: a release runs each checkout's custom steps (or its migrated hooks) with their secrets, and skips
   services that have not changed since they were last deployed. */

const E = 'e'.repeat(40)
const audits = (r: Rig, action: string) => r.f.audit.list({ actions: [action as never] })
const fail = async (p: Promise<unknown>): Promise<DeployError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(DeployError)
  return e as DeployError
}
const step = (over: Partial<Step> = {}): Step => ({
  id: 'migrate',
  name: 'migrate',
  run: 'shell',
  service: null,
  script: 'echo migrating',
  cwd: null,
  sudo: 'docker',
  timeoutSec: 120,
  onFailure: 'stop',
  when: { kind: 'always' },
  secrets: [],
  anchor: 'after_up',
  alsoOnRollback: false,
  ...over,
})
const svcIn = (r: Rig, d: DeploymentMeta, name: string, over: { skipUnchanged?: boolean } = {}) =>
  r.f.services.create({ kind: 'service', environmentId: d.environmentId, name, deploymentId: d.id, ...over }) as AppServiceMeta
const ci = (sha: string, deploymentId: string): CommitInfo => ({ sha, subject: `s ${sha[0]}`, author: 'dev', date: '2026-10-18T00:00:00Z', deploymentId })
/** Preflight reports these commits (newest first) and tag commit per checkout. */
const commits = (r: Rig, byDep: Record<string, { list: string[]; tag?: string }>) => {
  r.runner.on.preflight = (plan: DeployPlan) => {
    const total = plan.deployments.reduce((n, d) => n + (byDep[d.deploymentId]?.list.length ?? 0), 0)
    return {
      preflight: {
        checks: [],
        commits: Object.fromEntries(
          plan.deployments.map((d) => {
            const x = byDep[d.deploymentId] ?? { list: [] }
            return [d.deploymentId, { commits: x.list.map((s) => ci(s, d.deploymentId)), hiddenPairs: 0, truncated: 0, firstDeploy: false, head: x.list[0] ?? null, tagCommit: x.tag ?? null }]
          }),
        ),
        dockerModes: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, 'plain' as const])),
        composeServices: {},
        locks: {},
        commitsTotal: total,
        blocked: false,
      },
    }
  }
}

describe('release custom steps', () => {
  it('migrated hooks are c_0 and c_1 in the old slots, the preview hash is stable, and the plan carries steps, not hooks', async () => {
    const r = await rig()
    const d = dep(r, 'api', { preHook: 'echo hi', postHook: 'echo bye', urls: [{ url: 'http://x/health', from: 'mac' }] } as never)
    const id = await ready(r, [d])
    const run = r.svc.detail(id).runs[0]
    expect(run.steps.map((s) => [s.key, s.kind])).toEqual([
      ['record', 'record'],
      ['fetch', 'fetch'],
      ['checkout', 'checkout'],
      ['c_0', 'custom'],
      ['build', 'build'],
      ['up', 'up'],
      ['health', 'health'],
      ['c_1', 'custom'],
      ['tag', 'tag'],
    ])
    expect(run.steps.every((s) => s.stepId === `${run.id}:${s.key}` && s.state === 'pending')).toBe(true)
    expect(run.steps.filter((s) => s.kind === 'custom').map((s) => s.label)).toEqual(['pre-hook', 'post-hook'])

    const a = await r.svc.previewPlaybook(id)
    const b = await r.svc.previewPlaybook(id)
    expect(b.sha256).toBe(a.sha256)
    expect(a.skippedServiceIds).toEqual([])
    r.runner.on.release = (_p, _s, emit) => {
      emit({ type: 'step.started', stepId: `${run.id}:c_0`, kind: 'custom', name: 'pre-hook', hostId: null, deploymentRunId: run.id })
      emit({ type: 'step.done', stepId: `${run.id}:c_0`, state: 'ok', durationMs: 3 })
    }
    await r.svc.start(id, { playbookSha256: a.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    const plan = r.runner.call('release')
    expect(plan.deployments[0]).toMatchObject({ preHookB64: null, postHookB64: null })
    expect(plan.deployments[0].steps.map((s) => [s.key, s.label, s.anchor])).toEqual([
      ['c_0', 'pre-hook', 'before_build'],
      ['c_1', 'post-hook', 'after_health'],
    ])
    // a step event keeps the row's label and key
    expect(r.svc.detail(id).runs[0].steps.find((s) => s.key === 'c_0')).toMatchObject({ state: 'ok', label: 'pre-hook', kind: 'custom' })
  })

  it("a step secret one of the environment's env templates uses reaches the runner by reference only", async () => {
    const r = await rig()
    // the env template is another checkout's: the environment already uses the secret
    dep(r, 'web', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const d = dep(r, 'api', { vaultIds: [DEFAULT_VAULT_ID], steps: [step({ secrets: [{ envName: 'API_TOKEN', secretId: r.f.secretId }] })] })
    const id = await ready(r, [d])
    const p = await r.svc.previewPlaybook(id)
    expect(p.playbook).not.toContain(SECRET)
    expect(p.playbook).not.toContain(Buffer.from(SECRET).toString('base64'))
    expect(r.valueCalls).toEqual([])
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    const call = r.runner.calls.find((c) => c.plan.kind === 'release')!
    const [s] = call.plan.deployments[0].steps
    expect(s.secretKeys.map((x) => x.envName)).toEqual(['API_TOKEN'])
    const key = s.secretKeys[0].key
    expect(call.plan.secretRefs[key]).toEqual({ secretId: r.f.secretId })
    expect(call.seen.values[key]).toBe(SECRET)
    expect(call.seen.known).toContain(SECRET)
    const details = JSON.stringify(audits(r, 'release.start')[0].details)
    for (const x of [SECRET, 'migrat', 'API_TOKEN', 'echo']) expect(details).not.toContain(x)
  })

  it('a step secret the environment does not already use is refused, and the refusal names no value', async () => {
    const r = await rig()
    const d = dep(r, 'api', { vaultIds: [DEFAULT_VAULT_ID], steps: [step({ secrets: [{ envName: 'API_TOKEN', secretId: r.f.secretId }] })] })
    const id = await ready(r, [d])
    for (const e of [await fail(r.svc.previewPlaybook(id)), await fail(r.svc.start(id, {}))]) {
      expect(e.message).toBe(STEP_SECRET_UNUSED_MESSAGE)
      expect(e.message).not.toContain(SECRET)
      expect(e.message).not.toContain(r.f.secretId)
    }
    expect(STEP_SECRET_UNUSED_MESSAGE).toBe('This step uses a secret the environment does not already use')
    expect(r.valueCalls).toEqual([])
    expect(r.svc.detail(id).status).toBe('ready')
    expect(audits(r, 'release.start')).toHaveLength(0)
  })

  it('a rollback runs only the steps that set alsoOnRollback, keeping their keys', async () => {
    const r = await rig()
    const d = dep(r, 'api', { steps: [step(), step({ id: 'warm', name: 'warm', alsoOnRollback: true })] })
    const id = await ready(r, [d])
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(plan.deployments.map((x) => [x.runId, { previous: A, deployed: B }])) })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    const { releaseId } = await r.svc.rollback(id, {})
    await r.svc.whenIdle()
    const plan = r.runner.call('rollback')
    expect(plan.deployments[0].steps.map((s) => [s.key, s.label])).toEqual([['c_1', 'warm']])
    const steps = r.svc.detail(releaseId).runs[0].steps
    expect(steps.map((s) => s.key)).toEqual(['rb_checkout', 'rb_build', 'rb_up', 'c_1', 'rb_tag'])
  })
})

describe('skip unchanged', () => {
  /** shop (web, worker): web was deployed at A, worker at C; origin has C and B since A. */
  const shop = async (o: { skip: boolean; worker?: string }) => {
    const r = await rig()
    const d = dep(r, 'shop')
    const web = svcIn(r, d, 'web')
    const worker = svcIn(r, d, 'worker', { skipUnchanged: o.skip })
    r.f.services.recordDeployed([
      { serviceId: web.id, commit: A, releaseId: null },
      { serviceId: worker.id, commit: o.worker ?? C, releaseId: null },
    ])
    commits(r, { [d.id]: { list: [C, B] } })
    const id = await ready(r, [d])
    return { r, d, web, worker, id }
  }

  it('a known zero-commit service is skipped and reported; forcing it brings it back; the hash binds the skips', async () => {
    const { r, web, worker, id } = await shop({ skip: true })
    expect(r.svc.detail(id).preflight?.serviceCommits[worker.id]).toEqual({ since: C, count: 0, known: true, skippable: true })
    expect(r.svc.detail(id).preflight?.serviceCommits[web.id]).toMatchObject({ skippable: false })
    const p = await r.svc.previewPlaybook(id)
    expect(p.skippedServiceIds).toEqual([worker.id])
    const forced = await r.svc.previewPlaybook(id, undefined, [worker.id])
    expect(forced.skippedServiceIds).toEqual([])
    expect(forced.sha256).not.toBe(p.sha256)
    expect((await fail(r.svc.start(id, { playbookSha256: p.sha256, forceServiceIds: [worker.id] }))).message).toBe(PLAYBOOK_CHANGED_MESSAGE)

    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    expect(r.runner.call('release').deployments[0].services).toEqual(['web'])
    const run = r.svc.detail(id).runs[0]
    expect(run.services.map((e) => e.id)).toEqual([web.id])
    expect(run.wholeCheckout).toBe(false)
    expect(audits(r, 'release.start')[0].details).toMatchObject({ skippedServiceIds: [worker.id], serviceCount: 1 })
    // the skipped service was not deployed: its last commit stays
    expect((r.f.services.get(worker.id) as AppServiceMeta).lastDeployedCommit).toBe(C)
  })

  it('a forced service deploys with its checkout', async () => {
    const { r, worker, id } = await shop({ skip: true })
    const p = await r.svc.previewPlaybook(id, undefined, [worker.id])
    await r.svc.start(id, { playbookSha256: p.sha256, forceServiceIds: [worker.id] })
    await r.svc.whenIdle()
    expect(r.runner.call('release').deployments[0].services).toBeNull()
    expect(r.svc.detail(id).runs[0].wholeCheckout).toBe(true)
  })

  it('an unknown count is never skipped, nor is a service without skipUnchanged', async () => {
    for (const o of [{ skip: true, worker: E }, { skip: false }]) {
      const { r, worker, id } = await shop(o)
      expect(r.svc.detail(id).preflight?.serviceCommits[worker.id]?.skippable).toBe(false)
      expect((await r.svc.previewPlaybook(id)).skippedServiceIds).toEqual([])
    }
  })

  it('forcing a service the release does not run is refused', async () => {
    const { r, id } = await shop({ skip: true })
    const e = await fail(r.svc.previewPlaybook(id, undefined, ['not-a-service']))
    expect(e.code).toBe('VALIDATION')
    expect((await fail(r.svc.start(id, { forceServiceIds: ['not-a-service'] }))).code).toBe('VALIDATION')
  })

  it('a checkout whose every service is skipped has its run marked skipped and left out of the plan', async () => {
    const r = await rig()
    const shopDep = dep(r, 'shop')
    const billing = dep(r, 'billing')
    const web = svcIn(r, shopDep, 'web')
    const pay = svcIn(r, billing, 'pay', { skipUnchanged: true })
    r.f.services.recordDeployed([{ serviceId: pay.id, commit: C, releaseId: null }])
    commits(r, { [shopDep.id]: { list: [B] }, [billing.id]: { list: [C, B] } })
    const id = await ready(r, [shopDep, billing], { serviceIds: [web.id, pay.id] })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.runner.call('release').deployments.map((x) => x.name)).toEqual(['shop'])
    const runs = r.svc.detail(id).runs
    expect(runs.map((x) => [x.deploymentName, x.status])).toEqual([
      ['shop', 'succeeded'],
      ['billing', 'skipped'],
    ])
    expect(runs[1].steps.every((s) => s.state === 'skipped')).toBe(true)
    expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it('when every service is skipped, start refuses with NOTHING_SELECTED before the redeploy confirm', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const api = svcIn(r, d, 'api', { skipUnchanged: true })
    r.f.services.recordDeployed([{ serviceId: api.id, commit: C, releaseId: null }])
    // nothing since the tag, which is the service's own commit: zero commits, known
    commits(r, { [d.id]: { list: [], tag: C } })
    const id = await ready(r, [d])
    expect(r.svc.detail(id).preflight?.commitsTotal).toBe(0)
    expect(r.svc.detail(id).preflight?.serviceCommits[api.id]).toEqual({ since: C, count: 0, known: true, skippable: true })
    for (const e of [await fail(r.svc.start(id, {})), await fail(r.svc.previewPlaybook(id))]) {
      expect(e.message).toBe(NOTHING_SELECTED_MESSAGE)
      expect(e.code).toBe('INVALID_STATE')
    }
    expect(NOTHING_SELECTED_MESSAGE).toBe('Every selected service has no changes; select one to deploy it anyway')
    // forced, it is a plain redeploy again
    const e = await fail(r.svc.start(id, { forceServiceIds: [api.id] }))
    expect([e.code, e.message]).toEqual(['CONFIRM_REQUIRED', REDEPLOY_CONFIRM_MESSAGE])
    await r.svc.start(id, { forceServiceIds: [api.id], redeploy: true })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it('an empty list counts as zero only when the service is at the tag commit', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const api = svcIn(r, d, 'api', { skipUnchanged: true })
    r.f.services.recordDeployed([{ serviceId: api.id, commit: B, releaseId: null }])
    commits(r, { [d.id]: { list: [], tag: C } })
    const id = await ready(r, [d])
    expect(r.svc.detail(id).preflight?.serviceCommits[api.id]).toEqual({ since: B, count: 0, known: false, skippable: false })
  })
})
