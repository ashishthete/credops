import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { NOTHING_SELECTED_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, STEP_SECRET_UNUSED_MESSAGE } from '../../src/main/deploy/release-service'
import { REDEPLOY_CONFIRM_MESSAGE } from '../../src/shared/deploy'
import { stepList } from '../../src/main/deploy/generate'
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
/** Preflight reports these commits (newest first), tag commit and origin head per checkout. */
const commits = (r: Rig, byDep: Record<string, { list: string[]; tag?: string; head?: string | null; hiddenPairs?: number; truncated?: number; firstDeploy?: boolean }>) => {
  r.runner.on.preflight = (plan: DeployPlan) => {
    const total = plan.deployments.reduce((n, d) => n + (byDep[d.deploymentId]?.list.length ?? 0), 0)
    return {
      preflight: {
        checks: [],
        commits: Object.fromEntries(
          plan.deployments.map((d) => {
            const x = byDep[d.deploymentId] ?? { list: [] }
            return [
              d.deploymentId,
              {
                commits: x.list.map((s) => ci(s, d.deploymentId)),
                hiddenPairs: x.hiddenPairs ?? 0,
                truncated: x.truncated ?? 0,
                firstDeploy: x.firstDeploy ?? false,
                head: x.list[0] ?? null,
                tagCommit: x.tag ?? null,
                ...(x.head === undefined ? {} : { originHead: x.head }),
              },
            ]
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

  it('a rollback refused for a step secret the environment stopped using leaves no rollback row', async () => {
    const r = await rig()
    const tmpl = dep(r, 'env', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const d = dep(r, 'api', { vaultIds: [DEFAULT_VAULT_ID], steps: [step({ alsoOnRollback: true, secrets: [{ envName: 'API_TOKEN', secretId: r.f.secretId }] })] })
    const id = await ready(r, [d])
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(plan.deployments.map((x) => [x.runId, { previous: A, deployed: B }])) })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    r.f.deploys.update(tmpl.id, { envTemplate: 'MODE=plain' })
    const releases = r.svc.list().length
    expect((await fail(r.svc.rollback(id, {}))).message).toBe(STEP_SECRET_UNUSED_MESSAGE)
    expect(r.svc.list()).toHaveLength(releases)
    expect(r.runner.calls.filter((c) => c.plan.kind === 'rollback')).toHaveLength(0)
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
    commits(r, { [d.id]: { list: [C, B], head: C } })
    const id = await ready(r, [d])
    return { r, d, web, worker, id }
  }

  it('a start refused after the skips are known (a secret that fails to decrypt) writes none of them', async () => {
    const r = await rig()
    const d = dep(r, 'shop', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const web = svcIn(r, d, 'web')
    const worker = svcIn(r, d, 'worker', { skipUnchanged: true })
    r.f.services.recordDeployed([
      { serviceId: web.id, commit: A, releaseId: null },
      { serviceId: worker.id, commit: C, releaseId: null },
    ])
    commits(r, { [d.id]: { list: [C, B], head: C } })
    const id = await ready(r, [d])
    const shape = () => r.svc.detail(id).runs.map((x) => [x.status, x.wholeCheckout, x.services.map((e) => e.id).sort(), x.steps.map((st) => st.state)])
    const before = shape()
    r.failValue.on = true
    await expect(r.svc.start(id, {})).rejects.toThrow()
    expect(r.svc.detail(id).status).toBe('ready')
    expect(shape()).toEqual(before)
    expect(before[0][2]).toEqual([web.id, worker.id].sort())
    // a forced retry deploys the whole checkout, worker with it
    r.failValue.on = false
    await r.svc.start(id, { forceServiceIds: [worker.id] })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    expect(r.runner.call('release').deployments[0].services).toBeNull()
  })

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

  it('the hash binds the skip set itself: the same playbook text with a different skip set does not match', async () => {
    const { r, worker, id } = await shop({ skip: true })
    const p1 = await r.svc.previewPlaybook(id)
    expect(p1.skippedServiceIds).toEqual([worker.id])
    // The same skipped service, recorded at another commit: the plan (which leaves worker out) is unchanged.
    // (run_events is append-only: a later preflight.done carries the changed report)
    const row = r.f.db.prepare("SELECT payload FROM run_events WHERE release_id = ? AND type = 'preflight.done' ORDER BY seq DESC LIMIT 1").get(id) as { payload: string }
    const ev = JSON.parse(row.payload)
    ev.report.serviceCommits[worker.id] = { ...ev.report.serviceCommits[worker.id], since: E }
    const { s } = r.f.db.prepare('SELECT MAX(seq) AS s FROM run_events WHERE release_id = ?').get(id) as { s: number }
    r.f.db
      .prepare("INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES (?, ?, ?, ?, 'preflight.done', ?)")
      .run(`ev-${s + 1}`, id, s + 1, '2026-10-18T00:00:00Z', JSON.stringify(ev))
    expect(r.svc.detail(id).preflight?.serviceCommits[worker.id]).toMatchObject({ since: E, skippable: true })
    const p2 = await r.svc.previewPlaybook(id)
    expect(p2.skippedServiceIds).toEqual([worker.id])
    expect(p2.playbook).toBe(p1.playbook)
    expect(p2.sha256).not.toBe(p1.sha256)
    expect((await fail(r.svc.start(id, { playbookSha256: p1.sha256 }))).message).toBe(PLAYBOOK_CHANGED_MESSAGE)
    expect(r.svc.detail(id).status).toBe('ready')
    await r.svc.start(id, { playbookSha256: p2.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
  })

  it("a checkout with skips is held to the origin head its preflight saw; one without skips is not", async () => {
    const { r, worker, id } = await shop({ skip: true })
    const p = await r.svc.previewPlaybook(id)
    expect(p.playbook).toContain('origin check ')
    expect(p.playbook).toContain(`"origin_head": "${C}"`)
    const forced = await r.svc.previewPlaybook(id, undefined, [worker.id])
    expect(forced.playbook).not.toContain('origin check ')
    expect(forced.playbook).not.toContain('origin_head')
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.runner.call('release').deployments[0].expectOriginHead).toBe(C)
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
    commits(r, { [shopDep.id]: { list: [B], head: B }, [billing.id]: { list: [C, B], head: C } })
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
    // nothing since the tag, which is the service's own commit and origin's head: zero commits, known
    commits(r, { [d.id]: { list: [], tag: C, head: C } })
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

  /** api (skipUnchanged) last deployed at `at`; preflight reports `c`. */
  const one = async (at: string, c: Parameters<typeof commits>[1][string]) => {
    const r = await rig()
    const d = dep(r, 'api')
    const api = svcIn(r, d, 'api', { skipUnchanged: true })
    r.f.services.recordDeployed([{ serviceId: api.id, commit: at, releaseId: null }])
    commits(r, { [d.id]: c })
    const id = await ready(r, [d])
    return r.svc.detail(id).preflight?.serviceCommits[api.id]
  }

  it('first in a date-ordered list is not unchanged: a merged branch older than the service is a change', async () => {
    // A-B-C on main, F branched from B (dated before C) merged after C as M: `git log --no-merges` lists C F B
    const M = 'a1'.repeat(20)
    const F = 'f'.repeat(40)
    expect(await one(C, { list: [C, F, B], head: M })).toMatchObject({ skippable: false })
    // at origin's head it is unchanged
    expect(await one(M, { list: [C, F, B], head: M })).toEqual({ since: M, count: 0, known: true, skippable: true })
  })

  it('origin moved back to an ancestor of the tag (force-push or reset) is a change', async () => {
    // tag at C, origin reset to A: C..origin is empty, but the checkout would go back to A
    expect(await one(C, { list: [], tag: C, head: A })).toEqual({ since: C, count: 0, known: false, skippable: false })
  })

  it('a hidden revert pair, a cut list or a first deploy is never unchanged', async () => {
    for (const x of [{ hiddenPairs: 1 }, { truncated: 1 }, { firstDeploy: true }]) {
      expect(await one(C, { list: [], tag: C, head: C, ...x })).toMatchObject({ skippable: false })
    }
  })

  it('a missing origin head (unknown, or hosts that disagree) is never unchanged', async () => {
    for (const head of [undefined, null]) expect(await one(C, { list: [C, B], head })).toMatchObject({ skippable: false })
  })
})

describe('release flow', () => {
  // backend -> migrate (a step on backend's checkout) -> frontend || fastapi
  const flowRig = async (o: { redeploy?: boolean } = {}) => {
    const r = await rig()
    const [be, fe, fa] = ['backend', 'frontend', 'fastapi'].map((n) => dep(r, n))
    if (o.redeploy) commits(r, {})
    const [sb, sf, sa] = [svcIn(r, be, 'backend'), svcIn(r, fe, 'frontend'), svcIn(r, fa, 'fastapi')]
    const { id: _id, anchor: _a, alsoOnRollback: _r, ...migrate } = step()
    const set = (stages: 'flow' | 'swapped') =>
      r.f.deploys.updateSettings(r.f.staging.id, {
        flow: {
          onFailure: 'stop-all',
          stages: [
            { kind: 'services', serviceIds: stages === 'flow' ? [sb.id] : [sf.id, sa.id] },
            { kind: 'step', serviceId: sb.id, step: { ...migrate, id: 'migrate' } },
            { kind: 'services', serviceIds: stages === 'flow' ? [sf.id, sa.id] : [sb.id] },
          ],
        },
      })
    set('flow')
    const id = await ready(r, [be, fe, fa])
    return { r, id, set }
  }

  it('seeds the steps in flow order, keeps the preview hash stable, and hands the runner the flow', async () => {
    const { r, id } = await flowRig()
    const runs = r.svc.detail(id).runs
    const be = runs.find((x) => x.deploymentName === 'backend')!
    expect(be.steps.map((x) => x.key)).toEqual(['record', 'fetch', 'checkout', 'build', 'up', 'c_21', 'tag'])
    expect(be.steps.find((x) => x.key === 'c_21')).toMatchObject({ kind: 'custom', label: 'migrate', state: 'pending' })
    expect(runs.find((x) => x.deploymentName === 'frontend')!.steps.map((x) => x.key)).toEqual(['record', 'fetch', 'checkout', 'build', 'up', 'tag'])

    const a = await r.svc.previewPlaybook(id)
    const b = await r.svc.previewPlaybook(id)
    expect(b.sha256).toBe(a.sha256)
    const names = (JSON.parse(a.playbook) as { name: string }[]).map((p) => p.name)
    expect(names).toEqual(['release prepare', 'release stage 0', 'release stage 1', 'release stage 2', 'release tag'])

    await r.svc.start(id, { playbookSha256: a.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    const plan = r.runner.call('release')
    expect(plan.flow?.stages.map((x) => x.kind)).toEqual(['services', 'step', 'services'])
    expect(plan.flow?.onFailure).toBe('stop-all')
  })

  it('the review hash binds the flow order', async () => {
    const { r, id, set } = await flowRig()
    const a = await r.svc.previewPlaybook(id)
    set('swapped')
    const b = await r.svc.previewPlaybook(id)
    expect(b.sha256).not.toBe(a.sha256)
    expect((await fail(r.svc.start(id, { playbookSha256: a.sha256 }))).message).toBe(PLAYBOOK_CHANGED_MESSAGE)
  })

  /** shop: web changed since A; worker (skipUnchanged, with a health url) unchanged at origin's head C. */
  const shopFlow = async (stages: (web: AppServiceMeta, worker: AppServiceMeta) => Parameters<Rig['f']['deploys']['updateSettings']>[1]['flow'], o: { after?: boolean } = {}) => {
    const r = await rig()
    const d = dep(r, 'shop')
    const web = svcIn(r, d, 'web')
    const worker = r.f.services.create({ kind: 'service', environmentId: d.environmentId, name: 'worker', deploymentId: d.id, skipUnchanged: true, url: 'https://worker.example.com/up' } as never) as AppServiceMeta
    r.f.services.recordDeployed([
      { serviceId: web.id, commit: A, releaseId: null },
      { serviceId: worker.id, commit: C, releaseId: null },
    ])
    commits(r, { [d.id]: { list: [C, B], head: C } })
    const set = () => r.f.deploys.updateSettings(r.f.staging.id, { flow: stages(web, worker) })
    if (!o.after) set()
    const id = await ready(r, [d])
    if (o.after) set()
    return { r, d, web, worker, id }
  }
  const { id: _sid, anchor: _sa, alsoOnRollback: _sr, ...migrateBody } = step()
  /** The runner reports every step the plan runs as ok. */
  const okEverything = (r: Rig) => {
    r.runner.on.release = (plan, _s, emit) => {
      for (const [runId, list] of stepList('release', plan.deployments, plan.flow))
        for (const x of list) {
          emit({ type: 'step.started', stepId: `${runId}:${x.key}`, kind: x.kind, name: x.label, hostId: null, deploymentRunId: runId })
          emit({ type: 'step.done', stepId: `${runId}:${x.key}`, state: 'ok', durationMs: 1 })
        }
    }
  }

  it('a when:always step bound to an unchanged service still runs: that service is never skipped', async () => {
    for (const after of [false, true]) {
      // after: the flow is set once preflight already called the service skippable
      const { r, worker, id } = await shopFlow((web, worker) => ({
        onFailure: 'stop-all',
        stages: [
          { kind: 'services', serviceIds: [web.id] },
          { kind: 'step', serviceId: worker.id, step: { ...migrateBody, id: 'migrate' } },
        ],
      }), { after })
      expect(r.svc.detail(id).preflight?.serviceCommits[worker.id]).toMatchObject({ known: true, count: 0, skippable: after })
      const p = await r.svc.previewPlaybook(id)
      expect(p.skippedServiceIds).toEqual([])
      okEverything(r)
      await r.svc.start(id, { playbookSha256: p.sha256 })
      await r.svc.whenIdle()
      expect(r.svc.detail(id).status).toBe('succeeded')
      const plan = r.runner.call('release')
      expect(plan.flow?.stages.find((x) => x.kind === 'step')).toMatchObject({ kind: 'step', step: { key: 'c_21', step: { when: { kind: 'always' } } } })
      expect(r.svc.detail(id).runs[0].steps.find((x) => x.key === 'c_21')).toMatchObject({ state: 'ok' })
    }
  })

  it('a succeeded run never leaves a pending row: a partial skip reseeds the run as the plan runs it', async () => {
    // worker is skipped: its stage and its health url go, the step bound to web stays
    const { r, worker, id } = await shopFlow((web, worker) => ({
      onFailure: 'continue-other-hosts',
      stages: [
        { kind: 'services', serviceIds: [web.id] },
        { kind: 'step', serviceId: web.id, step: { ...migrateBody, id: 'migrate' } },
        { kind: 'services', serviceIds: [worker.id] },
      ],
    }))
    expect(r.svc.detail(id).runs[0].steps.map((x) => x.key)).toContain('health')
    const p = await r.svc.previewPlaybook(id)
    expect(p.skippedServiceIds).toEqual([worker.id])
    okEverything(r)
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    const rel = r.svc.detail(id)
    expect(rel.status).toBe('succeeded')
    expect(rel.runs[0].steps.map((x) => x.key)).toEqual(['record', 'fetch', 'checkout', 'build', 'up', 'c_21', 'tag'])
    expect(rel.runs[0].steps.filter((x) => x.state === 'pending')).toEqual([])
  })

  it('the review hash covers the inventory host vars: a version change between preview and start is caught', async () => {
    const { r, id } = await flowRig({ redeploy: true })
    expect(r.f.deploys.settings(r.f.staging.id).versioned).toBe(false)
    const a = await r.svc.previewPlaybook(id)
    r.f.deploys.updateSettings(r.f.staging.id, { currentVersion: 'v9.9.9' })
    const b = await r.svc.previewPlaybook(id)
    // the version lives in the inventory's od, not the playbook text
    expect(b.playbook).toBe(a.playbook)
    expect(b.sha256).not.toBe(a.sha256)
    expect((await fail(r.svc.start(id, { playbookSha256: a.sha256, redeploy: true }))).message).toBe(PLAYBOOK_CHANGED_MESSAGE)
    await r.svc.start(id, { playbookSha256: b.sha256, redeploy: true })
    await r.svc.whenIdle()
    expect(r.runner.call('release').version).toBe('v9.9.9')
  })

  it('a rollback runs without the flow', async () => {
    const { r, id } = await flowRig()
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(plan.deployments.map((x) => [x.runId, { previous: A, deployed: B }])) })
    await r.svc.start(id, {})
    await r.svc.whenIdle()
    await r.svc.rollback(id, {})
    await r.svc.whenIdle()
    expect(r.runner.call('rollback').flow).toBeNull()
    expect(r.runner.call('preflight').flow).toBeNull()
  })
})
