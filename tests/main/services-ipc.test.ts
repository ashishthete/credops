import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { createServiceHandlers } from '../../src/main/ipc/handlers/services'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { CHANNELS, type Handlers } from '../../src/shared/ipc'
import type { ServiceStore } from '../../src/main/deploy/service-store'
import { makeDeployFixture } from './deploy-helpers'
import { stubHandlers } from './ipc-helpers'

type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const SERVICE_CHANNELS = ['service:list', 'service:create', 'service:update', 'service:delete', 'service:reorder']
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
const DB = { kind: 'db', environmentId: ID, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9' }

describe('service:* IPC', () => {
  it('lists every service channel, validated and wired', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(SERVICE_CHANNELS))
    for (const c of SERVICE_CHANNELS) expect(VALIDATORS).toHaveProperty([c])
    expect(Object.keys(createServiceHandlers({ services: {} as ServiceStore })).sort()).toEqual([...SERVICE_CHANNELS].sort())
  })

  it('validators reject extra and malformed args for every service:* channel', () => {
    expect(() => check('service:list', [])).not.toThrow()
    expect(() => check('service:list', [ID])).not.toThrow()
    expect(() => check('service:create', [APP])).not.toThrow()
    expect(() => check('service:create', [{ ...APP, deploymentId: null, composeService: 'esg', url: null, urlCheckFrom: 'host', description: 'x' }])).not.toThrow()
    expect(() => check('service:create', [{ ...DB, dbPort: 5432, viaHostId: null, localPort: 15432 }])).not.toThrow()
    expect(() => check('service:update', [ID, { name: 'x', dbPort: 1 }])).not.toThrow()
    expect(() => check('service:delete', [ID, { deleteTunnel: false }])).not.toThrow()
    expect(() => check('service:reorder', [ID, [ID]])).not.toThrow()

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
    const pushed: { environmentId: string }[] = []
    f.services.onChanged = (environmentId) => pushed.push({ environmentId })
    const call = register(createServiceHandlers({ services: f.services }))

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
})
