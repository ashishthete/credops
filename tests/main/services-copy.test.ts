import { describe, expect, it } from 'vitest'
import { copyServices } from '../../src/main/deploy/service-copy'
import type { CopyServicesRequest } from '../../src/shared/services'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture } from './deploy-helpers'

/** staging holds two checkouts with services and a db; prod (protected) is the target. */
async function setup() {
  const f = await makeDeployFixture()
  const webapp = f.deploys.create(
    f.input({
      name: 'webapp',
      repoUrl: 'git@github.com:acme/webapp.git',
      composeProject: 'webapp_stg',
      composeFile: 'deploy/compose.yml',
      preHook: 'echo pre',
      postHook: 'echo post',
      buildTimeoutSec: 600,
      composeTimeoutSec: 240,
      healthStatus: 204,
      healthTimeoutSec: 90,
      useSudo: 'yes',
      urls: [{ url: 'https://staging.acme.example', from: 'mac' }],
      vaultIds: [DEFAULT_VAULT_ID],
      becomeSecretId: f.secretId,
      dbBackup: true,
      backupDir: '/var/backups',
      managedEnv: true,
      envTemplate: `MODE=staging\nDB_PASSWORD=\${secret:${f.secretId}}\n# keep me\n`,
      deployTag: 'webapp_staging',
    }),
  )
  const worker = f.deploys.create(f.input({ name: 'worker', repoPath: '/srv/worker', deployTag: 'worker_staging' }))
  const esg = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'esg', deploymentId: webapp.id, url: 'https://esg.example', description: 'Front' })
  const api = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'api', deploymentId: webapp.id, composeService: 'fastapi-app', urlCheckFrom: 'host' })
  const jobs = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'jobs', deploymentId: worker.id })
  const loose = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'docs', deploymentId: null })
  const pg = f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', viaHostId: f.host.id, localPort: 15432 })
  const tunnel = f.tunnels.create({ label: 'db', hostId: f.host.id, type: 'L', bindPort: 15432, targetHost: '10.0.0.9', targetPort: 5432 })
  f.services.setTunnel(pg.id, tunnel.id, 15432)
  f.services.recordDeployed([{ serviceId: esg.id, commit: 'abc1234', releaseId: null }])
  const app2 = f.hosts.create({ label: 'app2', address: '10.0.1.7' })
  const request = (over: Partial<CopyServicesRequest> = {}): CopyServicesRequest => ({
    sourceEnvironmentId: f.staging.id,
    targetEnvironmentId: f.prod.id,
    checkouts: [
      { deploymentId: webapp.id, branch: 'release', repoPath: '/srv/prod/webapp', hostId: f.host.id, deployTag: 'webapp_prod' },
      { deploymentId: worker.id, branch: 'release', repoPath: '/srv/prod/worker', hostId: f.host.id, deployTag: 'worker_prod' },
    ],
    dbs: [{ serviceId: pg.id, dbAddress: 'db.prod.internal', dbPort: 5433, viaHostId: null }],
    ...over,
  })
  const copy = (req: CopyServicesRequest) => copyServices({ db: f.db, deploys: f.deploys, services: f.services, audit: f.audit, vault: f.vault }, req)
  return { ...f, webapp, worker, esg, api, jobs, loose, pg, app2, request, copy }
}

