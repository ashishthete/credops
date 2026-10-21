import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { flowStages, planFields, resolveSelection, runServicesOf, skipServices } from '../../src/main/deploy/selection'
import type { DeploymentMeta, ReleaseFlow } from '../../src/shared/deploy'
import type { AppServiceMeta, DbServiceMeta, ServiceMeta } from '../../src/shared/services'

const ENV = 'env-1'
const OTHER = 'env-2'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const checkout = (id: string, position: number, over: Partial<DeploymentMeta> = {}): DeploymentMeta => ({
  id,
  name: id,
  environmentId: ENV,
  hostId: 'host-1',
  repoUrl: null,
  composeProject: null,
  repoPath: `/srv/${id}`,
  defaultBranch: 'main',
  composeFile: 'docker-compose.yml',
  deployTag: `deploy_${id}`,
  position,
  urls: [],
  healthStatus: 200,
  healthTimeoutSec: 60,
  dbBackup: false,
  backupDir: null,
  preHook: null,
  postHook: null,
  steps: [],
  buildTimeoutSec: 300,
  composeTimeoutSec: 120,
  useSudo: 'auto',
  becomeSecretId: null,
  managedEnv: false,
  envTemplate: null,
  vaultIds: [],
  createdAt: '',
  updatedAt: '',
  ...over,
})

const app = (id: string, deploymentId: string | null, position: number, over: Partial<AppServiceMeta> = {}): AppServiceMeta => ({
  id,
  environmentId: ENV,
  name: id,
  position,
  description: '',
  createdAt: '',
  updatedAt: '',
  kind: 'service',
  skipUnchanged: false,
  deploymentId,
  composeService: id,
  url: null,
  urlCheckFrom: 'mac',
  lastDeployedCommit: null,
  lastReleaseId: null,
  ...over,
})

const db = (id: string, position: number): DbServiceMeta => ({
  id,
  environmentId: ENV,
  name: id,
  position,
  description: '',
  createdAt: '',
  updatedAt: '',
  kind: 'db',
  dbEngine: 'postgres',
  dbAddress: '10.0.0.5',
  dbPort: 5432,
  viaHostId: null,
  localPort: null,
  tunnelId: null,
})

