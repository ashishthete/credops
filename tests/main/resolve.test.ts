import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { inheritConflicts, resolveHost } from '../../src/main/inventory/resolve'
import { MAX_JUMP_DEPTH } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { inventoryHandlers, makeInventory, type InventoryFixture } from './inventory-helpers'

const COLOR = '#336699'
const opts = { localUser: 'tester' }

async function setup() {
  const f = await makeInventory()
  const deploy = f.identities.create({ vaultId: DEFAULT_VAULT_ID, label: 'deploy', username: 'deploy', auth: 'agent' })
  const ops = f.identities.create({ vaultId: DEFAULT_VAULT_ID, label: 'ops', username: 'ops', auth: 'agent' })
  const prod = f.envs.create({ name: 'prod', color: COLOR, defaultPort: 2222, defaultIdentityId: deploy.id })
  const staging = f.envs.create({ name: 'staging', color: COLOR })
  return { f, deploy, ops, prod, staging }
}

const resolve = (f: InventoryFixture, hostId: string, envId?: string) => resolveHost(f.db, hostId, envId, opts)

describe('resolveHost', () => {
  it('host beats env beats global', async () => {
    const { f, deploy, prod } = await setup()
    const h = f.hosts.create({ label: 'H', address: '10.0.0.1', port: 2200, environments: [{ environmentId: prod.id, role: 'app' }] })
    const inProd = resolve(f, h.id, prod.id)
    expect(inProd).toMatchObject({ hostId: h.id, environmentId: prod.id, address: '10.0.0.1' })
    expect(inProd.port).toEqual({ value: 2200, source: 'host' })
    expect(inProd.identity).toEqual({
      source: 'environment',
      identityId: deploy.id,
      label: 'deploy',
      username: 'deploy',
      auth: 'agent',
      vaultId: DEFAULT_VAULT_ID,
    })
    expect(resolve(f, h.id).identity).toEqual({ source: 'global', username: 'tester', auth: 'default' })
    f.hosts.update(h.id, { port: null })
    expect(resolve(f, h.id, prod.id).port).toEqual({ value: 2222, source: 'environment' })
  })

  it("host's own identity beats the environment's", async () => {
    const { f, ops, prod } = await setup()
    const h = f.hosts.create({ label: 'H', address: 'h', identityId: ops.id, environments: [{ environmentId: prod.id, role: 'app' }] })
    expect(resolve(f, h.id, prod.id).identity).toMatchObject({ source: 'host', label: 'ops', username: 'ops' })
  })

  it('outside env skips step 2', async () => {
    const { f, prod } = await setup()
    const h = f.hosts.create({ label: 'H', address: 'h', environments: [{ environmentId: prod.id, role: 'app' }] })
    const r = resolve(f, h.id)
    expect(r.environmentId).toBeNull()
    expect(r.port).toEqual({ value: 22, source: 'global' })
    expect(r.jump).toEqual({ hostId: null, source: null })
    expect(r.chain).toEqual([])
  })

  it('not a member', async () => {
    const { f, prod, staging } = await setup()
    const h = f.hosts.create({ label: 'H', address: 'h', environments: [{ environmentId: prod.id, role: 'app' }] })
    expect(() => resolve(f, h.id, staging.id)).toThrow(/not in that environment/)
    expect(() => resolve(f, h.id, randomUUID())).toThrow(/not in that environment/)
    expect(() => resolve(f, randomUUID())).toThrow(/host not found/)
  })

  it('jump chain', async () => {
    const { f, ops } = await setup()
    const edge = f.hosts.create({ label: 'edge', address: 'edge.example', port: 2022, identityId: ops.id })
    const bastion = f.hosts.create({ label: 'bastion', address: 'bastion.example', jumpHostId: edge.id })
    const app = f.hosts.create({ label: 'App', address: 'app.internal', jumpHostId: bastion.id })
    const r = resolve(f, app.id)
    expect(r.jump).toEqual({ hostId: bastion.id, source: 'host' })
    expect(r.chain.map((h) => h.label)).toEqual(['edge', 'bastion'])
    expect(r.chain[0]).toMatchObject({
      hostId: edge.id,
      address: 'edge.example',
      port: 2022,
      identity: { source: 'host', identityId: ops.id, username: 'ops' },
    })
    expect(r.chain[1]).toEqual({
      hostId: bastion.id,
      label: 'bastion',
      address: 'bastion.example',
      port: 22,
      identity: { source: 'global', username: 'tester', auth: 'default' },
    })
  })

  it('hops take the context only when they are members', async () => {
    const { f, prod } = await setup()
    const outer = f.hosts.create({ label: 'outer', address: 'outer' })
    const inner = f.hosts.create({ label: 'inner', address: 'inner', jumpHostId: outer.id, environments: [{ environmentId: prod.id, role: 'bastion' }] })
    const app = f.hosts.create({ label: 'App', address: 'app', jumpHostId: inner.id, environments: [{ environmentId: prod.id, role: 'app' }] })
    const [o, i] = resolve(f, app.id, prod.id).chain
    expect(i).toMatchObject({ label: 'inner', port: 2222, identity: { source: 'environment', label: 'deploy' } })
    expect(o).toMatchObject({ label: 'outer', port: 22, identity: { source: 'global' } })
  })

  it('env default jump', async () => {
    const { f, prod } = await setup()
    const bastion = f.hosts.create({ label: 'bastion', address: 'b', environments: [{ environmentId: prod.id, role: 'bastion' }] })
    const h = f.hosts.create({ label: 'H', address: 'h', environments: [{ environmentId: prod.id, role: 'app' }] })
    f.envs.update(prod.id, { defaultJumpHostId: bastion.id })
    const r = resolve(f, h.id, prod.id)
    expect(r.jump).toEqual({ hostId: bastion.id, source: 'environment' })
    expect(r.chain.map((x) => x.hostId)).toEqual([bastion.id])
    expect(resolve(f, h.id).jump).toEqual({ hostId: null, source: null })
  })

  it('bastion never jumps through itself', async () => {
    const { f, prod } = await setup()
    const bastion = f.hosts.create({ label: 'bastion', address: 'b', environments: [{ environmentId: prod.id, role: 'bastion' }] })
    f.envs.update(prod.id, { defaultJumpHostId: bastion.id })
    const r = resolve(f, bastion.id, prod.id)
    expect(r.jump).toEqual({ hostId: null, source: null })
    expect(r.chain).toEqual([])
  })

  it('detects loops through env defaults', async () => {
    const { f, prod } = await setup()
    // F7: both A and B are in prod, so the error is the loop and not the membership check.
    const b = f.hosts.create({ label: 'B', address: 'b', environments: [{ environmentId: prod.id, role: 'bastion' }] })
    const a = f.hosts.create({ label: 'A', address: 'a', jumpHostId: b.id, environments: [{ environmentId: prod.id, role: 'app' }] })
    f.envs.update(prod.id, { defaultJumpHostId: a.id })
    expect(() => resolve(f, a.id, prod.id)).toThrow(/jump host loop: A → B → A$/)
    // Outside prod, B has no jump host and there is no loop.
    expect(resolve(f, a.id).chain.map((h) => h.label)).toEqual(['B'])
  })

  it('detects a 3-hop loop closed by an env default', async () => {
    const { f, prod } = await setup()
    const c = f.hosts.create({ label: 'C', address: 'c', environments: [{ environmentId: prod.id, role: 'bastion' }] })
    const b = f.hosts.create({ label: 'B', address: 'b', jumpHostId: c.id })
    const a = f.hosts.create({ label: 'A', address: 'a', jumpHostId: b.id, environments: [{ environmentId: prod.id, role: 'app' }] })
    f.envs.update(prod.id, { defaultJumpHostId: a.id })
    expect(() => resolve(f, a.id, prod.id)).toThrow(/jump host loop: A → B → C → A$/)
  })

  it('depth cap', async () => {
    const { f } = await setup()
    // h0 → h1 → ... → h9: resolving h0 needs 9 hops, h1 needs exactly MAX_JUMP_DEPTH.
    let jumpHostId: string | null = null
    const ids: string[] = []
    for (let i = 9; i >= 0; i--) {
      const h = f.hosts.create({ label: `h${i}`, address: `h${i}`, jumpHostId })
      ids.unshift(h.id)
      jumpHostId = h.id
    }
    expect(() => resolve(f, ids[0]!)).toThrow(/jump chain is longer than 8 hops/)
    const ok = resolve(f, ids[1]!)
    expect(ok.chain).toHaveLength(MAX_JUMP_DEPTH)
    expect(ok.chain.map((h) => h.label)).toEqual(['h9', 'h8', 'h7', 'h6', 'h5', 'h4', 'h3', 'h2'])
  })

  it('conflicts', async () => {
    const { f, ops, prod, staging } = await setup()
    f.envs.update(staging.id, { defaultIdentityId: ops.id, defaultPort: 2222 })
    const h = f.hosts.create({
      label: 'H',
      address: 'h',
      environments: [
        { environmentId: prod.id, role: 'app' },
        { environmentId: staging.id, role: 'app' },
      ],
    })
    const both = [prod.id, staging.id].sort()
    expect(inheritConflicts(f.db, h.id)).toEqual([{ field: 'identity', environmentIds: both }])
    // Reported whatever the context.
    expect(resolve(f, h.id).conflicts).toEqual([{ field: 'identity', environmentIds: both }])
    expect(resolve(f, h.id, staging.id).conflicts).toEqual([{ field: 'identity', environmentIds: both }])
    // null counts as a value: prod has a port, staging now has none.
    f.envs.update(staging.id, { defaultPort: null })
    expect(inheritConflicts(f.db, h.id)).toEqual([
      { field: 'identity', environmentIds: both },
      { field: 'port', environmentIds: both },
    ])
    f.hosts.update(h.id, { identityId: ops.id, port: 22 })
    expect(inheritConflicts(f.db, h.id)).toEqual([])
    const single = f.hosts.create({ label: 'S', address: 's', environments: [{ environmentId: prod.id, role: 'app' }] })
    expect(inheritConflicts(f.db, single.id)).toEqual([])
    expect(resolve(f, single.id, prod.id).conflicts).toEqual([])
  })

  it('jump host conflicts', async () => {
    const { f, prod, staging } = await setup()
    const b = f.hosts.create({ label: 'bastion', address: 'b' })
    f.envs.update(prod.id, { defaultJumpHostId: b.id })
    f.envs.update(staging.id, { defaultPort: 2222, defaultIdentityId: prod.defaultIdentityId })
    const h = f.hosts.create({
      label: 'H',
      address: 'h',
      environments: [
        { environmentId: prod.id, role: 'app' },
        { environmentId: staging.id, role: 'app' },
      ],
    })
    expect(inheritConflicts(f.db, h.id)).toEqual([{ field: 'jumpHost', environmentIds: [prod.id, staging.id].sort() }])
  })

  it('a default jump naming the host itself is no conflict', async () => {
    const { f, prod, staging } = await setup()
    f.envs.update(staging.id, { defaultPort: 2222, defaultIdentityId: prod.defaultIdentityId })
    const bastion = f.hosts.create({
      label: 'bastion',
      address: 'b',
      environments: [
        { environmentId: prod.id, role: 'bastion' },
        { environmentId: staging.id, role: 'bastion' },
      ],
    })
    f.envs.update(prod.id, { defaultJumpHostId: bastion.id })
    expect(inheritConflicts(f.db, bastion.id)).toEqual([])
  })

  it('no secrets', async () => {
    const { f, prod } = await setup()
    const pw = f.identities.create({ vaultId: DEFAULT_VAULT_ID, label: 'pw', username: 'root', auth: 'password', password: 'hunter2-secret' })
    f.envs.update(prod.id, { defaultIdentityId: pw.id })
    const bastion = f.hosts.create({ label: 'bastion', address: 'b', identityId: pw.id })
    const h = f.hosts.create({ label: 'H', address: 'h', jumpHostId: bastion.id, environments: [{ environmentId: prod.id, role: 'app' }] })
    const sealed = (f.db.prepare('SELECT password_enc FROM identities WHERE id = ?').get(pw.id) as { password_enc: string }).password_enc
    expect(sealed.length).toBeGreaterThan(0)
    const r = resolve(f, h.id, prod.id)
    expect(r.identity).toMatchObject({ source: 'environment', auth: 'password' })
    expect(r.chain[0]!.identity).toMatchObject({ source: 'host', auth: 'password' })
    const json = JSON.stringify(r)
    expect(json).not.toContain(sealed)
    expect(json).not.toContain('hunter2-secret')
  })

  it('works while locked', async () => {
    const { f, prod } = await setup()
    const h = f.hosts.create({ label: 'H', address: 'h', environments: [{ environmentId: prod.id, role: 'app' }] })
    f.vault.lock('manual')
    expect(resolve(f, h.id, prod.id).identity).toMatchObject({ source: 'environment', label: 'deploy' })
  })
})

describe('host:resolve IPC', () => {
  it('validates args and resolves', async () => {
    const { f, prod } = await setup()
    const h = f.hosts.create({ label: 'H', address: 'h', environments: [{ environmentId: prod.id, role: 'app' }] })
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(inventoryHandlers(f)),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    await expect(call('host:resolve', 'not-a-uuid')).rejects.toThrow(/invalid arguments/)
    await expect(call('host:resolve', h.id, 'nope')).rejects.toThrow(/invalid arguments/)
    const r = (await call('host:resolve', h.id, prod.id)) as { port: unknown }
    expect(r.port).toEqual({ value: 2222, source: 'environment' })
    const outside = (await call('host:resolve', h.id)) as { port: unknown }
    expect(outside.port).toEqual({ value: 22, source: 'global' })
  })
})
