import { describe, expect, it } from 'vitest'
import { VAULT_LOCKED } from '../../src/shared/vault'
import type { ServiceInput } from '../../src/shared/services'
import { makeDeployFixture } from './deploy-helpers'
import { auditRows } from './vault-helpers'

type AppServiceInput = Extract<ServiceInput, { kind: 'service' }>
type DbInput = Extract<ServiceInput, { kind: 'db' }>

async function setup() {
  const f = await makeDeployFixture()
  const checkout = f.deploys.create(f.input({ name: 'webapp' }))
  // The fixture's host joins each environment with a placeholder app; these tests count only their own services.
  f.db.prepare('DELETE FROM services').run()
  f.changed.length = 0
  const app = (over: Partial<AppServiceInput> = {}): AppServiceInput => ({
    kind: 'service',
    environmentId: f.staging.id,
    name: 'esg',
    deploymentId: checkout.id,
    ...over,
  })
  const dbService = (over: Partial<DbInput> = {}): DbInput => ({
    kind: 'db',
    environmentId: f.staging.id,
    name: 'main-db',
    dbEngine: 'postgres',
    dbAddress: '10.0.0.9',
    hostId: f.host.id,
    ...over,
  })
  return { ...f, checkout, app, dbService }
}

const message = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a throw')
}

