import { describe, expect, it } from 'vitest'
import { asTunnelInput, asTunnelPatch } from '../../src/main/ipc/validators'
import { TunnelStore } from '../../src/main/tunnels/tunnel-store'
import { MAX_TUNNELS, isLoopback, type TunnelInput } from '../../src/shared/tunnels'
import { auditRows } from './vault-helpers'
import { makeInventory } from './inventory-helpers'

async function setup() {
  const f = await makeInventory()
  const host = f.hosts.create({ label: 'db-1', address: '10.0.0.5' })
  const store = new TunnelStore({ db: f.db, audit: f.audit, vault: f.vault })
  const input = (over: Partial<TunnelInput> = {}): TunnelInput => ({
    label: 'db',
    hostId: host.id,
    type: 'L',
    bindPort: 5433,
    targetHost: 'localhost',
    targetPort: 5432,
    ...over,
  })
  const events = (action: string) => f.audit.list({ actions: [action as never] })
  return { f, host, store, input, events }
}

describe('TunnelStore', () => {
  it('creates an L tunnel with defaults', async () => {
    const { f, store, input, events } = await setup()
    const t = store.create(input())
    expect(t).toMatchObject({ bindAddress: '127.0.0.1', autoStart: false, autoReconnect: true, environmentId: null })
    expect(store.list()).toEqual([t])
    const [e] = events('tunnel.create')
    expect(e).toMatchObject({ targetType: 'tunnel', targetId: t.id, targetLabel: 'db', details: { type: 'L', bindPort: 5433, exposed: false } })
    expect(auditRows(f.db)).not.toContain('localhost')
  })

  it('creates a D tunnel without target', async () => {
    const { store, input } = await setup()
    const t = store.create(input({ type: 'D', targetHost: undefined, targetPort: undefined, bindPort: 1080 }))
    expect(t).toMatchObject({ targetHost: null, targetPort: null })
    expect(() => store.create(input({ type: 'D', targetHost: undefined, targetPort: 1 }))).toThrow('a dynamic tunnel has no target')
  })

  it('rejects bad input without echoing the value', async () => {
    const { store, input } = await setup()
    const cases: [Partial<TunnelInput>, string][] = [
      [{ label: '   ' }, 'tunnel label must be 1-120 characters'],
      [{ hostId: 'nope' }, 'host not found'],
      [{ bindAddress: '10.0.0.999x' }, 'bind address must be an IP address or localhost'],
      [{ bindPort: 70000 }, 'bind port must be 0-65535'],
      [{ targetHost: undefined }, 'target host is required for L and R tunnels'],
      [{ targetPort: 0 }, 'port must be 1-65535'],
      [{ targetHost: 'bad host!' }, 'host address is invalid'],
    ]
    for (const [over, message] of cases) {
      let err: Error | undefined
      try {
        store.create(input(over))
      } catch (e) {
        err = e as Error
      }
      expect(err?.message).toBe(message)
    }
    expect(store.list()).toEqual([])
  })

  it('environment must contain the host', async () => {
    const { f, host, store, input } = await setup()
    const env = f.envs.create({ name: 'prod', color: '#aabbcc' })
    expect(() => store.create(input({ environmentId: env.id }))).toThrow('host is not in that environment')
    f.envs.putHost(env.id, host.id, 'db')
    expect(store.create(input({ environmentId: env.id })).environmentId).toBe(env.id)
  })

  it('exposed bind is accepted and audited', async () => {
    const { store, input, events } = await setup()
    store.create(input({ bindAddress: '0.0.0.0' }))
    expect(events('tunnel.create')[0].details).toMatchObject({ exposed: true })
    expect(isLoopback('127.1.2.3') && isLoopback('::1') && isLoopback('localhost')).toBe(true)
    expect(isLoopback('::') || isLoopback('192.168.1.2')).toBe(false)
  })

  it('update audits changed fields only', async () => {
    const { store, input, events } = await setup()
    const t = store.create(input())
    store.update(t.id, { label: 'db2', bindPort: 5433 })
    expect(events('tunnel.update')).toHaveLength(1)
    expect(events('tunnel.update')[0]).toMatchObject({ targetLabel: 'db2', details: { fields: ['label'] } })
    store.update(t.id, { label: 'db2', bindPort: 5433 })
    expect(events('tunnel.update')).toHaveLength(1)
  })

  it('switching to D clears the target', async () => {
    const { store, input } = await setup()
    const t = store.create(input())
    expect(() => store.update(t.id, { type: 'D' })).toThrow('a dynamic tunnel has no target')
    expect(store.update(t.id, { type: 'D', targetHost: null, targetPort: null })).toMatchObject({ type: 'D', targetHost: null, targetPort: null })
  })

  it('limit', async () => {
    const { store, input } = await setup()
    for (let i = 0; i < MAX_TUNNELS; i++) store.create(input({ label: `t${i}` }))
    expect(() => store.create(input({ label: 'one more' }))).toThrow('too many tunnels (256)')
  })

  it('lists by label, finds the same tunnel and lists per host', async () => {
    const { f, host, store, input } = await setup()
    const other = f.hosts.create({ label: 'web', address: '10.0.0.6' })
    store.create(input({ label: 'b' }))
    store.create(input({ label: 'A', hostId: other.id }))
    expect(store.list().map((t) => t.label)).toEqual(['A', 'b'])
    expect(store.listForHost(host.id).map((t) => t.label)).toEqual(['b'])
    expect(store.findSame(input({ label: 'x' }))?.label).toBe('b')
    expect(store.findSame(input({ bindPort: 1 }))).toBeNull()
  })

  it('mutations need the vault unlocked', async () => {
    const { f, store, input } = await setup()
    const t = store.create(input())
    f.vault.lock('manual')
    expect(() => store.create(input({ label: 'x' }))).toThrow('vault locked')
    expect(() => store.update(t.id, { label: 'y' })).toThrow('vault locked')
    expect(() => store.delete(t.id)).toThrow('vault locked')
    expect(store.list()).toHaveLength(1)
  })

  it('hooks fire after COMMIT with before and after, and delete is audited', async () => {
    const { f, store, input, events } = await setup()
    const t = store.create(input())
    const seen: unknown[] = []
    store.onChanged = (before, after) => {
      seen.push([before.label, after.label, store.get(t.id).label, f.db.isTransaction])
    }
    store.onRemoved = (id) => {
      seen.push(['removed', id, f.db.isTransaction, store.list().length])
    }
    store.update(t.id, { label: 'db2' })
    store.delete(t.id)
    expect(seen).toEqual([['db', 'db2', 'db2', false], ['removed', t.id, false, 0]])
    expect(events('tunnel.delete')[0]).toMatchObject({ targetLabel: 'db2' })
  })

  it('cascades from the host', async () => {
    const { f, host, store, input } = await setup()
    store.create(input())
    f.hosts.delete(host.id)
    expect(store.list()).toEqual([])
  })
})

