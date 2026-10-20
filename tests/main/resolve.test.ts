import { describe, expect, it, onTestFinished } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { inheritConflicts, resolveHost } from '../../src/main/inventory/resolve'
import { readSshConfigMatch } from '../../src/main/inventory/ssh-config'
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
      addressSource: 'host',
      port: 2022,
      identity: { source: 'host', identityId: ops.id, username: 'ops' },
    })
    expect(r.chain[1]).toEqual({
      hostId: bastion.id,
      label: 'bastion',
      address: 'bastion.example',
      addressSource: 'host',
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

describe('resolveHost with ~/.ssh/config', () => {
  it('a global identity takes User from the matching block and says so', async () => {
    const { f, deploy } = await setup()
    const alpha = f.hosts.create({ label: 'alpha', address: '203.0.113.23' })
    const seen: unknown[] = []
    const sshConfig = (t: { label: string; address: string }) => {
      seen.push(t)
      return t.label === 'alpha' ? { user: 'ubuntu', identityFiles: [] } : null
    }
    const r = resolveHost(f.db, alpha.id, undefined, { localUser: 'tester', sshConfig })
    expect(r.identity).toEqual({ source: 'global', username: 'ubuntu', auth: 'default', userSource: 'ssh-config' })
    expect(seen).toEqual([{ label: 'alpha', address: '203.0.113.23' }])

    // No match, or a match without User: the local user, with no ssh-config source.
    const other = f.hosts.create({ label: 'other', address: '10.0.0.2' })
    expect(resolveHost(f.db, other.id, undefined, { localUser: 'tester', sshConfig }).identity).toEqual({
      source: 'global', username: 'tester', auth: 'default',
    })
    const noUser = () => ({ user: null, identityFiles: ['/x'] })
    expect(resolveHost(f.db, alpha.id, undefined, { localUser: 'tester', sshConfig: noUser }).identity).toEqual({
      source: 'global', username: 'tester', auth: 'default',
    })

    // An OpsDeck identity always wins over the config.
    f.hosts.update(alpha.id, { identityId: deploy.id })
    expect(resolveHost(f.db, alpha.id, undefined, { localUser: 'tester', sshConfig }).identity).toMatchObject({ source: 'host', username: 'deploy' })
  })

  it('jump hops look up their own block', async () => {
    const { f } = await setup()
    const bastion = f.hosts.create({ label: 'bastion', address: 'b.example.com' })
    const h = f.hosts.create({ label: 'inner', address: '10.0.0.9', jumpHostId: bastion.id })
    const sshConfig = (t: { label: string }) => ({ user: `${t.label}-user`, identityFiles: [] })
    const r = resolveHost(f.db, h.id, undefined, { localUser: 'tester', sshConfig })
    expect(r.identity.username).toBe('inner-user')
    expect(r.chain[0].identity).toEqual({ source: 'global', username: 'bastion-user', auth: 'default', userSource: 'ssh-config' })
  })

  it('reads a fixture config from a tmp home', async () => {
    const { f } = await setup()
    const home = mkdtempSync(join(tmpdir(), 'opsdeck-resolve-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'config'), 'Host alpha\n  HostName 203.0.113.23\n  User ubuntu\n')
    const sshConfig = readSshConfigMatch({ configPath: join(home, '.ssh', 'config'), home, sshDir: join(home, '.ssh') })
    const byAddress = f.hosts.create({ label: 'Alpha prod', address: '203.0.113.23' })
    expect(resolveHost(f.db, byAddress.id, undefined, { localUser: 'tester', sshConfig }).identity.username).toBe('ubuntu')
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

describe('resolveHost: environment domain', () => {
  async function withDomain(domain: string | null, address = 'db') {
    const { f, staging, prod } = await setup()
    f.envs.update(staging.id, { domain })
    const h = f.hosts.create({ label: 'DB', address, environments: [{ environmentId: staging.id, role: 'db' }, { environmentId: prod.id, role: 'db' }] })
    return { f, staging, prod, h }
  }

  it("a bare name takes the environment's domain only in its context", async () => {
    const { f, staging, prod, h } = await withDomain('staging.example.com')
    expect(resolve(f, h.id, staging.id)).toMatchObject({ address: 'db.staging.example.com', addressSource: 'domain' })
    expect(resolve(f, h.id)).toMatchObject({ address: 'db', addressSource: 'host' })
    expect(resolve(f, h.id, prod.id)).toMatchObject({ address: 'db', addressSource: 'host' })
  })

  it('a URL domain contributes its hostname', async () => {
    const { f, staging, h } = await withDomain('https://Staging.Example.com:8443/app')
    expect(resolve(f, h.id, staging.id).address).toBe('db.staging.example.com')
  })

  it('trailing dot and uppercase in the domain', async () => {
    const { f, staging, h } = await withDomain('Staging.Example.COM.')
    expect(resolve(f, h.id, staging.id).address).toBe('db.staging.example.com')
  })

  it('dotted, IP and localhost addresses are untouched', async () => {
    for (const address of ['db.internal', '10.0.0.5', '::1', 'fe80::1%en0', 'localhost', '10']) {
      const { f, staging, h } = await withDomain('staging.example.com', address)
      expect(resolve(f, h.id, staging.id), address).toMatchObject({ address, addressSource: 'host' })
    }
  })

  it('an IP-literal domain never expands', async () => {
    for (const domain of ['https://10.0.0.5:8080', 'https://[::1]/']) {
      const { f, staging, h } = await withDomain(domain)
      expect(resolve(f, h.id, staging.id)).toMatchObject({ address: 'db', addressSource: 'host' })
    }
  })

  it('hops expand only when they take the context', async () => {
    const { f, staging } = await withDomain('staging.example.com')
    const bastion = f.hosts.create({ label: 'bastion', address: 'bastion', environments: [{ environmentId: staging.id, role: 'bastion' }] })
    const edge = f.hosts.create({ label: 'edge', address: 'edge' })
    const viaBastion = f.hosts.create({ label: 'app', address: 'app', jumpHostId: bastion.id, environments: [{ environmentId: staging.id, role: 'app' }] })
    const viaEdge = f.hosts.create({ label: 'app2', address: 'app2', jumpHostId: edge.id, environments: [{ environmentId: staging.id, role: 'app' }] })
    expect(resolve(f, viaBastion.id, staging.id).chain[0]).toMatchObject({ address: 'bastion.staging.example.com', addressSource: 'domain' })
    expect(resolve(f, viaEdge.id, staging.id).chain[0]).toMatchObject({ address: 'edge', addressSource: 'host' })
  })

  it('an expansion over 253 characters is refused', async () => {
    const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(11)].join('.') // 203 chars
    const { f, staging, h } = await withDomain(domain, 'x'.repeat(63))
    expect(() => resolve(f, h.id, staging.id)).toThrow("DB with staging's domain is longer than 253 characters")
  })

  it('a stored domain that no longer validates is ignored', async () => {
    const { f, staging, h } = await withDomain(null)
    f.db.prepare('UPDATE environments SET domain = ? WHERE id = ?').run('ftp://x.example.com', staging.id)
    expect(resolve(f, h.id, staging.id)).toMatchObject({ address: 'db', addressSource: 'host' })
  })
})
