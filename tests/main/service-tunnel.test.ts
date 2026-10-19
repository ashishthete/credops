import { describe, expect, it } from 'vitest'
import { ServiceTunnels } from '../../src/main/deploy/service-tunnel'
import { createServiceHandlers } from '../../src/main/ipc/handlers/services'
import { TunnelLimitError } from '../../src/main/tunnels/manager'
import type { DbServiceMeta } from '../../src/shared/services'
import { TUNNEL_LIMIT, type TunnelMeta, type TunnelRuntime, type TunnelState } from '../../src/shared/tunnels'
import { makeDeployFixture } from './deploy-helpers'

const runtime = (id: string, state: TunnelState, over: Partial<TunnelRuntime> = {}): TunnelRuntime => ({
  id,
  state,
  error: null,
  failures: 0,
  maxFailures: 5,
  retryAt: null,
  boundAddress: null,
  boundPort: null,
  liveness: 'probe',
  startedAt: null,
  upAt: null,
  lastProbeAt: null,
  ...over,
})

/** Records start, stop and the store's change hook; `start` returns `connecting` unless a test sets another answer. */
function fakeManager() {
  const calls: string[] = []
  const states = new Map<string, TunnelRuntime>()
  let answer: ((id: string) => TunnelRuntime) | null = null
  const manager = {
    start: (id: string): TunnelRuntime => {
      calls.push('start')
      const rt = answer ? answer(id) : runtime(id, 'connecting')
      states.set(id, rt)
      return rt
    },
    stop: (id: string): void => {
      calls.push('stop')
      states.set(id, runtime(id, 'stopped'))
    },
    runtime: (id: string): TunnelRuntime => states.get(id) ?? runtime(id, 'stopped'),
  }
  return {
    manager,
    calls,
    set: (id: string, state: TunnelState) => void states.set(id, runtime(id, state)),
    answer: (fn: (id: string) => TunnelRuntime) => void (answer = fn),
  }
}

async function setup() {
  const f = await makeDeployFixture()
  const m = fakeManager()
  const changed: [TunnelMeta, TunnelMeta][] = []
  f.tunnels.onChanged = (before, after) => void changed.push([before, after])
  let nextPort = 15432
  const ports: number[] = []
  const st = new ServiceTunnels({
    services: f.services,
    tunnels: f.tunnels,
    manager: m.manager,
    environments: () => f.envs.list(),
    deploys: f.deploys,
    hostLabel: (id) => f.hosts.list().find((h) => h.id === id)!.label,
    freePort: async () => {
      ports.push(nextPort)
      return nextPort++
    },
  })
  const db = (over: Record<string, unknown> = {}): DbServiceMeta =>
    f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', ...over }) as DbServiceMeta
  const svc = (id: string): DbServiceMeta => f.services.get(id) as DbServiceMeta
  return { ...f, ...m, st, changed, ports, db, svc }
}

