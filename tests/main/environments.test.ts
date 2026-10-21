import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { inventoryHandlers, makeInventory, type InventoryFixture, PRODUCT, REGION } from './inventory-helpers'

const COLOR = '#336699'
const prod = (f: InventoryFixture, name: string) => f.products.create({ name, color: COLOR, icon: 'boxes' })
const actions = (f: InventoryFixture, action: string) =>
  f.audit
    .list({ limit: 1000 })
    .reverse()
    .filter((e) => e.action === action)

describe('EnvironmentStore and ProductStore', () => {
  it('domain round-trips as entered and clears', async () => {
    const f = await makeInventory()
    const e = f.envs.create({ productId: PRODUCT, name: 'staging', color: COLOR, domain: 'Staging.Example.com' })
    expect(e.domain).toBe('Staging.Example.com')
    expect(f.envs.create({ productId: PRODUCT, name: 'plain', color: COLOR }).domain).toBeNull()
    expect(f.envs.update(e.id, { domain: 'https://staging.example.com/app' }).domain).toBe('https://staging.example.com/app')
    expect(f.envs.update(e.id, {}).domain).toBe('https://staging.example.com/app')
    expect(f.envs.update(e.id, { domain: null }).domain).toBeNull()
    f.envs.update(e.id, { domain: 'a.example.com' })
    expect(f.envs.update(e.id, { domain: '   ' }).domain).toBeNull()
    expect(f.envs.get(e.id).domain).toBeNull()
    const updates = actions(f, 'environment.update')
    expect(updates[0]!.details).toEqual({ fields: ['domain'] })
    expect(JSON.stringify(updates)).not.toContain('example.com')
  })

  it('domain is validated in the store', async () => {
    const f = await makeInventory()
    const e = f.envs.create({ productId: PRODUCT, name: 'staging', color: COLOR })
    const events = f.audit.list({ limit: 1000 }).length
    const bad: [string, string][] = [
      ['ftp://x.example.com', 'Use an http:// or https:// URL'],
      ['https://u:p@x.example.com', 'Leave the login out of the URL'],
      ['a'.repeat(254), 'A domain is at most 253 characters'],
    ]
    for (const [domain, message] of bad) {
      expect(() => f.envs.update(e.id, { domain })).toThrow(message)
    }
    expect(() => f.envs.create({ productId: PRODUCT, name: 'other', color: COLOR, domain: 'ftp://x.example.com' })).toThrow('Use an http:// or https:// URL')
    expect(f.envs.list().map((x) => x.name)).toEqual(['staging'])
    expect(f.envs.get(e.id).domain).toBeNull()
    expect(f.audit.list({ limit: 1000 }).length).toBe(events)
  })

  it('an environment is in exactly one product', async () => {
    const f = await makeInventory()
    const a = prod(f, 'Acme')
    const env = f.envs.create({ name: 'analytics-db', color: COLOR, productId: a.id })
    expect(env.productId).toBe(a.id)
    expect(f.products.list().find((p) => p.id === a.id)!.environmentIds).toEqual([env.id])
    expect(actions(f, 'environment.create')[0]!.details).toEqual({ productId: a.id })
    expect(() => f.envs.create({ name: 'x', color: COLOR, productId: '' })).toThrow('an environment needs a product')
    expect(() => f.envs.create({ name: 'x', color: COLOR, productId: randomUUID() })).toThrow('product not found')
  })

  it('a product with environments cannot be deleted', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const env = f.envs.create({ name: 'prod', color: COLOR, productId: a.id })
    f.envs.create({ name: 'staging', color: COLOR, productId: a.id })
    expect(() => f.products.delete(a.id)).toThrow('A still has 2 environments: move or delete them first')
    f.envs.delete(env.id)
    expect(() => f.products.delete(a.id)).toThrow('A still has an environment: move or delete it first')
    expect(actions(f, 'product.delete')).toHaveLength(0)
    const empty = prod(f, 'Empty')
    f.products.delete(empty.id)
    expect(actions(f, 'product.delete')).toHaveLength(1)
  })

  it('per-product unique names', async () => {
    const f = await makeInventory()
    const a = prod(f, 'Acme')
    const b = prod(f, 'Essentials')
    f.envs.create({ name: 'prod', color: COLOR, productId: a.id })
    const prodB = f.envs.create({ name: 'prod', color: COLOR, productId: b.id })
    expect(() => f.envs.setProduct(prodB.id, a.id)).toThrow(/product Acme already has an environment named prod/)
    const staging = f.envs.create({ name: 'staging', color: COLOR, productId: a.id })
    expect(() => f.envs.update(staging.id, { name: 'PROD' })).toThrow(/product Acme already has an environment named prod/)
    expect(() => f.envs.create({ name: 'Prod', color: COLOR, productId: a.id })).toThrow(/already has an environment/)
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
    const h = f.hosts.create({ regionId: REGION, label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ productId: PRODUCT, name: 'prod', color: COLOR })
    const s = f.envs.create({ productId: PRODUCT, name: 'staging', color: COLOR })
    f.envs.putHost(p.id, h.id, 'db')
    f.envs.putHost(s.id, h.id, 'app')
    f.envs.removeHost(s.id, h.id)
    expect(f.hosts.list()[0]!.environments).toEqual([{ environmentId: p.id, role: 'db' }])
    expect(() => f.envs.removeHost(s.id, h.id)).toThrow(/host is not in this environment/)
  })

  it('role changes are audited once', async () => {
    const f = await makeInventory()
    const h = f.hosts.create({ regionId: REGION, label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ productId: PRODUCT, name: 'prod', color: COLOR })
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
    expect(() => f.envs.create({ productId: PRODUCT, name: 'e', color: COLOR, defaultJumpHostId: randomUUID() })).toThrow(/host not found/)
    expect(() => f.envs.create({ productId: PRODUCT, name: 'e', color: COLOR, defaultIdentityId: randomUUID() })).toThrow(/identity not found/)
    expect(() => f.envs.create({ productId: PRODUCT, name: 'e', color: COLOR, defaultPort: 70000 })).toThrow(/port/)
    const id = f.makeIdentity()
    const h = f.hosts.create({ regionId: REGION, label: 'J', address: 'j.example.com' })
    const e = f.envs.create({ productId: PRODUCT, name: 'e', color: COLOR, defaultIdentityId: id.id, defaultPort: 2200, defaultJumpHostId: h.id })
    expect(e).toMatchObject({ defaultIdentityId: id.id, defaultPort: 2200, defaultJumpHostId: h.id })
    expect(f.envs.update(e.id, { defaultPort: null, defaultJumpHostId: null }))
      .toMatchObject({ defaultPort: null, defaultJumpHostId: null, defaultIdentityId: id.id })
    expect(f.envs.list()).toHaveLength(1)
  })

  it('delete keeps hosts', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const h = f.hosts.create({ regionId: REGION, label: 'H', address: 'h.example.com' })
    const p = f.envs.create({ name: 'prod', color: COLOR, productId: a.id })
    const s = f.envs.create({ productId: PRODUCT, name: 'staging', color: COLOR })
    f.envs.putHost(p.id, h.id, 'db')
    f.envs.putHost(s.id, h.id, 'app')
    f.envs.delete(p.id)
    expect(f.hosts.list()[0]!.environments).toEqual([{ environmentId: s.id, role: 'app' }])
    expect(actions(f, 'environment.delete')[0]!.details).toEqual({ hosts: 1, productId: a.id })
    expect(f.products.list().find((x) => x.id === a.id)!.environmentIds).toEqual([])
  })

  it('setProduct moves the environment and audits from and to', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const b = prod(f, 'B')
    const e = f.envs.create({ name: 'prod', color: COLOR, productId: a.id })
    f.envs.setProduct(e.id, a.id)
    expect(actions(f, 'environment.product')).toHaveLength(0)
    expect(f.envs.setProduct(e.id, b.id).productId).toBe(b.id)
    expect(actions(f, 'environment.product')[0]!.details).toEqual({ from: a.id, to: b.id })
    expect(() => f.envs.setProduct(e.id, randomUUID())).toThrow(/product not found/)
  })

  it('setProduct is refused while the environment is published to the Hub', async () => {
    const f = await makeInventory()
    const b = prod(f, 'B')
    const e = f.envs.create({ name: 'prod', color: COLOR, productId: PRODUCT })
    f.db.prepare("INSERT INTO hub_env_links(environment_id, hub_id, published_at, manifest_hash) VALUES (?, 'hub-env', 'now', 'h')").run(e.id)
    expect(() => f.envs.setProduct(e.id, b.id)).toThrow('this environment is published to the Hub: unpublish it, move it, then publish it again')
    expect(f.envs.get(e.id).productId).toBe(PRODUCT)
    expect(actions(f, 'environment.product')).toHaveLength(0)
  })

  it('locked writes refused, reads fine', async () => {
    const f = await makeInventory()
    const a = prod(f, 'A')
    const e = f.envs.create({ productId: PRODUCT, name: 'prod', color: COLOR })
    f.vault.lock('manual')
    expect(() => f.envs.create({ productId: PRODUCT, name: 'x', color: COLOR })).toThrow(VAULT_LOCKED)
    expect(() => f.products.create({ name: 'x', color: COLOR, icon: 'leaf' })).toThrow(VAULT_LOCKED)
    expect(() => f.envs.update(e.id, { name: 'y' })).toThrow(VAULT_LOCKED)
    expect(() => f.envs.delete(e.id)).toThrow(VAULT_LOCKED)
    expect(() => f.envs.setProduct(e.id, a.id)).toThrow(VAULT_LOCKED)
    expect(() => f.envs.putHost(e.id, randomUUID(), 'app')).toThrow(VAULT_LOCKED)
    expect(() => f.envs.removeHost(e.id, randomUUID())).toThrow(VAULT_LOCKED)
    expect(() => f.products.update(a.id, { name: 'z' })).toThrow(VAULT_LOCKED)
    expect(() => f.products.delete(a.id)).toThrow(VAULT_LOCKED)
    expect(f.envs.list()).toHaveLength(1)
    expect(f.products.list()).toHaveLength(2)
  })
})

