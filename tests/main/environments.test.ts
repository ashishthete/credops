import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { createInventoryHandlers } from '../../src/main/ipc/handlers/inventory'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { makeInventory, type InventoryFixture } from './inventory-helpers'

const COLOR = '#336699'
const prod = (f: InventoryFixture, name: string) => f.products.create({ name, color: COLOR, icon: 'boxes' })
const actions = (f: InventoryFixture, action: string) =>
  f.audit
    .list({ limit: 1000 })
    .reverse()
    .filter((e) => e.action === action)

describe('EnvironmentStore and ProductStore', () => {
  it('shared environment across products', async () => {
    const f = await makeInventory()
    const a = prod(f, 'Acme')
    const b = prod(f, 'Essentials')
    const env = f.envs.create({ name: 'analytics-db', color: COLOR, productIds: [a.id, b.id] })
    expect(f.products.list().map((p) => p.environmentIds)).toEqual([[env.id], [env.id]])
    f.products.delete(a.id)
    expect(f.envs.list()[0]!.productIds).toEqual([b.id])
    expect(actions(f, 'product.delete')[0]!.details).toEqual({ environments: 1 })
  })

  it('environments left without a product stay listed', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const env = f.envs.create({ name: 'prod', color: COLOR, productIds: [a.id] })
    f.products.delete(a.id)
    expect(f.envs.list()).toEqual([expect.objectContaining({ id: env.id, productIds: [] })])
  })

  it('per-product unique names', async () => {
    const f = await makeInventory()
    const a = prod(f, 'Acme')
    const b = prod(f, 'Essentials')
    f.envs.create({ name: 'prod', color: COLOR, productIds: [a.id] })
    const prodB = f.envs.create({ name: 'prod', color: COLOR, productIds: [b.id] })
    expect(() => f.envs.setProducts(prodB.id, [a.id, b.id])).toThrow(/product Acme already has an environment named prod/)
    const staging = f.envs.create({ name: 'staging', color: COLOR, productIds: [a.id] })
    expect(() => f.envs.update(staging.id, { name: 'PROD' })).toThrow(/product Acme already has an environment named prod/)
    expect(() => f.envs.create({ name: 'Prod', color: COLOR, productIds: [a.id] })).toThrow(/already has an environment/)
    expect(f.envs.list()).toHaveLength(3)
    expect(f.envs.update(staging.id, { name: 'Staging' }).name).toBe('Staging')
  })

  it('product names are unique', async () => {
    const f = await makeInventory()
    prod(f, 'Acme')
    expect(() => prod(f, 'acme')).toThrow(/already exists/)
    const other = prod(f, 'Other')
    expect(() => f.products.update(other.id, { name: 'ACME' })).toThrow(/already exists/)
    const withRepo = f.products.update(other.id, { repoUrl: 'https://git.example.com/x' })
    expect(withRepo.repoUrl).toBe('https://git.example.com/x')
    expect(f.products.update(other.id, { repoUrl: null }).repoUrl).toBeNull()
    expect(() => f.products.update(other.id, { repoUrl: 'javascript:alert(1)' })).toThrow(/repository URL/)
  })

  it('shared links are independent', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ name: 'prod', color: COLOR })
    const s = f.envs.create({ name: 'staging', color: COLOR })
    f.envs.putHost(p.id, h.id, 'db')
    f.envs.putHost(s.id, h.id, 'app')
    f.envs.removeHost(s.id, h.id)
    expect(f.hosts.list()[0]!.environments).toEqual([{ environmentId: p.id, role: 'db' }])
    expect(() => f.envs.removeHost(s.id, h.id)).toThrow(/host is not in this environment/)
  })

  it('role changes are audited once', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ name: 'prod', color: COLOR })
    f.envs.putHost(p.id, h.id, 'db')
    f.envs.putHost(p.id, h.id, 'db')
    expect(actions(f, 'environment.host')).toHaveLength(1)
    f.envs.putHost(p.id, h.id, 'bastion')
    const rows = actions(f, 'environment.host')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.details).toEqual({ op: 'add', hostId: h.id, role: 'db' })
    expect(rows[1]!.details).toEqual({ op: 'role', hostId: h.id, role: 'bastion', from: 'db' })
    f.envs.removeHost(p.id, h.id)
    expect(actions(f, 'environment.host')[2]!.details).toEqual({ op: 'remove', hostId: h.id })
  })

  it('defaults validate', async () => {
    const f = await makeInventory()
    expect(() => f.envs.create({ name: 'e', color: COLOR, defaultJumpHostId: randomUUID() })).toThrow(/host not found/)
    expect(() => f.envs.create({ name: 'e', color: COLOR, defaultIdentityId: randomUUID() })).toThrow(/identity not found/)
    expect(() => f.envs.create({ name: 'e', color: COLOR, defaultPort: 70000 })).toThrow(/port/)
    const id = f.makeIdentity()
    const h = f.hosts.create({ label: 'J', address: 'j.example.com' })
    const e = f.envs.create({ name: 'e', color: COLOR, defaultIdentityId: id.id, defaultPort: 2200, defaultJumpHostId: h.id })
    expect(e).toMatchObject({ defaultIdentityId: id.id, defaultPort: 2200, defaultJumpHostId: h.id })
    expect(f.envs.update(e.id, { defaultPort: null, defaultJumpHostId: null }))
      .toMatchObject({ defaultPort: null, defaultJumpHostId: null, defaultIdentityId: id.id })
    expect(f.envs.list()).toHaveLength(1)
  })

  it('delete keeps hosts', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const h = f.hosts.create({ label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ name: 'prod', color: COLOR, productIds: [a.id] })
    const s = f.envs.create({ name: 'staging', color: COLOR })
    f.envs.putHost(p.id, h.id, 'db')
    f.envs.putHost(s.id, h.id, 'app')
    f.envs.delete(p.id)
    expect(f.hosts.list()[0]!.environments).toEqual([{ environmentId: s.id, role: 'app' }])
    expect(actions(f, 'environment.delete')[0]!.details).toEqual({ hosts: 1, products: 1 })
    expect(f.products.list()[0]!.environmentIds).toEqual([])
  })

  it('setProducts audits the difference', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const b = prod(f, 'B')
    const e = f.envs.create({ name: 'prod', color: COLOR, productIds: [a.id] })
    f.envs.setProducts(e.id, [a.id])
    expect(actions(f, 'environment.products')).toHaveLength(0)
    f.envs.setProducts(e.id, [b.id])
    expect(actions(f, 'environment.products')[0]!.details).toEqual({ added: [b.id], removed: [a.id] })
    expect(() => f.envs.setProducts(e.id, [randomUUID()])).toThrow(/product not found/)
  })

  it('locked writes refused, reads fine', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const e = f.envs.create({ name: 'prod', color: COLOR })
    f.vault.lock('manual')
    expect(() => f.envs.create({ name: 'x', color: COLOR })).toThrow(VAULT_LOCKED)
    expect(() => f.products.create({ name: 'x', color: COLOR, icon: 'leaf' })).toThrow(VAULT_LOCKED)
    expect(() => f.envs.update(e.id, { name: 'y' })).toThrow(VAULT_LOCKED)
    expect(() => f.envs.delete(e.id)).toThrow(VAULT_LOCKED)
    expect(() => f.envs.setProducts(e.id, [a.id])).toThrow(VAULT_LOCKED)
    expect(() => f.envs.putHost(e.id, randomUUID(), 'app')).toThrow(VAULT_LOCKED)
    expect(() => f.envs.removeHost(e.id, randomUUID())).toThrow(VAULT_LOCKED)
    expect(() => f.products.update(a.id, { name: 'z' })).toThrow(VAULT_LOCKED)
    expect(() => f.products.delete(a.id)).toThrow(VAULT_LOCKED)
    expect(f.envs.list()).toHaveLength(1)
    expect(f.products.list()).toHaveLength(1)
  })
})