// Checkout "shop" (position 1) holds web, worker, api; "billing" (position 0) holds pay; "bare" (2) has none.
const deployments = [checkout('shop', 1), checkout('billing', 0), checkout('bare', 2), checkout('far', 0, { environmentId: OTHER })]
const services: ServiceMeta[] = [
  app('api', 'shop', 4),
  app('web', 'shop', 1),
  app('worker', 'shop', 2),
  app('pay', 'billing', 3),
  app('loose', null, 5),
  db('pg', 6),
  app('alien', 'far', 0, { environmentId: OTHER }),
]
const data = { services, deployments }
const metas = (list: ServiceMeta[]) => new Map(list.map((s) => [s.id, s]))
const sel = (serviceIds: string[], checkoutIds: string[] = []) => resolveSelection(ENV, { serviceIds, checkoutIds }, data)
const refusal = (serviceIds: string[], checkoutIds: string[] = []): string => {
  try {
    sel(serviceIds, checkoutIds)
  } catch (e) {
    expect(e).toBeInstanceOf(DeployError)
    expect((e as DeployError).code).toBe('INVALID_STATE')
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('resolveSelection', () => {
  it('all tracked services ticked is whole', () => {
    const [g] = sel(['api', 'worker', 'web'])
    expect(g.deployment.id).toBe('shop')
    expect(g.whole).toBe(true)
    expect(g.tracked.map((s) => s.id)).toEqual(['web', 'worker', 'api'])
    expect(g.selected.map((s) => s.id)).toEqual(['web', 'worker', 'api'])
  })

  it('partial keeps position order', () => {
    const [g] = sel(['api', 'web'])
    expect(g.whole).toBe(false)
    expect(g.selected.map((s) => s.id)).toEqual(['web', 'api'])
    expect(g.tracked.map((s) => s.id)).toEqual(['web', 'worker', 'api'])
  })

  it('checkoutIds selects a checkout with no services whole and is refused for one with services', () => {
    const [g] = sel([], ['bare'])
    expect(g).toMatchObject({ whole: true, selected: [], tracked: [] })
    expect(g.deployment.id).toBe('bare')
    expect(refusal([], ['shop'])).toBe('shop has services; pick them instead')
  })

  it('rejects db, foreign, duplicate, no-checkout and empty selections with the messages above', () => {
    expect(refusal(['pg'])).toBe('pg is a database; databases are never deployed')
    expect(refusal(['loose'])).toBe('loose has no checkout')
    expect(refusal(['alien'])).toBe('A selected service does not belong to this environment')
    expect(refusal(['nope'])).toBe('A selected service does not belong to this environment')
    expect(refusal([], ['far'])).toBe('A selected service does not belong to this environment')
    expect(refusal(['web', 'web'])).toBe('A service is listed twice')
    expect(refusal(['bare'], ['bare'])).toBe('A service is listed twice')
    expect(refusal([])).toBe('Select at least one service')
    expect(refusal([], [])).toBe('Select at least one service')
  })

  it('groups come back in checkout position order', () => {
    const groups = sel(['web', 'pay'], ['bare'])
    expect(groups.map((g) => g.deployment.id)).toEqual(['billing', 'shop', 'bare'])
    expect(groups.map((g) => g.whole)).toEqual([true, false, true])
  })
})

describe('plan fields of a selection', () => {

  it('whole is null services, every tracked url, and the bases of every tracked service', () => {
    const list = [
      app('web', 'shop', 1, { url: 'https://web.example', urlCheckFrom: 'host', lastDeployedCommit: A }),
      app('worker', 'shop', 2, { lastDeployedCommit: A }),
      app('api', 'shop', 4, { url: 'https://api.example', lastDeployedCommit: B }),
    ]
    const [g] = resolveSelection(ENV, { serviceIds: ['web', 'worker', 'api'], checkoutIds: [] }, { services: list, deployments })
    const entries = runServicesOf(g)
    expect(entries).toEqual([
      { id: 'web', name: 'web', composeService: 'web', previousCommit: A, previousReleaseId: null, deployedCommit: null },
      { id: 'worker', name: 'worker', composeService: 'worker', previousCommit: A, previousReleaseId: null, deployedCommit: null },
      { id: 'api', name: 'api', composeService: 'api', previousCommit: B, previousReleaseId: null, deployedCommit: null },
    ])
    expect(planFields(g.deployment, { services: entries, whole: true }, metas(list))).toEqual({
      services: null,
      urls: [
        { url: 'https://web.example', from: 'host' },
        { url: 'https://api.example', from: 'mac' },
      ],
      commitBases: { shas: [A, B], tag: false },
    })
  })

  it('partial lists the selected compose services and falls back to the checkout urls', () => {
    const list = [app('web', 'shop', 1, { composeService: 'frontend' }), app('worker', 'shop', 2, { lastDeployedCommit: A }), app('api', 'shop', 4)]
    const dep = checkout('shop', 1, { urls: [{ url: 'https://shop.example', from: 'mac' }] })
    const [g] = resolveSelection(ENV, { serviceIds: ['worker', 'web'], checkoutIds: [] }, { services: list, deployments: [dep] })
    const f = planFields(g.deployment, { services: runServicesOf(g), whole: g.whole }, metas(list))
    expect(f).toEqual({ services: ['frontend', 'worker'], urls: [{ url: 'https://shop.example', from: 'mac' }], commitBases: { shas: [A], tag: true } })
  })

  it('db services never reach a run: not tracked, not in the entries, and whole stays the plain up', () => {
    // A db row can't carry a checkout (the schema refuses it); even a malformed one is not tracked.
    const stray = { ...db('pg2', 0), deploymentId: 'shop' } as unknown as ServiceMeta
    const list = [...services, stray]
    const [g] = resolveSelection(ENV, { serviceIds: ['web', 'worker', 'api'], checkoutIds: [] }, { services: list, deployments })
    expect(g.tracked.map((s) => s.id)).toEqual(['web', 'worker', 'api'])
    const entries = runServicesOf(g)
    expect(entries.map((e) => e.id)).toEqual(['web', 'worker', 'api'])
    expect(planFields(g.deployment, { services: entries, whole: g.whole }, metas(list)).services).toBeNull()
    const partial = resolveSelection(ENV, { serviceIds: ['web'], checkoutIds: [] }, { services: list, deployments })[0]
    expect(planFields(partial.deployment, { services: runServicesOf(partial), whole: partial.whole }, metas(list)).services).toEqual(['web'])
    expect(refusal(['pg'])).toBe('pg is a database; databases are never deployed')
  })

  it('a checkout with no services is the tag range alone', () => {
    const [g] = sel([], ['bare'])
    expect(runServicesOf(g)).toEqual([])
    expect(planFields(g.deployment, { services: [], whole: true }, metas(services))).toEqual({ services: null, urls: [], commitBases: { shas: [], tag: true } })
  })
})

describe('skipServices', () => {
  const entries = (ids: string[], whole: boolean) => {
    const g = sel(ids)[0]
    return { services: runServicesOf(g), whole: whole && g.whole }
  }
  it('drops the skipped services; a whole checkout left with some goes partial', () => {
    const out = skipServices(entries(['web', 'worker', 'api'], true), new Set(['worker', 'pay']))
    expect(out.skipped).toEqual(['worker'])
    expect(out.sel?.whole).toBe(false)
    expect(out.sel?.services.map((e) => e.id)).toEqual(['web', 'api'])
    expect(planFields(checkout('shop', 1), out.sel!, metas(services)).services).toEqual(['web', 'api'])
  })
  it('a run with every service skipped has no selection left', () => {
    expect(skipServices(entries(['web', 'api'], false), new Set(['web', 'api']))).toEqual({ sel: null, skipped: ['web', 'api'] })
  })
  it('nothing to skip leaves the selection as it was, and a checkout with no services is never skipped', () => {
    const whole = entries(['web', 'worker', 'api'], true)
    expect(skipServices(whole, new Set(['pay']))).toEqual({ sel: whole, skipped: [] })
    expect(skipServices({ services: [], whole: true }, new Set(['web']))).toEqual({ sel: { services: [], whole: true }, skipped: [] })
  })
})

describe('flowStages', () => {
  const migrate = { id: 's-mig', name: 'migrate', run: 'shell' as const, service: null, script: 'echo m', cwd: null, sudo: 'docker' as const, timeoutSec: 60, onFailure: 'stop' as const, when: { kind: 'always' as const }, secrets: [{ envName: 'DB_PASS', secretId: 'sec-db' }] }
  // web carries a url, so shop's url list (planFields) is [web]
  const list: ServiceMeta[] = services.map((x) => (x.id === 'web' ? { ...x, url: 'https://web.example.com/up' } : x))
  const runs = (serviceIds: string[], checkoutIds: string[] = []) =>
    resolveSelection(ENV, { serviceIds, checkoutIds }, { services: list, deployments }).map((g) => ({
      run: { id: `run-${g.deployment.id}` },
      dep: g.deployment,
      sel: { services: runServicesOf(g), whole: g.whole },
    }))
  const flow = (onFailure: ReleaseFlow['onFailure'] = 'stop-all'): ReleaseFlow => ({
    onFailure,
    stages: [
      { kind: 'services', serviceIds: ['api'] },
      { kind: 'step', serviceId: 'api', step: migrate },
      { kind: 'services', serviceIds: ['web', 'pay'] },
    ],
  })

  it('no flow: null', () => {
    expect(flowStages(null, runs(['web']), metas(list))).toBeNull()
  })

  it('keeps flow order; unnamed services join their checkout\'s last part', () => {
    const st = flowStages(flow(), runs(['api', 'web', 'worker', 'pay']), metas(list))!
    expect(st.map((x) => x.kind)).toEqual(['services', 'step', 'services'])
    expect(st[0]).toEqual({ kind: 'services', parts: [{ runId: 'run-shop', services: ['api'], urls: [] }] })
    expect(st[1]).toMatchObject({ kind: 'step', runId: 'run-shop', step: { key: 'c_21', anchor: null, secretKeys: [{ envName: 'DB_PASS', key: 'FLOW_1_0' }] } })
    // the checkouts are whole (every service selected): the last part ups the whole checkout and checks every url
    expect(st[2]).toEqual({ kind: 'services', parts: [{ runId: 'run-shop', services: null, urls: [0] }, { runId: 'run-billing', services: null, urls: [] }] })
  })

  it('a partial checkout keeps its listed services, worker folded into the last part', () => {
    const st = flowStages(flow(), runs(['api', 'web', 'worker']).map((r) => ({ ...r, sel: { ...r.sel, whole: false } })), metas(list))!
    expect(st[2]).toEqual({ kind: 'services', parts: [{ runId: 'run-shop', services: ['web', 'worker'], urls: [0] }] })
  })

  it('drops unselected services and the step stages bound to them', () => {
    // billing is whole (pay is all it holds), shop is not (api and worker are left out)
    const st = flowStages(flow(), runs(['web', 'pay']), metas(list))!
    expect(st).toEqual([{ kind: 'services', parts: [{ runId: 'run-shop', services: ['web'], urls: [0] }, { runId: 'run-billing', services: null, urls: [] }] }])
    expect(st.some((x) => x.kind === 'step')).toBe(false)
  })

  it('a stage left with no service is dropped; a checkout the flow never names gets a last stage of its own', () => {
    const st = flowStages({ onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: ['api'] }, { kind: 'services', serviceIds: ['pay'] }] }, runs(['web']), metas(list))!
    expect(st).toEqual([{ kind: 'services', parts: [{ runId: 'run-shop', services: ['web'], urls: [0] }] }])
  })

  it('a service named twice counts where it first appears', () => {
    const st = flowStages({ onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: ['web'] }, { kind: 'services', serviceIds: ['web', 'api'] }] }, runs(['web', 'api']).map((r) => ({ ...r, sel: { ...r.sel, whole: false } })), metas(list))!
    expect(st).toEqual([
      { kind: 'services', parts: [{ runId: 'run-shop', services: ['web'], urls: [0] }] },
      { kind: 'services', parts: [{ runId: 'run-shop', services: ['api'], urls: [] }] },
    ])
  })
})