const auditCount = (f: { db: { prepare(s: string): { get(): unknown } } }): number =>
  (f.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n

describe('copyServices', () => {
  it('copies a legacy repoUrl unchanged', async () => {
    const f = await setup()
    f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run('https://tok:pw@host/r', f.worker.id)
    f.copy(f.request())
    expect(f.deploys.list(f.prod.id).find((d) => d.name === 'worker')!.repoUrl).toBe('https://tok:pw@host/r')
  })

  it('copies checkouts with the given branch, path, host and tag, and services under them', async () => {
    const f = await setup()
    const result = f.copy(f.request())
    expect(result).toEqual({ created: { services: 5, checkouts: 2 }, skipped: [], addedHosts: 0 })
    const [webapp, worker] = f.deploys.list(f.prod.id)
    expect(webapp).toMatchObject({
      name: 'webapp',
      environmentId: f.prod.id,
      hostId: f.host.id,
      defaultBranch: 'release',
      repoPath: '/srv/prod/webapp',
      deployTag: 'webapp_prod',
      repoUrl: 'git@github.com:acme/webapp.git',
      composeProject: 'webapp_stg',
      composeFile: 'deploy/compose.yml',
      preHook: 'echo pre',
      postHook: 'echo post',
      buildTimeoutSec: 600,
      composeTimeoutSec: 240,
      healthStatus: 204,
      healthTimeoutSec: 90,
      useSudo: 'yes',
      position: f.webapp.position,
    })
    expect(worker).toMatchObject({ name: 'worker', repoPath: '/srv/prod/worker', deployTag: 'worker_prod', position: f.worker.position })
    const byName = new Map(f.services.list(f.prod.id).map((s) => [s.name, s]))
    expect(byName.get('esg')).toMatchObject({ kind: 'service', deploymentId: webapp.id, composeService: 'esg', description: 'Front', position: f.esg.position })
    expect(byName.get('api')).toMatchObject({ deploymentId: webapp.id, composeService: 'fastapi-app', urlCheckFrom: 'host', position: f.api.position })
    expect(byName.get('jobs')).toMatchObject({ deploymentId: worker.id })
    expect(byName.get('docs')).toMatchObject({ deploymentId: null })
    expect(byName.get('main-db')).toMatchObject({ kind: 'db', dbEngine: 'postgres', dbAddress: 'db.prod.internal', dbPort: 5433, viaHostId: null })
    expect(f.services.forCheckout(webapp.id).map((s) => s.name)).toEqual(['esg', 'api'])
    // The source is untouched.
    expect(f.deploys.list(f.staging.id)).toHaveLength(2)
    expect(f.services.list(f.staging.id)).toHaveLength(5)
  })

  it('does not copy urls, vaults, become secret, backup, last commits or tunnels', async () => {
    const f = await setup()
    f.copy(f.request())
    const [webapp] = f.deploys.list(f.prod.id)
    expect(webapp).toMatchObject({ urls: [], vaultIds: [], becomeSecretId: null, dbBackup: false, backupDir: null })
    for (const s of f.services.list(f.prod.id)) {
      if (s.kind === 'service') expect(s).toMatchObject({ url: null, lastDeployedCommit: null, lastReleaseId: null })
      else expect(s).toMatchObject({ tunnelId: null, localPort: null })
    }
  })

  it('managed env template keeps text, clears ${secret:…} and turns managed env off', async () => {
    const f = await setup()
    f.copy(f.request())
    const [webapp] = f.deploys.list(f.prod.id)
    expect(webapp.managedEnv).toBe(false)
    expect(webapp.envTemplate).toBe('MODE=staging\nDB_PASSWORD=\n# keep me\n')
    expect(webapp.envTemplate).not.toContain(f.secretId)
  })

  it('name conflicts are skipped and listed; nothing is overwritten', async () => {
    const f = await setup()
    const existing = f.deploys.create(f.input({ name: 'WebApp', environmentId: f.prod.id, repoPath: '/srv/keep', deployTag: 'keep' }))
    const docs = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'DOCS', deploymentId: null, description: 'mine' })
    const result = f.copy(f.request())
    expect(result.created).toEqual({ services: 2, checkouts: 1 })
    expect(result.skipped).toEqual([
      { kind: 'checkout', name: 'webapp', reason: 'a checkout with that name already exists' },
      { kind: 'service', name: 'esg', reason: 'its checkout was skipped' },
      { kind: 'service', name: 'api', reason: 'its checkout was skipped' },
      { kind: 'service', name: 'docs', reason: 'a service with that name already exists' },
    ])
    expect(f.deploys.get(existing.id)).toEqual(existing)
    expect(f.services.get(docs.id)).toEqual(docs)
    expect(f.services.list(f.prod.id).map((s) => s.name).sort()).toEqual(['DOCS', 'jobs', 'main-db'])
  })

  it('one transaction: a failure part way leaves the target unchanged', async () => {
    const f = await setup()
    const before = auditCount(f)
    const req = f.request()
    req.checkouts[1] = { ...req.checkouts[1], repoPath: 'relative;rm' }
    req.checkouts[0] = { ...req.checkouts[0], hostId: f.app2.id }
    expect(() => f.copy(req)).toThrow('repo path must be an absolute path without spaces or shell characters')
    expect(f.deploys.list(f.prod.id)).toEqual([])
    expect(f.services.list(f.prod.id)).toEqual([])
    expect(f.db.prepare('SELECT 1 FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(f.prod.id, f.app2.id)).toBeUndefined()
    expect(auditCount(f)).toBe(before)
  })

  it('one services.copy audit with counts and no host ids or labels', async () => {
    const f = await setup()
    const before = auditCount(f)
    const req = f.request()
    req.checkouts[1] = { ...req.checkouts[1], hostId: f.app2.id }
    f.copy(req)
    expect(auditCount(f)).toBe(before + 1)
    const [e] = f.audit.list({ actions: ['services.copy'] })
    expect(e).toMatchObject({
      outcome: 'success',
      targetType: 'environment',
      targetId: f.prod.id,
      targetLabel: 'prod',
      details: { sourceEnvironment: 'staging', targetEnvironment: 'prod', serviceCount: 5, checkoutCount: 2, hostCount: 1 },
    })
    const row = JSON.stringify(e)
    for (const leak of [f.host.id, f.app2.id, 'app1', 'app2', '10.0.0', 'db.prod.internal', '/srv']) expect(row).not.toContain(leak)
    expect(f.audit.list({ actions: ['deploy.create', 'service.create'] }).filter((x) => x.details?.environment === 'prod')).toEqual([])
  })

  it('copy into a protected environment needs no confirmation', async () => {
    const f = await setup()
    expect(f.envs.list().find((e) => e.id === f.prod.id)?.protected).toBe(true)
    expect(f.copy(f.request()).created.checkouts).toBe(2)
  })

  it('a non-member host is added as app and counted', async () => {
    const f = await setup()
    const req = f.request()
    req.checkouts = req.checkouts.map((c) => ({ ...c, hostId: f.app2.id }))
    const changed = f.changed.length
    expect(f.copy(req).addedHosts).toBe(1)
    const role = f.db.prepare('SELECT role FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(f.prod.id, f.app2.id) as { role: string }
    expect(role.role).toBe('app')
    expect(f.changed.slice(changed)).toEqual([f.prod.id])
  })

  it('refuses a request that does not match the source', async () => {
    const f = await setup()
    const msg = (req: CopyServicesRequest): string => {
      try {
        f.copy(req)
      } catch (e) {
        return (e as Error).message
      }
      return ''
    }
    expect(msg(f.request({ targetEnvironmentId: f.staging.id }))).toBe('the target must be another environment')
    expect(msg(f.request({ checkouts: f.request().checkouts.slice(1) }))).toBe('every source checkout that has services must be in the copy')
    expect(msg(f.request({ dbs: [] }))).toBe('every source db service must be in the copy')
    expect(msg(f.request({ dbs: [{ ...f.request().dbs[0], serviceId: f.esg.id }] }))).toBe('every source db service must be in the copy')
    const twice = f.request()
    twice.checkouts.push(twice.checkouts[0])
    expect(msg(twice)).toBe('a source checkout is listed twice')
    f.vault.lock('manual')
    expect(msg(f.request())).toMatch(/locked/i)
    expect(f.deploys.list(f.prod.id)).toEqual([])
  })
})