describe('environment and product IPC', () => {
  it('rejects bad args at the boundary', async () => {
    const f = await makeInventory()
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(createInventoryHandlers({ hosts: f.hosts, environments: f.envs, products: f.products })),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    const rejects = async (c: string, ...a: unknown[]): Promise<void> => {
      await expect(call(c, ...a)).rejects.toThrow(/invalid arguments/)
    }
    await rejects('env:create', { name: 'e', color: COLOR, defaultPort: 70000 })
    await rejects('env:create', { name: 'e', color: 'red' })
    await rejects('env:create', { name: 'e', color: COLOR, extra: 1 })
    await rejects('env:update', randomUUID(), { productIds: [] })
    await rejects('env:putHost', randomUUID(), randomUUID(), 'root')
    await rejects('product:create', { name: 'p', color: COLOR, icon: 'skull' })
    await rejects('product:create', { name: 'p', color: COLOR, icon: 'leaf', repoUrl: 'javascript:x' })
    const ok = (await call('env:create', { name: 'e', color: COLOR, defaultPort: null })) as { name: string }
    expect(ok.name).toBe('e')
    const p = (await call('product:create', { name: 'p', color: COLOR, icon: 'leaf', repoUrl: null })) as { repoUrl: null }
    expect(p.repoUrl).toBeNull()
  })
})