describe('tunnel validators', () => {
  const ok = { label: 'db', hostId: '11111111-1111-4111-8111-111111111111', type: 'L', bindPort: 5433, targetHost: 'h', targetPort: 1 }
  it('rejects bad shapes naming the path', () => {
    expect(asTunnelInput(ok, '[0]')).toMatchObject({ bindPort: 5433 })
    expect(() => asTunnelInput({ ...ok, bindPort: 70000 }, '[0]')).toThrow('[0].bindPort')
    expect(() => asTunnelInput({ ...ok, type: 'X' }, '[0]')).toThrow('[0].type')
    expect(() => asTunnelInput({ ...ok, label: 5 }, '[0]')).toThrow('[0].label')
    expect(() => asTunnelInput({ ...ok, hostId: 'nope' }, '[0]')).toThrow('[0].hostId')
    expect(() => asTunnelInput({ ...ok, bindAddress: '10.0.0.999x' }, '[0]')).toThrow('[0].bindAddress')
    expect(asTunnelPatch({ targetHost: null, targetPort: null, environmentId: null }, '[1]')).toEqual({
      targetHost: null,
      targetPort: null,
      environmentId: null,
    })
    expect(() => asTunnelPatch({ type: 'Z' }, '[1]')).toThrow('[1].type')
  })
})