describe('environment and product IPC', () => {
  it('rejects bad args at the boundary', async () => {
    const f = await makeInventory()
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(inventoryHandlers(f)),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    const rejects = async (c: string, ...a: unknown[]): Promise<void> => {
      await expect(call(c, ...a)).rejects.toThrow(/invalid arguments/)
    }
    await rejects('env:create', { name: 'e', color: COLOR, productId: PRODUCT, defaultPort: 70000 })
    await rejects('env:create', { name: 'e', color: 'red', productId: PRODUCT })
    await rejects('env:create', { name: 'e', color: COLOR, productId: PRODUCT, extra: 1 })
    await rejects('env:create', { name: 'e', color: COLOR })
    await rejects('env:update', randomUUID(), { productIds: [] })
    await rejects('env:update', randomUUID(), { productId: PRODUCT })
    await rejects('env:setProduct', randomUUID(), 'nope')
    await rejects('env:putHost', randomUUID(), randomUUID(), 'root')
    await rejects('product:create', { name: 'p', color: COLOR, icon: 'skull' })
    await rejects('product:create', { name: 'p', color: COLOR, icon: 'leaf', repoUrl: 'javascript:x' })
    const ok = (await call('env:create', { name: 'e', color: COLOR, productId: PRODUCT, defaultPort: null })) as { name: string }
    expect(ok.name).toBe('e')
    const missing = randomUUID()
    for (const [c, ...a] of [
      ['env:update', missing, { name: 'x' }],
      ['env:delete', missing],
      ['env:setProduct', missing, PRODUCT],
      ['env:putHost', missing, randomUUID(), 'app'],
      ['env:removeHost', missing, randomUUID()],
    ] as [string, ...unknown[]][]) {
      await expect(call(c, ...a)).rejects.toThrow(/environment not found/)
    }
    const p = (await call('product:create', { name: 'p', color: COLOR, icon: 'leaf', repoUrl: null })) as { repoUrl: null }
    expect(p.repoUrl).toBeNull()
  })

  async function openSetup(domain: string | null, raw = false) {
    const f = await makeInventory()
    const openExternal = vi.fn(async (_url: string) => {})
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(inventoryHandlers(f, openExternal)),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    const env = f.envs.create({ productId: PRODUCT, name: 'staging', color: COLOR, domain: raw ? null : domain })
    if (raw) f.db.prepare('UPDATE environments SET domain = ? WHERE id = ?').run(domain, env.id)
    return { f, env, openExternal, call }
  }

  it('rejects a bad domain at the boundary', async () => {
    const { call, env } = await openSetup(null)
    const err = await call('env:create', { name: 'e', color: COLOR, productId: PRODUCT, domain: 'ftp://x.example.com' }).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/invalid arguments/)
    expect((err as Error).message).toContain('domain')
    expect((err as Error).message).not.toContain('ftp')
    await expect(call('env:update', env.id, { domain: 42 })).rejects.toThrow(/invalid arguments.*domain/)
  })

  it('env:openDomain opens only a re-validated http(s) URL', async () => {
    const a = await openSetup('staging.example.com')
    await a.call('env:openDomain', a.env.id)
    expect(a.openExternal).toHaveBeenCalledTimes(1)
    expect(a.openExternal).toHaveBeenCalledWith('https://staging.example.com')
    const b = await openSetup('https://staging.example.com/app')
    await b.call('env:openDomain', b.env.id)
    expect(b.openExternal).toHaveBeenCalledWith('https://staging.example.com/app')
    const none = await openSetup(null)
    await expect(none.call('env:openDomain', none.env.id)).rejects.toThrow('This environment has no domain or URL')
    expect(none.openExternal).not.toHaveBeenCalled()
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@evil.example.com', 'ftp://evil.example.com']) {
      const c = await openSetup(bad, true)
      await expect(c.call('env:openDomain', c.env.id)).rejects.toThrow("This environment's domain or URL can't be opened")
      expect(c.openExternal).not.toHaveBeenCalled()
    }
  })

  it('env:openDomain never opens a value the renderer passed', async () => {
    const { call, env, openExternal } = await openSetup('https://staging.example.com')
    await expect(call('env:openDomain', 'https://evil.example.com')).rejects.toThrow(/invalid arguments/)
    expect(openExternal).not.toHaveBeenCalled()
    await call('env:openDomain', env.id, 'https://evil.example.com')
    expect(openExternal).toHaveBeenCalledTimes(1)
    // The parsed href of the stored value, never the renderer's.
    expect(openExternal).toHaveBeenCalledWith('https://staging.example.com/')
  })

  it('env:openDomain works while locked', async () => {
    const { f, env, openExternal, call } = await openSetup('staging.example.com')
    f.vault.lock('manual')
    await call('env:openDomain', env.id)
    expect(openExternal).toHaveBeenCalledWith('https://staging.example.com')
  })
})
