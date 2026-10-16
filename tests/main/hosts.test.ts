import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { inventoryHandlers, makeInventory, type InventoryFixture } from './inventory-helpers'
import { auditRows } from './vault-helpers'

const hostActions = (f: InventoryFixture) =>
  f.audit
    .list({ limit: 1000 })
    .reverse()
    .filter((e) => e.action.startsWith('host.'))

/** EnvironmentStore arrives in a later task, so these tests insert environment rows directly. */
function insertEnv(f: InventoryFixture, name: string, jumpHostId: string | null = null): string {
  const id = randomUUID()
  const ts = new Date().toISOString()
  f.db
    .prepare(
      'INSERT INTO environments(id, name, color, default_jump_host_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, name, '#336699', jumpHostId, ts, ts)
  return id
}

describe('HostStore', () => {
  it('creates with links in one go', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({
      label: 'web-1',
      address: '10.0.0.5',
      tags: ['Prod', 'prod', ' api '],
      vaultIds: [DEFAULT_VAULT_ID],
    })
    expect(h).toMatchObject({ port: null, identityId: null, tags: ['Prod', 'api'], vaultIds: [DEFAULT_VAULT_ID] })
    const rows = hostActions(f).filter((e) => e.action === 'host.create')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetLabel: 'web-1', details: { vaults: 1, environments: 0 } })
    expect(f.hosts.list().map((x) => x.id)).toEqual([h.id])
  })

  it('rejects bad input', async () => {
    const f = await makeInventory()
    f.hosts.create({ label: 'web-1', address: '10.0.0.5' })
    const bad = (input: Parameters<typeof f.hosts.create>[0], re: RegExp, leak: string): void => {
      let msg = ''
      try {
        f.hosts.create(input)
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toMatch(re)
      expect(msg).not.toContain(leak)
    }
    bad({ label: 'WEB-1', address: '10.0.0.6' }, /already exists/, '10.0.0.6')
    bad({ label: 'x', address: '-oProxyCommand=x' }, /address/, 'ProxyCommand')
    bad({ label: 'x', address: '10.0.0.7', port: 0 }, /port/, '10.0.0.7')
    bad(
      { label: 'x', address: '10.0.0.7', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) },
      /tags/,
      't16',
    )
    const ghost = randomUUID()
    bad({ label: 'x', address: '10.0.0.7', identityId: ghost }, /identity not found/, ghost)
    bad({ label: 'x', address: '10.0.0.7', vaultIds: [ghost] }, /vault not found/, ghost)
    bad({ label: 'x', address: '10.0.0.7', environments: [{ environmentId: ghost, role: 'app' }] }, /environment/, ghost)
    expect(f.hosts.list()).toHaveLength(1)
  })

  it('null means inherit', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'a', address: 'a.example.com' })
    expect(f.hosts.update(h.id, { port: 2222 }).port).toBe(2222)
    expect(f.hosts.update(h.id, { port: null }).port).toBeNull()
    const before = hostActions(f).length
    f.hosts.update(h.id, {})
    expect(hostActions(f)).toHaveLength(before)
    const id = f.makeIdentity()
    expect(f.hosts.update(h.id, { identityId: id.id }).identityId).toBe(id.id)
    expect(f.hosts.update(h.id, { identityId: null }).identityId).toBeNull()
  })

  it('jump rules', async () => {
    const f = await makeInventory()
    const a = f.hosts.create({ label: 'A', address: 'a.example.com' })
    const b = f.hosts.create({ label: 'B', address: 'b.example.com', jumpHostId: undefined })
    expect(() => f.hosts.update(a.id, { jumpHostId: a.id })).toThrow(/own jump host/)
    expect(() => f.hosts.update(a.id, { jumpHostId: randomUUID() })).toThrow(/jump host not found/)
    f.hosts.update(a.id, { jumpHostId: b.id })
    expect(() => f.hosts.update(b.id, { jumpHostId: a.id })).toThrow(/jump host loop: B → A → B/)
    expect(f.hosts.create({ label: 'C', address: 'c.example.com', jumpHostId: a.id }).jumpHostId).toBe(a.id)
  })

  it('finds a loop three hops long', async () => {
    const f = await makeInventory()
    const a = f.hosts.create({ label: 'A', address: 'a.example.com' })
    const b = f.hosts.create({ label: 'B', address: 'b.example.com', jumpHostId: a.id })
    const c = f.hosts.create({ label: 'C', address: 'c.example.com', jumpHostId: b.id })
    expect(() => f.hosts.update(a.id, { jumpHostId: c.id })).toThrow(/jump host loop: A → C → B → A/)
    expect(f.hosts.list().find((h) => h.id === a.id)!.jumpHostId).toBeNull()
  })

  it('unchanged tags are a no-op', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'a', address: 'a.example.com', tags: ['web', 'eu'] })
    const before = hostActions(f).length
    expect(f.hosts.update(h.id, { tags: ['web', 'eu'] }).updatedAt).toBe(h.updatedAt)
    expect(hostActions(f)).toHaveLength(before)
    expect(f.hosts.update(h.id, { tags: ['eu', 'web'] }).tags).toEqual(['eu', 'web'])
    expect(hostActions(f)).toHaveLength(before + 1)
  })

  it('refuses deleting a jump host', async () => {
    const f = await makeInventory()
    const a = f.hosts.create({ label: 'A', address: 'a.example.com' })
    const b = f.hosts.create({ label: 'B', address: 'b.example.com' })
    f.hosts.update(a.id, { jumpHostId: b.id })
    expect(() => f.hosts.delete(b.id)).toThrow(/jump host for A/)
    f.hosts.update(a.id, { jumpHostId: null })
    insertEnv(f, 'prod', b.id)
    expect(() => f.hosts.delete(b.id)).toThrow(/jump host for prod/)
  })

  it('deletes and audits the membership count', async () => {
    const f = await makeInventory()
    const env = insertEnv(f, 'prod')
    const h = f.hosts.create({ label: 'A', address: 'a.example.com', environments: [{ environmentId: env, role: 'db' }] })
    expect(h.environments).toEqual([{ environmentId: env, role: 'db' }])
    f.hosts.delete(h.id)
    expect(f.hosts.list()).toEqual([])
    expect(hostActions(f).at(-1)).toMatchObject({ action: 'host.delete', targetLabel: 'A', details: { environments: 1 } })
  })

  it('setVaults diffs', async () => {
    const f = await makeInventory()
    const other = f.vault.createVault({ name: 'Other', color: '#112233' })
    const h = f.hosts.create({ label: 'A', address: 'a.example.com' })
    const a = DEFAULT_VAULT_ID
    const b = other.id
    expect(f.hosts.setVaults(h.id, [a, b]).vaultIds.sort()).toEqual([a, b].sort())
    expect(f.hosts.setVaults(h.id, [b]).vaultIds).toEqual([b])
    expect(hostActions(f).at(-1)).toMatchObject({ action: 'host.vaults', details: { added: [], removed: [a] } })
    expect(() => f.hosts.setVaults(h.id, [randomUUID()])).toThrow(/vault not found/)
  })

  it('mutations need unlock', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'A', address: 'a.example.com' })
    f.vault.lock('manual')
    expect(() => f.hosts.create({ label: 'B', address: 'b.example.com' })).toThrow(VAULT_LOCKED)
    expect(() => f.hosts.update(h.id, { port: 1 })).toThrow(VAULT_LOCKED)
    expect(() => f.hosts.delete(h.id)).toThrow(VAULT_LOCKED)
    expect(() => f.hosts.setVaults(h.id, [])).toThrow(VAULT_LOCKED)
    expect(f.hosts.list()).toHaveLength(1)
  })

  it('audit never carries values', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'A', address: '10.9.9.9', notes: 'root pw hunter22' })
    f.hosts.update(h.id, { address: '10.9.9.10', notes: 'root pw hunter23' })
    const rows = auditRows(f.db)
    expect(rows).not.toContain('hunter22')
    expect(rows).not.toContain('hunter23')
    expect(rows).not.toContain('10.9.9.9')
    expect(rows).not.toContain('10.9.9.10')
  })
})