describe('ServiceStore', () => {
  it('create service defaults compose service to the name', async () => {
    const f = await setup()
    const s = f.services.create(f.app({ name: 'js_foundry' }))
    expect(s).toMatchObject({
      kind: 'service',
      environmentId: f.staging.id,
      name: 'js_foundry',
      composeService: 'js_foundry',
      deploymentId: f.checkout.id,
      url: null,
      urlCheckFrom: 'mac',
      description: '',
      position: 0,
      lastDeployedCommit: null,
      lastReleaseId: null,
    })
    expect(f.services.get(s.id)).toEqual(s)
    expect(f.services.list(f.staging.id)).toEqual([s])
    expect(f.changed).toEqual([f.staging.id])
    const explicit = f.services.create(f.app({ name: 'Web API', composeService: 'fastapi-app', url: 'https://api.example', urlCheckFrom: 'host' }))
    expect(explicit).toMatchObject({ composeService: 'fastapi-app', url: 'https://api.example', urlCheckFrom: 'host', position: 1 })
    expect(message(() => f.services.create(f.app({ name: 'Front end' })))).toBe(
      'compose service must be letters, digits, dashes, dots or underscores',
    )
  })

  it('a folder is trimmed, kept on every kind, cleared by blank, and refused unless it is a plain path', async () => {
    const f = await setup()
    const a = f.services.create(f.app({ path: ' /opt/esg ' }))
    expect(a.path).toBe('/opt/esg')
    expect(f.services.create(f.dbService({ path: '~/pg' })).path).toBe('~/pg')
    expect(f.services.create({ kind: 'bastion', environmentId: f.staging.id, hostId: f.host.id, name: 'jump' }).path).toBe('')
    expect(f.services.update(a.id, { name: 'esg2' }).path).toBe('/opt/esg')
    // Another kind keeps the folder.
    expect(f.services.update(a.id, { kind: 'bastion' }).path).toBe('/opt/esg')
    expect(f.services.update(a.id, { path: '' }).path).toBe('')
    for (const bad of ['opt/app', '/opt/my app', '/opt/$(id)', "/a';id", '/a/../b', '~root/x', '/a\nb']) {
      const msg = message(() => f.services.update(a.id, { path: bad }))
      expect(msg).toBe('folder must start with / or ~/ and use only letters, digits and . _ @ + - /')
      expect(msg).not.toContain(bad)
    }
  })

  it('compose service must match COMPOSE_SERVICE', async () => {
    const f = await setup()
    for (const bad of ['--rm', '-p', 'a b', 'x;rm']) {
      const msg = message(() => f.services.create(f.app({ composeService: bad })))
      expect(msg).toBe('compose service must be letters, digits, dashes, dots or underscores')
      expect(msg).not.toContain(bad)
    }
    const s = f.services.create(f.app())
    expect(message(() => f.services.update(s.id, { composeService: 'x;rm' }))).toBe(
      'compose service must be letters, digits, dashes, dots or underscores',
    )
    expect(f.services.list()).toHaveLength(1)
  })

  it('validates name, url, description and checkout without echoing values', async () => {
    const f = await setup()
    expect(message(() => f.services.create(f.app({ name: '   ' })))).toBe('service name is required')
    expect(message(() => f.services.create(f.app({ name: 'x'.repeat(65) })))).toBe('service name must be at most 64 characters')
    for (const url of ['ftp://x.example', 'https://' + 'a'.repeat(2048), 'not a url', 'https://u:p@x.example']) {
      expect(message(() => f.services.create(f.app({ url })))).toBe('url must be http(s) and at most 2048 characters')
    }
    expect(f.services.create(f.app({ url: '  ' }))).toMatchObject({ url: null })
    expect(message(() => f.services.create(f.app({ name: 'b', description: 'd'.repeat(1001) })))).toBe(
      'description must be at most 1000 characters',
    )
    expect(message(() => f.services.create(f.app({ name: 'c', deploymentId: '00000000-0000-4000-8000-000000000000' })))).toBe(
      'checkout not found',
    )
    expect(message(() => f.services.create(f.app({ name: 'd', urlCheckFrom: 'moon' as never })))).toBe('url check must run from mac or host')
    expect(message(() => f.services.create(f.app({ environmentId: '00000000-0000-4000-8000-000000000000' })))).toBe('environment not found')
    const free = f.services.create(f.app({ name: 'loose', deploymentId: null, hostId: f.host.id }))
    expect(free).toMatchObject({ deploymentId: null })
  })

  it('names are unique per environment, case-insensitive', async () => {
    const f = await setup()
    f.services.create(f.app({ name: 'esg' }))
    expect(message(() => f.services.create(f.app({ name: 'ESG', composeService: 'other' })))).toBe(
      'a service named ESG already exists in this environment',
    )
    expect(message(() => f.services.create(f.dbService({ name: 'Esg' })))).toBe('a service named Esg already exists in this environment')
    const prodCheckout = f.deploys.create(f.input({ environmentId: f.prod.id, deployTag: 'deploy_prod' }))
    expect(f.services.create(f.app({ environmentId: f.prod.id, deploymentId: prodCheckout.id, name: 'ESG' })).name).toBe('ESG')
    const other = f.services.create(f.app({ name: 'other' }))
    expect(message(() => f.services.update(other.id, { name: 'Esg' }))).toBe('a service named Esg already exists in this environment')
    expect(f.services.update(other.id, { name: 'Other' }).name).toBe('Other')
  })

  it('compose service is unique per checkout, including on move', async () => {
    const f = await setup()
    const second = f.deploys.create(f.input({ name: 'worker', repoPath: '/srv/worker' }))
    f.services.create(f.app({ name: 'esg' }))
    expect(message(() => f.services.create(f.app({ name: 'esg2', composeService: 'esg' })))).toBe(
      'webapp already has a service for compose service esg',
    )
    const moving = f.services.create(f.app({ name: 'esg-worker', composeService: 'esg', deploymentId: second.id }))
    expect(message(() => f.services.update(moving.id, { deploymentId: f.checkout.id }))).toBe(
      'webapp already has a service for compose service esg',
    )
    expect(f.services.update(moving.id, { deploymentId: f.checkout.id, composeService: 'esg_w' })).toMatchObject({
      deploymentId: f.checkout.id,
      composeService: 'esg_w',
    })
    const loose = f.services.create(f.app({ name: 'loose', composeService: 'esg', deploymentId: null, hostId: f.host.id }))
    expect(loose).toMatchObject({ deploymentId: null })
  })

  it('a checkout from another environment is refused', async () => {
    const f = await setup()
    const prodCheckout = f.deploys.create(f.input({ environmentId: f.prod.id, deployTag: 'deploy_prod' }))
    expect(message(() => f.services.create(f.app({ deploymentId: prodCheckout.id })))).toBe('the checkout belongs to another environment')
    const s = f.services.create(f.app())
    expect(message(() => f.services.update(s.id, { deploymentId: prodCheckout.id }))).toBe('the checkout belongs to another environment')
  })

  it('db requires engine, address and port; port defaults from DB_DEFAULT_PORT', async () => {
    const f = await setup()
    expect(f.services.create(f.dbService())).toMatchObject({
      kind: 'db',
      dbEngine: 'postgres',
      dbAddress: '10.0.0.9',
      dbPort: 5432,
      hostId: f.host.id,
      localPort: null,
      tunnelId: null,
    })
    expect(f.services.create(f.dbService({ name: 'cache', dbEngine: 'redis', dbAddress: 'redis.internal' }))).toMatchObject({ dbPort: 6379 })
    expect(f.services.create(f.dbService({ name: 'my', dbEngine: 'mysql', dbPort: 3307, hostId: f.host.id, localPort: 15432 }))).toMatchObject({
      dbPort: 3307,
      hostId: f.host.id,
      localPort: 15432,
    })
    expect(message(() => f.services.create(f.dbService({ name: 'x', dbEngine: 'other' })))).toBe('port must be 1-65535')
    expect(message(() => f.services.create(f.dbService({ name: 'x', dbEngine: 'oracle' as never })))).toBe(
      'db engine must be postgres, mysql, mongodb, redis or other',
    )
    expect(message(() => f.services.create(f.dbService({ name: 'x', dbAddress: 'a b;rm' })))).toBe('host address is invalid')
    expect(message(() => f.services.create(f.dbService({ name: 'x', dbPort: 70000 })))).toBe('port must be 1-65535')
    expect(message(() => f.services.create(f.dbService({ name: 'x', localPort: 0 })))).toBe('port must be 1-65535')
    expect(message(() => f.services.create(f.dbService({ name: 'x', hostId: '00000000-0000-4000-8000-000000000000' })))).toBe('host not found')
  })

  it('db fields on a service patch are refused', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    const d = f.services.create(f.dbService())
    expect(message(() => f.services.update(s.id, { dbPort: 5433 } as never))).toBe('that field does not apply to an app')
    expect(message(() => f.services.update(d.id, { composeService: 'x' } as never))).toBe('that field does not apply to a db service')
    expect(message(() => f.services.update(d.id, { url: null } as never))).toBe('that field does not apply to a db service')
    expect(message(() => f.services.create({ ...f.app({ name: 'z' }), dbPort: 1 } as never))).toBe(
      'that field does not apply to an app',
    )
    expect(f.services.update(d.id, { dbAddress: 'db.internal', localPort: null })).toMatchObject({ dbAddress: 'db.internal' })
    expect(f.services.update(s.id, { description: 'Front end' })).toMatchObject({ description: 'Front end' })
  })

  it('the environment never changes through update', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    expect(message(() => f.services.update(s.id, { environmentId: f.prod.id } as never))).toBe('a service changes environment by being moved, not edited')
    expect(f.services.update(s.id, { kind: 'service', environmentId: f.staging.id } as never)).toEqual(s)
  })

  it('an app becomes a db, letting go of its checkout and deploy record', async () => {
    const f = await setup()
    const s = f.services.create(f.app({ url: 'https://esg.example.com' }))
    f.services.recordDeployed([{ serviceId: s.id, commit: 'abc1234', releaseId: null }])
    const d = f.services.update(s.id, { kind: 'db', dbEngine: 'mysql', dbAddress: '10.0.0.9' })
    expect(d).toMatchObject({ id: s.id, kind: 'db', name: 'esg', hostId: f.host.id, position: s.position, dbEngine: 'mysql', dbAddress: '10.0.0.9', dbPort: 3306, localPort: null, tunnelId: null })
    expect(d).not.toHaveProperty('deploymentId')
    const [e] = f.audit.list({ actions: ['service.update'] })
    expect(e.details).toMatchObject({ kind: 'db', fields: ['kind', 'dbEngine', 'dbAddress'] })
    // And back: an app again, without the checkout it had.
    expect(f.services.update(s.id, { kind: 'service' })).toMatchObject({ kind: 'service', deploymentId: null, composeService: '', url: null, lastDeployedCommit: null })
  })

  it('a db becomes a bastion; its tunnel stays as a plain tunnel', async () => {
    const f = await setup()
    const d = f.services.create(f.dbService())
    const tunnel = f.tunnels.create({ label: 'db', hostId: f.host.id, type: 'L', bindAddress: '127.0.0.1', bindPort: 15432, targetHost: '10.0.0.9', targetPort: 5432 })
    f.services.setTunnel(d.id, tunnel.id, 15432)
    const b = f.services.update(d.id, { kind: 'bastion', description: 'Jump box' })
    expect(b).toMatchObject({ id: d.id, kind: 'bastion', name: 'main-db', description: 'Jump box' })
    expect(b).not.toHaveProperty('dbAddress')
    expect(f.tunnels.get(tunnel.id)).toMatchObject({ label: 'db' })
  })

  it('a kind change validates the new kind and refuses a service a flow or runbook names', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    expect(message(() => f.services.update(s.id, { kind: 'db' }))).toBe('a db service needs an engine and an address')
    expect(message(() => f.services.update(s.id, { kind: 'db', dbEngine: 'postgres', dbAddress: '10.0.0.9', url: null } as never))).toBe('that field does not apply to a db service')
    expect(message(() => f.services.update(s.id, { kind: 'nope' } as never))).toBe('kind must be app, db or bastion')
    f.db.prepare('UPDATE environments SET release_flow = ? WHERE id = ?').run(JSON.stringify({ steps: [{ serviceIds: [s.id] }] }), f.staging.id)
    expect(message(() => f.services.update(s.id, { kind: 'bastion' }))).toBe("esg is part of staging's release flow; take it out of the flow first")
    expect(f.services.get(s.id)).toEqual(s)
  })

  it('move takes a service to another environment, last in line', async () => {
    const f = await setup()
    f.services.create(f.dbService({ environmentId: f.prod.id, name: 'other' }))
    const d = f.services.create(f.dbService())
    const tunnel = f.tunnels.create({ label: 'db', hostId: f.host.id, type: 'L', bindAddress: '127.0.0.1', bindPort: 15432, targetHost: '10.0.0.9', targetPort: 5432 })
    f.services.setTunnel(d.id, tunnel.id, 15432)
    f.changed.length = 0
    const moved = f.services.move(d.id, f.prod.id)
    expect(moved).toMatchObject({ id: d.id, environmentId: f.prod.id, position: 1, tunnelId: tunnel.id, dbAddress: '10.0.0.9' })
    expect(f.services.list(f.staging.id)).toEqual([])
    expect(f.changed).toEqual([f.staging.id, f.prod.id])
    const [e] = f.audit.list({ actions: ['service.move'] })
    expect(e.details).toEqual({ environment: 'prod', kind: 'db', from: 'staging' })
  })

  it('move leaves the checkout behind only when asked', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    f.services.recordDeployed([{ serviceId: s.id, commit: 'abc1234', releaseId: null }])
    expect(message(() => f.services.move(s.id, f.prod.id))).toBe('esg deploys from a checkout, which stays in staging')
    expect(f.services.move(s.id, f.prod.id, { detachCheckout: true })).toMatchObject({ environmentId: f.prod.id, deploymentId: null, lastDeployedCommit: null, name: 'esg' })
  })

  it('move refuses the same environment, a taken name, and a service a flow or runbook names', async () => {
    const f = await setup()
    const s = f.services.create(f.app({ deploymentId: null, hostId: f.host.id }))
    expect(message(() => f.services.move(s.id, f.staging.id))).toBe('esg is already in that environment')
    expect(message(() => f.services.move(s.id, '00000000-0000-4000-8000-000000000000'))).toBe('environment not found')
    const twin = f.services.create(f.app({ environmentId: f.prod.id, name: 'ESG', deploymentId: null, hostId: f.host.id }))
    expect(message(() => f.services.move(s.id, f.prod.id))).toBe('a service named esg already exists in prod')
    f.services.delete(twin.id)
    f.db.prepare("INSERT INTO runbooks(id, environment_id, name, definition, created_at, updated_at) VALUES ('r1', ?, 'restart', ?, 'x', 'x')").run(f.staging.id, JSON.stringify({ targets: [s.id] }))
    expect(message(() => f.services.move(s.id, f.prod.id))).toBe('esg is a target of the runbook restart; take it out of the runbook first')
    f.db.prepare('DELETE FROM runbooks').run()
    f.vault.lock('manual')
    expect(message(() => f.services.move(s.id, f.prod.id))).toBe(VAULT_LOCKED)
  })

  it('reorder needs exactly the environment\'s services', async () => {
    const f = await setup()
    const a = f.services.create(f.app({ name: 'a' }))
    const b = f.services.create(f.app({ name: 'b' }))
    const c = f.services.create(f.dbService({ name: 'c' }))
    const reorderMsg = "ids must be exactly the environment's services"
    expect(message(() => f.services.reorder(f.staging.id, [a.id, b.id]))).toBe(reorderMsg)
    expect(message(() => f.services.reorder(f.staging.id, [a.id, a.id, b.id]))).toBe(reorderMsg)
    expect(message(() => f.services.reorder(f.prod.id, [a.id, b.id, c.id]))).toBe(reorderMsg)
    f.changed.length = 0
    f.services.reorder(f.staging.id, [c.id, b.id, a.id])
    expect(f.services.list(f.staging.id).map((s) => s.name)).toEqual(['c', 'b', 'a'])
    expect(f.services.forCheckout(f.checkout.id).map((s) => s.name)).toEqual(['b', 'a'])
    expect(f.changed).toEqual([f.staging.id])
  })

  it('writes audit service.* without host ids or labels', async () => {
    const f = await setup()
    const s = f.services.create(f.app({ url: 'https://esg.example' }))
    const d = f.services.create(f.dbService({ hostId: f.host.id }))
    f.services.update(s.id, { description: 'Main site', url: null })
    f.services.update(d.id, { dbPort: 5433 })
    f.services.reorder(f.staging.id, [d.id, s.id])
    f.services.delete(s.id)
    f.services.delete(d.id)
    const [create] = f.audit.list({ actions: ['service.create'] }).filter((e) => e.targetId === s.id)
    expect(create).toMatchObject({ targetType: 'service', targetLabel: 'esg', details: { environment: 'staging', kind: 'service' } })
    const updates = f.audit.list({ actions: ['service.update'] })
    expect(updates.find((e) => e.targetId === s.id)?.details).toEqual({ environment: 'staging', kind: 'service', fields: ['description', 'url'] })
    expect(updates.find((e) => e.targetId === d.id)?.details).toEqual({ environment: 'staging', kind: 'db', fields: ['dbPort'] })
    expect(f.audit.list({ actions: ['service.delete'] }).find((e) => e.targetId === d.id)).toMatchObject({
      targetLabel: 'main-db',
      details: { environment: 'staging', kind: 'db' },
    })
    // The inventory fixture's own rows name the host; every service.* row must not.
    const rows = JSON.stringify(f.db.prepare("SELECT * FROM audit_events WHERE action LIKE 'service.%' ORDER BY id").all())
    expect(rows).toContain('service.create')
    expect(rows).not.toContain(f.host.id)
    expect(rows).not.toContain('app1')
    expect(rows).not.toContain('10.0.0.9')
    expect(rows).not.toContain('esg.example')
  })

  it('vault locked refuses writes', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    const d = f.services.create(f.dbService())
    f.vault.lock('manual')
    for (const fn of [
      () => f.services.create(f.app({ name: 'x' })),
      () => f.services.update(s.id, { description: 'x' }),
      () => f.services.delete(s.id),
      () => f.services.reorder(f.staging.id, [d.id, s.id]),
      () => f.services.setTunnel(d.id, null, 15432),
    ]) {
      expect(fn).toThrow(VAULT_LOCKED)
    }
    expect(f.services.list()).toHaveLength(2)
  })

  it('deleting the checkout leaves the service with deploymentId null', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    f.deploys.delete(f.checkout.id)
    expect(f.services.get(s.id)).toMatchObject({ deploymentId: null, composeService: 'esg' })
    expect(f.services.forCheckout(f.checkout.id)).toEqual([])
  })

  it('setTunnel and recordDeployed update their columns without audit', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    const d = f.services.create(f.dbService())
    const tunnel = f.tunnels.create({ label: 'db', hostId: f.host.id, type: 'L', bindAddress: '127.0.0.1', bindPort: 15432, targetHost: '10.0.0.9', targetPort: 5432 })
    const before = auditRows(f.db)
    expect(f.services.setTunnel(d.id, tunnel.id, 15432)).toMatchObject({ tunnelId: tunnel.id, localPort: 15432 })
    expect(message(() => f.services.setTunnel(s.id, null, null))).toBe('only a db service has a tunnel')
    f.services.recordDeployed([{ serviceId: s.id, commit: 'abc1234', releaseId: null }])
    expect(f.services.get(s.id)).toMatchObject({ lastDeployedCommit: 'abc1234', lastReleaseId: null })
    expect(auditRows(f.db)).toBe(before)
  })
})

describe('ServiceStore skipUnchanged', () => {
  it('defaults to false, round-trips and audits the field name', async () => {
    const f = await setup()
    const s = f.services.create(f.app())
    expect(s).toMatchObject({ skipUnchanged: false })
    const on = f.services.update(s.id, { skipUnchanged: true })
    expect(on).toMatchObject({ skipUnchanged: true })
    expect(f.services.get(s.id)).toMatchObject({ skipUnchanged: true })
    const [e] = f.audit.list({ actions: ['service.update'] })
    expect(e.details).toMatchObject({ fields: ['skipUnchanged'] })
    expect(f.services.create(f.app({ name: 'second', skipUnchanged: true }))).toMatchObject({ skipUnchanged: true })
  })

  it('refuses it on a db service', async () => {
    const f = await setup()
    const db = f.services.create(f.dbService())
    expect(() => f.services.update(db.id, { skipUnchanged: true } as never)).toThrow()
  })
})
