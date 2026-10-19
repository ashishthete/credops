import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE_HEARTBEAT_MS, LIVE_MAX_STREAMS_PER_USER, type HubLiveMessage } from '../../src/shared/hub'
import type { RunEvent } from '../../src/shared/deploy'
import { LiveBus } from '../src/live/bus'
import { testHub, type TestHub } from './helpers'
import { DEP_API, DEP_WEB, ENV_ID, HOST_ID, JUMP_ID, manifest } from './manifest'

let hub: TestHub
let live = false
const readers: Reader[] = []
afterEach(async () => {
  for (const r of readers.splice(0)) r.abort()
  if (live) await hub.close()
  live = false
})

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const CAT = { oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', upn: 'cat@example.com', name: 'Cat' }
const E2 = 'e2222222-2222-4222-8222-222222222222'

const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })

interface Frame {
  event: string
  data: unknown
}
interface Reader {
  status: number
  headers: Headers
  text: () => string
  frames: () => Frame[]
  until: (pred: (text: string) => boolean) => Promise<void>
  closed: () => Promise<void>
  abort: () => void
}

let baseUrl = ''
async function open(token: string | null): Promise<Reader> {
  const ctl = new AbortController()
  const res = await fetch(`${baseUrl}/api/v1/live`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal })
  let buf = ''
  let done = false
  const waiters: (() => void)[] = []
  const wake = () => waiters.splice(0).forEach((w) => w())
  const pump = (async () => {
    if (!res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    try {
      for (;;) {
        const { value, done: d } = await reader.read()
        if (d) break
        buf += dec.decode(value, { stream: true })
        wake()
      }
    } catch {
      // aborted
    }
    done = true
    wake()
  })()
  void pump
  const wait = (ms = 3000) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(buf)}`)), ms)
      waiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  const r: Reader = {
    status: res.status,
    headers: res.headers,
    text: () => buf,
    frames: () =>
      buf
        .split('\n\n')
        .filter((b) => b.startsWith('event: '))
        .map((b) => {
          const [e, d] = b.split('\n')
          return { event: e.slice(7), data: JSON.parse(d.slice(6)) }
        }),
    until: async (pred) => {
      while (!pred(buf)) await wait()
    },
    closed: async () => {
      while (!done) await wait()
    },
    abort: () => ctl.abort(),
  }
  readers.push(r)
  return r
}

const events = (n: number, line = 'building'): RunEvent[] =>
  Array.from({ length: n }, (_, i) => ({ id: `ev${i}`, runId: 'rel-1', seq: i, at: '2026-10-19T00:00:00.000Z', type: 'log', stepId: null, hostId: null, stream: 'out', line }) as RunEvent)

async function setup(appDeps: Parameters<typeof testHub>[1] = {}, config: Parameters<typeof testHub>[0] = {}) {
  hub = await testHub(config, appDeps)
  live = true
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const cat = (await hub.signIn(CAT)).token
  const m1 = manifest()
  const swap = (s: string) =>
    s
      .replaceAll(ENV_ID, E2)
      .replaceAll(HOST_ID, 'a3333333-3333-4333-8333-333333333333')
      .replaceAll(JUMP_ID, 'a4444444-4444-4444-8444-444444444444')
      .replaceAll(DEP_WEB, 'd3333333-3333-4333-8333-333333333333')
      .replaceAll(DEP_API, 'd4444444-4444-4444-8444-444444444444')
  const m2 = JSON.parse(swap(JSON.stringify(m1)))
  m2.environment.name = 'staging'
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, m1)).statusCode).toBe(200)
  expect((await call(admin, 'PUT', `/api/v1/admin/environments/${E2}`, m2)).statusCode).toBe(200)
  const grant = async (name: string, oid: string, environmentId: string) => {
    const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name })).json().id as string
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [oid] })).statusCode).toBe(200)
    const r = await call(admin, 'POST', `/api/v1/admin/groups/${g}/grants`, { scope: { kind: 'environment', environmentId } })
    expect(r.statusCode).toBe(201)
    return { group: g, grantId: r.json().id as string }
  }
  const bobGrant = await grant('Prod ops', BOB.oid, ENV_ID)
  await grant('Staging ops', CAT.oid, E2)
  await hub.app.listen({ host: '127.0.0.1', port: 0 })
  const addr = hub.app.server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
  return { admin, bob, cat, bobGrant }
}

const deployEvents = (environmentId: string, line?: string): HubLiveMessage => ({ type: 'deploy.events', environmentId, events: events(1, line) })

describe('live bus over SSE', () => {
  it('streams events only for environments the user can view', async () => {
    const { bob, cat } = await setup()
    const b = await open(bob)
    const c = await open(cat)
    expect(b.status).toBe(200)
    expect(b.headers.get('content-type')).toContain('text/event-stream')
    expect(b.headers.get('cache-control')).toBe('no-store')
    expect(b.headers.get('x-accel-buffering')).toBe('no')
    hub.app.live.publish(deployEvents(ENV_ID, 'e1 line'))
    hub.app.live.publish(deployEvents(E2, 'e2 line'))
    hub.app.live.publish({ type: 'catalog.updated' })
    await b.until((t) => t.includes('event: catalog.updated'))
    await c.until((t) => t.includes('event: catalog.updated'))
    expect(b.frames().map((f) => f.event)).toEqual(['deploy.events', 'catalog.updated'])
    expect(JSON.stringify(b.frames()[0].data)).toContain('e1 line')
    expect(c.frames().map((f) => f.event)).toEqual(['deploy.events', 'catalog.updated'])
    expect(JSON.stringify(c.frames()[0].data)).toContain('e2 line')
    expect(c.text()).not.toContain('e1 line')
    expect(b.text()).not.toContain('e2 line')
  })

  it('revoked access stops frames immediately', async () => {
    const { admin, bob, bobGrant } = await setup()
    const b = await open(bob)
    hub.app.live.publish(deployEvents(ENV_ID, 'before'))
    await b.until((t) => t.includes('before'))
    expect((await call(admin, 'DELETE', `/api/v1/admin/grants/${bobGrant.grantId}`)).statusCode).toBe(204)
    hub.app.live.publish(deployEvents(ENV_ID, 'after'))
    hub.app.live.publish({ type: 'catalog.updated' })
    await b.until((t) => t.includes('event: catalog.updated'))
    expect(b.frames().map((f) => f.event)).toEqual(['deploy.events', 'access.changed', 'catalog.updated'])
    expect(b.text()).not.toContain('after')
  })

  it('membership changes also announce access.changed to everyone', async () => {
    const { admin, cat } = await setup()
    const c = await open(cat)
    const g = (await call(admin, 'POST', '/api/v1/admin/groups', { name: 'Extra' })).json().id as string
    await call(admin, 'POST', `/api/v1/admin/groups/${g}/members`, { oids: [BOB.oid] })
    await c.until((t) => t.includes('event: access.changed'))
    expect(c.frames().map((f) => f.event)).toContain('access.changed')
  })

  it('disabling the user closes the stream', async () => {
    const { admin, bob } = await setup()
    const b = await open(bob)
    hub.app.live.publish(deployEvents(ENV_ID))
    await b.until((t) => t.includes('deploy.events'))
    expect((await call(admin, 'PATCH', `/api/v1/admin/users/${BOB.oid}`, { disabled: true })).statusCode).toBe(200)
    await b.closed()
    const again = await fetch(`${baseUrl}/api/v1/live`, { headers: { authorization: `Bearer ${bob}` } })
    expect(again.status).toBe(401)
    await again.body?.cancel()
  })

  it('signing out closes only that session', async () => {
    const { bob } = await setup()
    const second = (await hub.signIn(BOB)).token
    const a = await open(bob)
    const b = await open(second)
    expect((await call(bob, 'DELETE', '/api/v1/session')).statusCode).toBeLessThan(300)
    await a.closed()
    hub.app.live.publish({ type: 'catalog.updated' })
    await b.until((t) => t.includes('catalog.updated'))
  })

  it('lock changes are pushed as lock.updated', async () => {
    const { admin, bob, cat } = await setup()
    const b = await open(bob)
    const c = await open(cat)
    expect((await call(admin, 'POST', `/api/v1/environments/${ENV_ID}/freeze`, { reason: 'migration' })).statusCode).toBeLessThan(300)
    await b.until((t) => t.includes('lock.updated'))
    const f = b.frames().find((x) => x.event === 'lock.updated')!
    expect(f.data).toMatchObject({ type: 'lock.updated', environmentId: ENV_ID, lock: { kind: 'manual' } })
    hub.app.live.publish({ type: 'catalog.updated' })
    await c.until((t) => t.includes('catalog.updated'))
    expect(c.frames().map((x) => x.event)).toEqual(['catalog.updated'])
  })

  it('publishing or unpublishing an environment announces catalog.updated', async () => {
    const { admin, cat } = await setup()
    const c = await open(cat)
    expect((await call(admin, 'DELETE', `/api/v1/admin/environments/${E2}`)).statusCode).toBeLessThan(300)
    await c.until((t) => t.includes('catalog.updated'))
  })

  it('the oldest stream is closed past the per-user cap', async () => {
    const { bob } = await setup()
    const opened: Reader[] = []
    for (let i = 0; i <= LIVE_MAX_STREAMS_PER_USER; i++) opened.push(await open(bob))
    await opened[0].closed()
    hub.app.live.publish({ type: 'catalog.updated' })
    await opened[LIVE_MAX_STREAMS_PER_USER].until((t) => t.includes('catalog.updated'))
  })

  it('frames are redacted', async () => {
    const { bob } = await setup()
    const b = await open(bob)
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
    hub.app.live.publish(deployEvents(ENV_ID, `key ${pem}`))
    await b.until((t) => t.includes('deploy.events'))
    expect(b.text()).not.toContain('b3BlbnNzaC1')
    expect(b.text()).toContain('redacted')
  })

  it('a no-op user update does not announce access.changed', async () => {
    const { admin, bob, cat } = await setup()
    const c = await open(cat)
    expect((await call(admin, 'PATCH', `/api/v1/admin/users/${BOB.oid}`, { disabled: false })).statusCode).toBe(200)
    hub.app.live.publish({ type: 'catalog.updated' })
    await c.until((t) => t.includes('catalog.updated'))
    expect(c.frames().map((f) => f.event)).toEqual(['catalog.updated'])
    void bob
  })

  it('a frame published after the session expired is not delivered, and the stream ends', async () => {
    const { bob } = await setup()
    const b = await open(bob)
    hub.app.live.publish(deployEvents(ENV_ID, 'while valid'))
    await b.until((t) => t.includes('while valid'))
    hub.clock.now = new Date(hub.clock.now.getTime() + 13 * 3_600_000)
    hub.app.live.publish(deployEvents(ENV_ID, 'after expiry'))
    await b.closed()
    expect(b.text()).not.toContain('after expiry')
  })

  it('an idle stream ends when its session expires', async () => {
    const { bob } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let b: Reader
    try {
      b = await open(bob)
      hub.clock.now = new Date(hub.clock.now.getTime() + 13 * 3_600_000)
      vi.advanceTimersByTime(13 * 3_600_000)
    } finally {
      vi.useRealTimers()
    }
    await b.closed()
  })

  it('hub.close() resolves while a stream is open and nobody reads it', async () => {
    const { bob } = await setup()
    const port = (hub.app.server.address() as { port: number }).port
    const sock = connect(port, '127.0.0.1')
    sock.pause()
    await new Promise<void>((r) => sock.once('connect', () => r()))
    sock.write(`GET /api/v1/live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${bob}\r\n\r\n`)
    await new Promise((r) => setTimeout(r, 100))
    const closed = hub.close().then(() => 'closed')
    live = false
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r('hung'), 3000))])).toBe('closed')
    sock.destroy()
  })

  it('SSE frames mask values the Hub knows are secret', async () => {
    const { bob } = await setup({ liveKnownSecrets: () => ['s3cr3t-value-123'] })
    const b = await open(bob)
    hub.app.live.publish(deployEvents(ENV_ID, 'token=s3cr3t-value-123 end'))
    await b.until((t) => t.includes('deploy.events'))
    expect(b.text()).not.toContain('s3cr3t-value-123')
    expect(b.text()).toContain('end')
  })

  it('no auth header is 401', async () => {
    await setup()
    const r = await open(null)
    expect(r.status).toBe(401)
    expect(r.headers.get('content-type')).not.toContain('event-stream')
    const bad = await open('ohs_nope')
    expect(bad.status).toBe(401)
  })
})

describe('LiveBus unit', () => {
  const user = { oid: 'u1', role: 'maintainer', status: 'active', groupIds: [] } as never
  const mk = () => {
    let tick: (() => void) | null = null
    let cancelled = 0
    const bus = new LiveBus({
      directory: { get: () => user, listGroups: () => [] },
      knownSecrets: () => ['hunter2-secret'],
      every: (fn, ms) => {
        expect(ms).toBe(LIVE_HEARTBEAT_MS)
        tick = fn
        return () => {
          tick = null
          cancelled++
        }
      },
    })
    return { bus, tick: () => tick?.(), isTicking: () => tick !== null, cancelled: () => cancelled }
  }

  it('drops an expired stream before a frame or a ping', () => {
    let now = 1_000
    const admin = { oid: 'a', role: 'admin', status: 'active', groupIds: [] } as never
    let tick: () => void = () => {}
    const bus = new LiveBus({ directory: { get: () => admin, listGroups: () => [] }, knownSecrets: () => [], now: () => new Date(now), every: (fn) => ((tick = fn), () => {}) })
    const out: string[] = []
    let closed = 0
    bus.subscribe('a', (f) => out.push(f), () => closed++, null, 2_000)
    tick()
    expect(out).toEqual([': ping\n\n'])
    now = 2_000
    tick()
    expect(out).toHaveLength(1)
    expect(closed).toBe(1)
    const out2: string[] = []
    now = 1_000
    bus.subscribe('a', (f) => out2.push(f), () => closed++, null, 2_000)
    now = 2_500
    bus.publish({ type: 'catalog.updated' })
    expect(out2).toEqual([])
    expect(closed).toBe(2)
  })

  it('heartbeats on a manual clock', () => {
    const { bus, tick, isTicking } = mk()
    const out: string[] = []
    expect(isTicking()).toBe(false)
    const off = bus.subscribe('u1', (f) => out.push(f), () => {})
    expect(isTicking()).toBe(true)
    tick()
    tick()
    expect(out).toEqual([': ping\n\n', ': ping\n\n'])
    off()
    expect(isTicking()).toBe(false)
  })

  it('redacts known secret values in frames', () => {
    const { bus } = mk()
    const out: string[] = []
    bus.subscribe('u1', (f) => out.push(f), () => {})
    bus.publish({ type: 'deploy.events', environmentId: ENV_ID, events: events(1, 'password is hunter2-secret ok') })
    // maintainer without a grant sees nothing; admins do
    expect(out).toEqual([])
    const admin = { oid: 'a', role: 'admin', status: 'active', groupIds: [] } as never
    const bus2 = new LiveBus({ directory: { get: () => admin, listGroups: () => [] }, knownSecrets: () => ['hunter2-secret'], every: () => () => {} })
    const out2: string[] = []
    bus2.subscribe('a', (f) => out2.push(f), () => {})
    bus2.publish({ type: 'deploy.events', environmentId: ENV_ID, events: events(1, 'password is hunter2-secret ok') })
    expect(out2).toHaveLength(1)
    expect(out2[0]).not.toContain('hunter2-secret')
    expect(out2[0].startsWith('event: deploy.events\ndata: ')).toBe(true)
    expect(out2[0].endsWith('\n\n')).toBe(true)
  })

  it('a throwing writer is dropped and does not stop the others', () => {
    const admin = { oid: 'a', role: 'admin', status: 'active', groupIds: [] } as never
    const bus = new LiveBus({ directory: { get: () => admin, listGroups: () => [] }, knownSecrets: () => [], every: () => () => {} })
    let closed = 0
    const out: string[] = []
    bus.subscribe('a', () => { throw new Error('socket gone') }, () => { closed++ })
    bus.subscribe('a', (f) => out.push(f), () => {})
    bus.publish({ type: 'catalog.updated' })
    bus.publish({ type: 'catalog.updated' })
    expect(closed).toBe(1)
    expect(out).toHaveLength(2)
  })

  it('loads each user once per publish', () => {
    let gets = 0
    let lists = 0
    const admin = { oid: 'a', role: 'admin', status: 'active', groupIds: [] } as never
    const bus = new LiveBus({ directory: { get: () => (gets++, admin), listGroups: () => (lists++, []) }, knownSecrets: () => [], every: () => () => {} })
    for (let i = 0; i < 3; i++) bus.subscribe('a', () => {}, () => {})
    bus.publish(deployEvents(ENV_ID))
    expect(gets).toBe(1)
    expect(lists).toBe(1)
  })
})