describe('host IPC', () => {
  it('rejects bad host args', async () => {
    const f = await makeInventory()
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(inventoryHandlers(f)),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const calls = Object.fromEntries([...registered]) as Record<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>
    for (const arg of [{ label: 'x', address: 'a b' }, { label: 'x', address: 'a.b', extra: 1 }]) {
      const err = await Promise.resolve(calls['host:create']!(ev, arg)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/invalid arguments/)
      expect((err as Error).message).not.toContain('a b')
    }
    const ok = (await calls['host:create']!(ev, { label: 'x', address: 'a.b', port: null })) as { label: string; id: string }
    expect(ok.label).toBe('x')

    const rejects = async (c: string, ...a: unknown[]): Promise<void> => {
      await expect(Promise.resolve(calls[c]!(ev, ...a))).rejects.toThrow(/invalid arguments/)
    }
    // Option-looking addresses would be read by ssh as a flag.
    await rejects('host:create', { label: 'y', address: '-oProxyCommand=x' })
    await rejects('host:update', ok.id, { address: '-oProxyCommand=x' })
    await rejects('host:update', 'not-a-uuid', { label: 'z' })
    await rejects('host:update', ok.id, { vaultIds: [] })
    await rejects('host:update', ok.id, { port: 0 })
    await rejects('host:delete', 'not-a-uuid')
    await rejects('host:setVaults', ok.id, 'v1')
    await rejects('host:setVaults', ok.id, ['not-a-uuid'])
    await expect(Promise.resolve(calls['host:delete']!(ev, randomUUID()))).rejects.toThrow(/host not found/)
  })
})
