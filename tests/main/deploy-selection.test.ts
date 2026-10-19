import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { planFields, resolveSelection, runServicesOf } from '../../src/main/deploy/selection'
import type { DeploymentMeta } from '../../src/shared/deploy'
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
  const metas = (list: ServiceMeta[]) => new Map(list.map((s) => [s.id, s]))

  it('whole is null services, every tracked url, and the bases of every tracked service', () => {
    const list = [
      app('web', 'shop', 1, { url: 'https://web.example', urlCheckFrom: 'host', lastDeployedCommit: A }),
      app('worker', 'shop', 2, { lastDeployedCommit: A }),
      app('api', 'shop', 4, { url: 'https://api.example', lastDeployedCommit: B }),
    ]
    const [g] = resolveSelection(ENV, { serviceIds: ['web', 'worker', 'api'], checkoutIds: [] }, { services: list, deployments })
    const entries = runServicesOf(g)
    expect(entries).toEqual([
      { id: 'web', name: 'web', composeService: 'web', previousCommit: A, deployedCommit: null },
      { id: 'worker', name: 'worker', composeService: 'worker', previousCommit: A, deployedCommit: null },
      { id: 'api', name: 'api', composeService: 'api', previousCommit: B, deployedCommit: null },
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

  it('a checkout with no services is the tag range alone', () => {
    const [g] = sel([], ['bare'])
    expect(runServicesOf(g)).toEqual([])
    expect(planFields(g.deployment, { services: [], whole: true }, metas(services))).toEqual({ services: null, urls: [], commitBases: { shas: [], tag: true } })
  })
})
