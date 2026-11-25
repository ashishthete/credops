import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { copyServices } from '../../src/main/deploy/service-copy'
import { createServiceHandlers } from '../../src/main/ipc/handlers/services'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { CHANNELS, type Handlers } from '../../src/shared/ipc'
import type { ServiceStore } from '../../src/main/deploy/service-store'
import type { ServiceTunnels } from '../../src/main/deploy/service-tunnel'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'
import { stubHandlers } from './ipc-helpers'

type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const SERVICE_CHANNELS = [
  'service:list',
  'service:create',
  'service:update',
  'service:delete',
  'service:reorder',
  'service:copy',
  'service:logs',
  'service:open',
  'service:tunnelOpen',
  'service:tunnelClose',
  'service:tunnelSync',
]
const check = (channel: string, a: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](a)

function register(handlers: Partial<Handlers>) {
  const registered = new Map<string, Fn>()
  registerHandlers(
    { handle: (c: string, fn: Fn) => void registered.set(c, fn) },
    stubHandlers(handlers),
    (u) => u === 'file:///ok',
    { validators: VALIDATORS },
  )
  const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
  return (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
}

const APP = { kind: 'service', environmentId: ID, name: 'esg', deploymentId: ID }
const COPY = {
  sourceEnvironmentId: ID,
  targetEnvironmentId: ID,
  checkouts: [{ deploymentId: ID, branch: 'main', repoPath: '/srv/app', hostId: ID, deployTag: 'webapp_prod' }],
  dbs: [{ serviceId: ID, dbAddress: 'db.internal', dbPort: 5432, hostId: ID }],
}
const DB = { kind: 'db', environmentId: ID, hostId: ID, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9' }

/** Every dep but the store, with no-op tunnels and a follow that records its call. */
function rest(f: DeployFixture, over: { opened?: string[]; follows?: unknown[][] } = {}) {
  const tunnels = { afterUpdate: () => false, remove: () => {}, open: async () => ({}) as never, close: () => {}, sync: () => null } as unknown as ServiceTunnels
  return {
    copy: () => ({}) as never,
    deploys: f.deploys,
    containers: {
      followCompose: async (...a: unknown[]) => {
        over.follows?.push(a)
        return 'follow-1'
      },
    },
    tunnels,
    openExternal: async (url: string) => void over.opened?.push(url),
  }
}

describe('service:* IPC', () => {
  it('lists every service channel, validated and wired', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(SERVICE_CHANNELS))
    for (const c of SERVICE_CHANNELS) expect(VALIDATORS).toHaveProperty([c])
    const handlers = createServiceHandlers({ services: {} as ServiceStore, ...rest({} as DeployFixture) })
    expect(Object.keys(handlers).sort()).toEqual([...SERVICE_CHANNELS].sort())
  })

  it('validators reject extra and malformed args for every service:* channel', () => {
    expect(() => check('service:list', [])).not.toThrow()
    expect(() => check('service:list', [ID])).not.toThrow()
    expect(() => check('service:create', [APP])).not.toThrow()
    expect(() => check('service:create', [{ ...APP, deploymentId: null, composeService: 'esg', url: null, urlCheckFrom: 'host', description: 'x' }])).not.toThrow()
    expect(() => check('service:create', [{ ...DB, dbPort: 5432, localPort: 15432 }])).not.toThrow()
    expect(() => check('service:create', [{ kind: 'bastion', environmentId: ID, hostId: ID, name: 'jump', description: 'x' }])).not.toThrow()
    expect(() => check('service:create', [{ ...APP, deploymentId: null, hostId: ID, composeService: '' }])).not.toThrow()
    expect(() => check('service:update', [ID, { hostId: ID }])).not.toThrow()
    expect(() => check('service:update', [ID, { name: 'x', dbPort: 1 }])).not.toThrow()
    expect(() => check('service:delete', [ID, { deleteTunnel: false }])).not.toThrow()
    expect(() => check('service:reorder', [ID, [ID]])).not.toThrow()
    expect(() => check('service:copy', [COPY])).not.toThrow()
    expect(() => check('service:logs', [ID, 200])).not.toThrow()
    for (const c of ['service:open', 'service:tunnelOpen', 'service:tunnelClose', 'service:tunnelSync']) expect(() => check(c, [ID])).not.toThrow()

    const bad: [string, unknown[], RegExp][] = [
      ['service:list', ['x'], /\[0\]/],
      ['service:create', [{ ...APP, extra: 1 }], /extra/],
      ['service:create', [{ ...APP, kind: 'cron' }], /kind/],
      ['service:create', [{ ...APP, dbPort: 5432 }], /dbPort/],
      ['service:create', [{ ...DB, deploymentId: ID }], /deploymentId/],
      ['service:create', [{ ...APP, environmentId: 'x' }], /environmentId/],
      ['service:create', [{ ...APP, name: '' }], /name/],
      ['service:create', [{ ...APP, deploymentId: undefined }], /deploymentId/],
      ['service:create', [{ ...APP, urlCheckFrom: 'moon' }], /urlCheckFrom/],
      ['service:create', [{ ...APP, url: 'x'.repeat(2049) }], /url/],
      ['service:create', [{ ...DB, dbEngine: 'oracle' }], /dbEngine/],
      ['service:create', [{ ...DB, dbPort: 0 }], /dbPort/],
      ['service:create', [{ ...DB, localPort: 70000 }], /localPort/],
      ['service:create', ['x'], /\[0\]/],
      ['service:update', ['x', {}], /\[0\]/],
      ['service:update', [ID, { kind: 'db' }], /kind/],
      ['service:update', [ID, { environmentId: ID }], /environmentId/],
      ['service:update', [ID, { tunnelId: ID }], /tunnelId/],
      ['service:update', [ID, { name: 5 }], /name/],
      ['service:delete', [ID], /\[1\]/],
      ['service:delete', [ID, { deleteTunnel: 'yes' }], /deleteTunnel/],
      ['service:delete', [ID, { deleteTunnel: true, extra: 1 }], /extra/],
      ['service:reorder', [ID, ['x']], /\[1\]\[0\]/],
      ['service:reorder', [ID, 'x'], /\[1\]/],
      ['service:copy', [{ ...COPY, extra: 1 }], /extra/],
      ['service:copy', [{ ...COPY, targetEnvironmentId: 'x' }], /targetEnvironmentId/],
      ['service:copy', [{ ...COPY, checkouts: [{ ...COPY.checkouts[0], hostId: 'x' }] }], /checkouts\[0\]\.hostId/],
      ['service:copy', [{ ...COPY, checkouts: [{ ...COPY.checkouts[0], branch: '' }] }], /branch/],
      ['service:copy', [{ ...COPY, checkouts: [{ ...COPY.checkouts[0], vaultIds: [] }] }], /vaultIds/],
      ['service:copy', [{ ...COPY, dbs: [{ ...COPY.dbs[0], dbPort: 0 }] }], /dbs\[0\]\.dbPort/],
      ['service:copy', [{ ...COPY, dbs: [{ ...COPY.dbs[0], hostId: undefined }] }], /hostId/],
      ['service:create', [{ ...DB, hostId: undefined }], /hostId/],
      ['service:create', [{ ...DB, viaHostId: ID }], /viaHostId/],
      ['service:create', [{ kind: 'bastion', environmentId: ID, name: 'jump' }], /hostId/],
      ['service:logs', [ID], /\[1\]/],
      ['service:logs', [ID, -1], /\[1\]/],
      ['service:logs', [ID, 1.5], /\[1\]/],
      ['service:logs', ['x', 10], /\[0\]/],
      ['service:open', ['x'], /\[0\]/],
      ['service:tunnelOpen', ['x'], /\[0\]/],
      ['service:tunnelClose', [], /\[0\]/],
      ['service:tunnelSync', [5], /\[0\]/],
    ]
    for (const [channel, a, path] of bad) expect(() => check(channel, a), `${channel} ${JSON.stringify(a)}`).toThrow(path)
    // The message names the path and the rule, never the value.
    let msg = ''
    try {
      check('service:create', [{ ...APP, name: 'marker-'.repeat(20) }])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/name/)
    expect(msg).not.toContain('marker-')
  })

  it('service:create round-trips and emits deploy:changed', async () => {
    const f = await makeDeployFixture()
    const checkout = f.deploys.create(f.input({ name: 'webapp' }))
    f.db.prepare('DELETE FROM services').run()
    const pushed: { environmentId: string }[] = []
    f.services.onChanged = (environmentId) => pushed.push({ environmentId })
    const call = register(createServiceHandlers({ services: f.services, ...rest(f) }))

    const created = (await call('service:create', { kind: 'service', environmentId: f.staging.id, name: '  esg  ', deploymentId: checkout.id })) as {
      id: string
      name: string
    }
    expect(created).toMatchObject({ name: 'esg', composeService: 'esg', deploymentId: checkout.id })
    await expect(call('service:list', f.staging.id)).resolves.toEqual([created])
    expect(pushed).toEqual([{ environmentId: f.staging.id }])

    await expect(call('service:update', created.id, { description: 'Main site' })).resolves.toEqual({
      service: expect.objectContaining({ description: 'Main site' }),
      tunnelRestartNeeded: false,
    })
    await call('service:reorder', f.staging.id, [created.id])
    await call('service:delete', created.id, { deleteTunnel: true })
    await expect(call('service:list')).resolves.toEqual([])
    expect(pushed).toEqual([{ environmentId: f.staging.id }, { environmentId: f.staging.id }, { environmentId: f.staging.id }])
  })

  it('service:copy runs the copy through the validator and returns counts', async () => {
    const f = await makeDeployFixture()
    const checkout = f.deploys.create(f.input({ name: 'webapp' }))
    f.db.prepare('DELETE FROM services WHERE environment_id = ?').run(f.staging.id)
    f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'esg', deploymentId: checkout.id })
    const call = register(
      createServiceHandlers({ ...rest(f), services: f.services, copy: (req) => copyServices({ db: f.db, deploys: f.deploys, services: f.services, audit: f.audit, vault: f.vault }, req) }),
    )
    const req = {
      sourceEnvironmentId: f.staging.id,
      targetEnvironmentId: f.prod.id,
      checkouts: [{ deploymentId: checkout.id, branch: 'main', repoPath: '/srv/prod', hostId: f.host.id, deployTag: 'webapp_prod' }],
      dbs: [],
    }
    await expect(call('service:copy', req)).resolves.toEqual({ created: { services: 1, checkouts: 1 }, skipped: [], addedHosts: 0 })
    await expect(call('service:copy', { ...req, sourceEnvironmentId: 'x' })).rejects.toThrow(/sourceEnvironmentId/)
  })

  it('service:open refuses a service without a url and opens through openExternal', async () => {
    const f = await makeDeployFixture()
    const checkout = f.deploys.create(f.input({ name: 'webapp' }))
    const opened: string[] = []
    const call = register(createServiceHandlers({ services: f.services, ...rest(f, { opened }) }))
    const bare = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'worker', deploymentId: checkout.id })
    const site = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'esg', deploymentId: checkout.id, url: 'https://esg.example.com/app' })
    const db = f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', hostId: f.host.id })
    await expect(call('service:open', bare.id)).rejects.toThrow(/^worker has no URL$/)
    await expect(call('service:open', db.id)).rejects.toThrow(/^main-db has no URL$/)
    expect(opened).toEqual([])
    await call('service:open', site.id)
    expect(opened).toEqual(['https://esg.example.com/app'])
  })

  it('service:logs refuses a db service', async () => {
    const f = await makeDeployFixture()
    const checkout = f.deploys.create(f.input({ name: 'webapp', composeProject: 'shop', useSudo: 'yes' }))
    const follows: unknown[][] = []
    const call = register(createServiceHandlers({ services: f.services, ...rest(f, { follows }) }))
    const db = f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', hostId: f.host.id })
    const loose = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'cron', deploymentId: null, hostId: f.host.id })
    const app = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'esg', deploymentId: checkout.id, composeService: 'esg-web' })
    await expect(call('service:logs', db.id, 100)).rejects.toThrow(/^main-db is a database; it has no compose logs$/)
    await expect(call('service:logs', loose.id, 100)).rejects.toThrow(/^cron has no checkout$/)
    expect(follows).toEqual([])
    await expect(call('service:logs', app.id, 100)).resolves.toBe('follow-1')
    expect(follows).toEqual([
      [
        f.host.id,
        f.staging.id,
        { repoPath: '/srv/app', composeFile: checkout.composeFile, composeProject: 'shop', composeService: 'esg-web', useSudo: 'yes' },
        100,
      ],
    ])
  })
})