describe('ServiceTunnels', () => {
  it('first open picks a free port, saves it, creates an L tunnel labelled with the service name and starts it', async () => {
    const t = await setup()
    const d = t.db()
    const rt = await t.st.open(d.id)
    const after = t.svc(d.id)
    expect(after.localPort).toBe(15432)
    expect(after.tunnelId).not.toBeNull()
    expect(rt).toEqual(runtime(after.tunnelId!, 'connecting'))
    expect(t.tunnels.get(after.tunnelId!)).toMatchObject({
      label: 'main-db',
      hostId: t.host.id,
      environmentId: t.staging.id,
      type: 'L',
      bindAddress: '127.0.0.1',
      bindPort: 15432,
      targetHost: '10.0.0.9',
      targetPort: 5432,
      autoReconnect: true,
      autoStart: false,
    })
    expect(t.calls).toEqual(['start'])
    expect(t.ports).toEqual([15432])
  })

  it('second open reuses the tunnel and port', async () => {
    const t = await setup()
    const d = t.db()
    await t.st.open(d.id)
    const first = t.svc(d.id)
    t.set(first.tunnelId!, 'stopped')
    await t.st.open(d.id)
    expect(t.svc(d.id)).toMatchObject({ tunnelId: first.tunnelId, localPort: 15432 })
    expect(t.tunnels.list()).toHaveLength(1)
    expect(t.ports).toEqual([15432])
    expect(t.changed).toEqual([])
    // A port the user set is used as it is; freePort is never asked.
    const e = t.db({ name: 'cache', dbEngine: 'redis', dbAddress: '10.0.0.10', localPort: 16379 })
    await t.st.open(e.id)
    expect(t.tunnels.get(t.svc(e.id).tunnelId!)).toMatchObject({ bindPort: 16379, targetPort: 6379, label: 'cache' })
    expect(t.ports).toEqual([15432])
    // A tunnel deleted on the Tunnels page is recreated with the saved port.
    t.tunnels.delete(first.tunnelId!)
    await t.st.open(d.id)
    const again = t.svc(d.id)
    expect(again.tunnelId).not.toBe(first.tunnelId)
    expect(t.tunnels.get(again.tunnelId!).bindPort).toBe(15432)
  })

  it('open reports the Phase 5 failure and never claims up', async () => {
    const t = await setup()
    const d = t.db()
    const error = { code: 'port-in-use' as const, message: 'Port 15432 on 127.0.0.1 is in use by postgres' }
    t.answer((id) => runtime(id, 'failed', { error, failures: 1 }))
    const rt = await t.st.open(d.id)
    expect(rt.state).toBe('failed')
    expect(rt.error).toEqual(error)
    t.answer(() => {
      throw new TunnelLimitError()
    })
    await expect(t.st.open(d.id)).rejects.toThrow(TUNNEL_LIMIT)
  })

  it('via-host gone falls back to the default app host, else asks for one', async () => {
    const t = await setup()
    const h2 = t.hosts.create({ label: 'bastion', address: '10.0.0.8' })
    t.envs.putHost(t.staging.id, h2.id, 'app')
    const d = t.db({ viaHostId: h2.id })
    expect(t.st.viaHost(t.svc(d.id))).toBe(h2.id)
    t.envs.removeHost(t.staging.id, h2.id)
    expect(t.st.viaHost(t.svc(d.id))).toBe(t.host.id)
    await t.st.open(d.id)
    expect(t.tunnels.get(t.svc(d.id).tunnelId!).hostId).toBe(t.host.id)
    // A db-role member is no default via-host: with no app host left, the user picks one.
    const h3 = t.hosts.create({ label: 'pg1', address: '10.0.0.9' })
    t.envs.putHost(t.staging.id, h3.id, 'db')
    t.envs.removeHost(t.staging.id, t.host.id)
    expect(() => t.st.viaHost(t.svc(d.id))).toThrow(new Error('Pick a via-host for main-db; this environment has no app host'))
  })

  it('afterUpdate updates a stopped tunnel and reports a running one without changing it', async () => {
    const t = await setup()
    const d = t.db()
    await t.st.open(d.id)
    const tunnelId = t.svc(d.id).tunnelId!
    t.set(tunnelId, 'stopped')
    expect(t.st.afterUpdate(t.services.update(d.id, { dbPort: 5433 }))).toBe(false)
    expect(t.tunnels.get(tunnelId).targetPort).toBe(5433)
    // A change that leaves the route alone needs nothing.
    expect(t.st.afterUpdate(t.services.update(d.id, { description: 'Main db' }))).toBe(false)

    for (const state of ['up', 'connecting', 'retrying'] as const) {
      t.set(tunnelId, state)
      const row = t.tunnels.get(tunnelId)
      const calls = t.calls.length
      const changes = t.changed.length
      expect(t.st.afterUpdate(t.services.update(d.id, { dbAddress: `db-${state}.internal` })), state).toBe(true)
      expect(t.tunnels.get(tunnelId)).toEqual(row)
      expect(t.calls).toHaveLength(calls)
      expect(t.changed).toHaveLength(changes)
    }
    // An app service has no tunnel.
    const checkout = t.deploys.create(t.input({ name: 'webapp' }))
    const app = t.services.create({ kind: 'service', environmentId: t.staging.id, name: 'esg', deploymentId: checkout.id })
    expect(t.st.afterUpdate(app)).toBe(false)
  })

  it('sync applies the route to a running tunnel', async () => {
    const t = await setup()
    const d = t.db()
    await t.st.open(d.id)
    const tunnelId = t.svc(d.id).tunnelId!
    t.set(tunnelId, 'up')
    expect(t.st.afterUpdate(t.services.update(d.id, { dbAddress: 'db.internal', name: 'primary-db' }))).toBe(true)
    expect(t.st.sync(d.id)).toEqual(runtime(tunnelId, 'up'))
    expect(t.tunnels.get(tunnelId)).toMatchObject({ targetHost: 'db.internal', label: 'primary-db' })
    // The store's change hook is what restarts a running tunnel (TunnelManager.changed).
    expect(t.changed.map(([b, a]) => [b.targetHost, a.targetHost])).toEqual([['10.0.0.9', 'db.internal']])
    // No tunnel yet: nothing to sync.
    const e = t.db({ name: 'cache', dbEngine: 'redis', dbAddress: '10.0.0.10' })
    expect(t.st.sync(e.id)).toBeNull()

    // A route left stale (the user said no) is synced by the next open before it starts.
    t.set(tunnelId, 'up')
    t.services.update(d.id, { dbPort: 6543 })
    t.set(tunnelId, 'stopped')
    await t.st.open(d.id)
    expect(t.tunnels.get(tunnelId).targetPort).toBe(6543)
  })

  it('delete with deleteTunnel removes the tunnel; without it the tunnel stays', async () => {
    const t = await setup()
    const call = createServiceHandlers({
      services: t.services,
      copy: () => ({}) as never,
      deploys: t.deploys,
      containers: { followCompose: async () => 'never' },
      tunnels: t.st,
      openExternal: async () => {},
    })
    const d = t.db()
    await t.st.open(d.id)
    const gone = t.svc(d.id).tunnelId!
    const calls = t.calls.length
    await call['service:delete'](d.id, { deleteTunnel: true })
    expect(() => t.tunnels.get(gone)).toThrow(/tunnel not found/)
    expect(t.calls.slice(calls)).toEqual(['stop'])
    expect(t.services.list(t.staging.id)).toEqual([])

    const e = t.db()
    await t.st.open(e.id)
    const kept = t.svc(e.id).tunnelId!
    await call['service:delete'](e.id, { deleteTunnel: false })
    expect(t.tunnels.get(kept)).toMatchObject({ label: 'main-db' })
    expect(t.services.list(t.staging.id)).toEqual([])
  })
})
