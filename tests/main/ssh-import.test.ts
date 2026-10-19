import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { createSshImportHandlers } from '../../src/main/ipc/handlers/ssh-import'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { generateEd25519 } from '../../src/main/vault/openssh'
import { MAX_IMPORT_ALIASES } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { makeImporter, makeInventory, type InventoryFixture } from './inventory-helpers'
import { auditRows } from './vault-helpers'

const FIX = join(__dirname, '../fixtures/ssh')
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8')

/** A fixture home whose `.ssh/config` is `text`, plus a fresh unencrypted `id_ed25519`. */
async function withConfig(text: string): Promise<InventoryFixture & { privateKey: string }> {
  const f = await makeInventory()
  writeFileSync(join(f.sshDir, 'config'), text)
  const { privateKey } = generateEd25519('imported@box')
  writeFileSync(join(f.sshDir, 'id_ed25519'), privateKey, { mode: 0o600 })
  return { ...f, privateKey }
}

const prodEnv = (f: InventoryFixture) => f.envs.create({ name: 'prod', color: '#cc3333' }).id

const counts = (f: InventoryFixture) =>
  Object.fromEntries(
    ['hosts', 'ssh_keys', 'identities', 'environment_hosts', 'host_vaults'].map((t) => [
      t,
      (f.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  )

const actions = (f: InventoryFixture) =>
  f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => e.action)

describe('SshImporter.preview', () => {
  it('lists candidates while locked', async () => {
    const f = await withConfig(fixture('basic.conf'))
    f.vault.lock('manual')
    const p = await makeImporter(f).preview()
    expect(p.found).toBe(true)
    expect(p.path).toBe(join(f.sshDir, 'config'))
    expect(p.candidates.map((c) => c.alias)).toEqual(['web-1', 'db-1', 'bastion'])
    expect(p.candidates.every((c) => c.valid && c.existingHostId === null)).toBe(true)
    const db1 = p.candidates.find((c) => c.alias === 'db-1')!
    expect(db1.jumpResolvable).toBe(true)
    expect(db1.warnings).toContain('1 port forward will become tunnel')
    expect(p.candidates.find((c) => c.alias === 'web-1')!.warnings).toContain('2 port forwards will become tunnels')
    expect(p.candidates.find((c) => c.alias === 'web-1')!.jumpResolvable).toBe(false)
  })

  it('reports a missing file', async () => {
    const f = await makeInventory()
    const p = await makeImporter(f, join(f.sshDir, 'nope')).preview()
    expect(p).toEqual({ path: join(f.sshDir, 'nope'), found: false, candidates: [], warnings: [] })
  })

  it('marks existing hosts by case-insensitive label', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const h = f.hosts.create({ label: 'BASTION', address: '52.1.2.3' })
    const p = await makeImporter(f).preview()
    expect(p.candidates.find((c) => c.alias === 'bastion')!.existingHostId).toBe(h.id)
  })

  it('keeps parse warnings apart from entry warnings', async () => {
    const f = await withConfig(fixture('hostile.conf'))
    const p = await makeImporter(f).preview()
    expect(p.warnings.some((w) => w.startsWith('Match blocks are not imported'))).toBe(true)
    expect(p.warnings.some((w) => w.startsWith('Include outside'))).toBe(true)
    const shadow = p.candidates.find((c) => c.alias === 'shadow')!
    expect(shadow.warnings.some((w) => w.startsWith('IdentityFile outside'))).toBe(true)
    expect(p.warnings.some((w) => w.startsWith('IdentityFile outside'))).toBe(false)
  })

  it('warns about ProxyJump chains and unknown jump hosts', async () => {
    const f = await withConfig(
      'Host a\n  HostName 10.0.0.1\n  ProxyJump b,c\nHost b\n  HostName 10.0.0.2\nHost c\n  HostName 10.0.0.3\n  ProxyJump ops@b:2200\nHost d\n  HostName 10.0.0.4\n  ProxyJump elsewhere\n',
    )
    const p = await makeImporter(f).preview()
    const by = (a: string) => p.candidates.find((c) => c.alias === a)!
    expect(by('a').jumpResolvable).toBe(false)
    expect(by('a').warnings).toContain("ProxyJump chains aren't imported; set the jump host by hand")
    expect(by('c').jumpResolvable).toBe(true)
    expect(by('d').jumpResolvable).toBe(false)
    expect(by('d').warnings.some((w) => w.includes('elsewhere'))).toBe(true)
  })

  it('flags aliases that differ only by case', async () => {
    const f = await withConfig('Host Web\n  HostName 10.0.0.1\nHost web\n  HostName 10.0.0.2\n')
    const p = await makeImporter(f).preview()
    expect(p.candidates.map((c) => [c.alias, c.valid])).toEqual([
      ['Web', true],
      ['web', false],
    ])
    expect(p.candidates[1].warnings.some((w) => w.includes('Web'))).toBe(true)
  })
})

describe('SshImporter.import', () => {
  it('imports with keys, identities and jumps', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const prod = prodEnv(f)
    const r = await makeImporter(f).import({
      vaultId: DEFAULT_VAULT_ID,
      aliases: ['web-1', 'db-1', 'bastion'],
      environmentId: prod,
      role: 'db',
    })
    expect(r.created.map((h) => h.label)).toEqual(['web-1', 'db-1', 'bastion'])
    expect(r.skipped).toEqual([])
    expect(r.keysLinked).toBe(1)
    expect(r.identitiesCreated).toBe(2)
    const by = (l: string) => r.created.find((h) => h.label === l)!
    expect(by('db-1').jumpHostId).toBe(by('bastion').id)
    expect(by('web-1')).toMatchObject({ address: '10.0.0.5', port: 2222 })
    for (const h of r.created) {
      expect(h.environments).toEqual([{ environmentId: prod, role: 'db' }])
      expect(h.vaultIds).toEqual([DEFAULT_VAULT_ID])
    }
    const ids = f.identities.list(DEFAULT_VAULT_ID)
    expect(ids.map((i) => i.label).sort()).toEqual(['deploy · id_ed25519', 'fallback'])
    const webId = ids.find((i) => i.id === by('web-1').identityId)!
    expect(webId).toMatchObject({ username: 'deploy', auth: 'key' })
    const key = f.keys.list().find((k) => k.id === webId.sshKeyId)!
    expect(key).toMatchObject({ source: 'file', label: 'id_ed25519', filePath: join(f.sshDir, 'id_ed25519') })
    expect(ids.find((i) => i.label === 'fallback')).toMatchObject({ auth: 'agent', sshKeyId: null })
    expect(by('db-1').identityId).toBe(by('bastion').identityId)

    const a = actions(f)
    expect(a.filter((x) => x === 'key.link')).toHaveLength(1)
    expect(a.filter((x) => x === 'identity.create')).toHaveLength(2)
    expect(a.filter((x) => x === 'host.create')).toHaveLength(3)
    expect(a.filter((x) => x === 'host.import')).toHaveLength(1)
    const imp = f.audit.list({ actions: ['host.import'] })[0]
    expect(imp).toMatchObject({ targetType: 'ssh_config' })
    expect(imp.details).toEqual({ created: 3, skipped: 0, keysLinked: 1, identitiesCreated: 2, tunnels: 3 })
    const create = f.audit.list({ actions: ['host.create'] })[0]
    expect(create.details).toMatchObject({ source: 'ssh_config', vaults: 1, environments: 1 })
  })

  it('import creates tunnels for forwards', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const prod = prodEnv(f)
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1', 'db-1'], environmentId: prod })
    expect(r.tunnelsCreated).toBe(3)
    const id = (l: string) => r.created.find((h) => h.label === l)!.id
    const ts = f.tunnels.list()
    expect(ts.map((t) => [t.label, t.type, t.hostId, t.bindAddress, t.bindPort, t.targetHost, t.targetPort, t.autoStart, t.autoReconnect])).toEqual([
      ['db-1 L 5433', 'L', id('db-1'), '127.0.0.1', 5433, 'localhost', 5432, false, true],
      ['web-1 R 9000', 'R', id('web-1'), '127.0.0.1', 9000, 'localhost', 3000, false, true],
      ['web-1 SOCKS 1080', 'D', id('web-1'), '127.0.0.1', 1080, null, null, false, true],
    ])
    expect(f.audit.list({ actions: ['host.import'] })[0].details).toMatchObject({ tunnels: 3 })
    expect(f.audit.list({ actions: ['tunnel.create'] })).toHaveLength(0)
  })

  it('forwards: false creates none', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1', 'db-1'], forwards: false })
    expect(r.tunnelsCreated).toBe(0)
    expect(f.tunnels.list()).toEqual([])
  })

  it('re-import adds forwards to an existing host without duplicates', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const imp = makeImporter(f)
    await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['db-1'], forwards: false })
    const again = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['db-1'] })
    expect(again.skipped).toEqual([{ alias: 'db-1', reason: 'exists' }])
    expect(again.tunnelsCreated).toBe(1)
    const third = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['db-1'] })
    expect(third.tunnelsCreated).toBe(0)
    expect(f.tunnels.list()).toHaveLength(1)
  })

  it('bad forward becomes a warning, not a failure', async () => {
    const f = await withConfig('Host a\n  HostName 10.0.0.1\n  LocalForward /tmp/s localhost:1\n  LocalForward nonsense\n  RemoteForward 9000\n  LocalForward 5000 db:80\n')
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['a'] })
    expect(r.created).toHaveLength(1)
    expect(r.tunnelsCreated).toBe(1)
    expect(r.warnings).toEqual([
      "a: unix socket forwards aren't supported",
      "a: can't read this forward",
      "a: reverse dynamic forwards aren't supported",
    ])
  })

  it('is idempotent on re-import', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const prod = prodEnv(f)
    const imp = makeImporter(f)
    const req = { vaultId: DEFAULT_VAULT_ID, aliases: ['web-1', 'db-1', 'bastion'], environmentId: prod }
    await imp.import(req)
    const before = counts(f)
    const r = await imp.import(req)
    expect(r.created).toEqual([])
    expect(r.skipped).toEqual([
      { alias: 'web-1', reason: 'exists' },
      { alias: 'db-1', reason: 'exists' },
      { alias: 'bastion', reason: 'exists' },
    ])
    expect(r).toMatchObject({ keysLinked: 0, identitiesCreated: 0 })
    expect(counts(f)).toEqual(before)
  })

  it('re-creates a host renamed by hand, reusing its key and identity', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const imp = makeImporter(f)
    const first = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] })
    f.hosts.update(first.created[0].id, { label: 'web-1-renamed' })
    const r = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] })
    expect(r.created.map((h) => h.label)).toEqual(['web-1'])
    expect(r).toMatchObject({ keysLinked: 0, identitiesCreated: 0 })
    expect(r.created[0].identityId).toBe(first.created[0].identityId)
  })

  it('jumps to an existing host by label', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const bastion = f.hosts.create({ label: 'Bastion', address: '52.1.2.3' })
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['db-1', 'bastion'] })
    expect(r.created.map((h) => h.label)).toEqual(['db-1'])
    expect(r.created[0].jumpHostId).toBe(bastion.id)
    expect(r.skipped).toEqual([{ alias: 'bastion', reason: 'exists' }])
  })

  it('skips a jump loop with a warning', async () => {
    const f = await withConfig('Host a\n  HostName 10.0.0.1\n  ProxyJump b\nHost b\n  HostName 10.0.0.2\n  ProxyJump a\n')
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['a', 'b'] })
    expect(r.created).toHaveLength(2)
    const [a, b] = r.created
    expect(a.jumpHostId).toBe(b.id)
    expect(b.jumpHostId).toBeNull()
    expect(r.warnings.some((w) => w.startsWith('jump host loop'))).toBe(true)
  })

  it('rejects option-looking addresses', async () => {
    const f = await withConfig(fixture('hostile.conf'))
    const imp = makeImporter(f)
    const evil = (await imp.preview()).candidates.find((c) => c.alias === 'evil')!
    expect(evil.valid).toBe(false)
    expect(evil.warnings).toContain("address isn't a plain hostname or IP; skipped")
    const r = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['evil'] })
    expect(r.skipped).toEqual([{ alias: 'evil', reason: 'invalid' }])
    expect(r.created).toEqual([])
    expect(counts(f).hosts).toBe(0)
  })

  it('rejects option-looking aliases even with a plain HostName', async () => {
    const f = await withConfig('Host -oProxyCommand=x\n  HostName 10.0.0.1\n')
    const imp = makeImporter(f)
    const c = (await imp.preview()).candidates[0]
    expect(c.valid).toBe(false)
    const r = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['-oProxyCommand=x'] })
    expect(r.skipped).toEqual([{ alias: '-oProxyCommand=x', reason: 'invalid' }])
    expect(counts(f).hosts).toBe(0)
  })

  it('skips the later of two aliases that differ only by case', async () => {
    const f = await withConfig('Host Web\n  HostName 10.0.0.1\nHost web\n  HostName 10.0.0.2\n')
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web', 'Web'] })
    expect(r.created.map((h) => h.label)).toEqual(['Web'])
    expect(r.skipped).toEqual([{ alias: 'web', reason: 'invalid' }])
  })

  it('reports unknown aliases as not-found', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['nope'] })
    expect(r.skipped).toEqual([{ alias: 'nope', reason: 'not-found' }])
    expect(r.created).toEqual([])
  })

  it('needs unlock', async () => {
    const f = await withConfig(fixture('basic.conf'))
    f.vault.lock('manual')
    await expect(makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] })).rejects.toThrow(VAULT_LOCKED)
    expect(counts(f)).toMatchObject({ hosts: 0, ssh_keys: 0, identities: 0 })
  })

  it('falls back to agent auth when an IdentityFile escapes ~/.ssh through a symlink', async () => {
    const f = await withConfig('Host web-1\n  HostName 10.0.0.5\n  User deploy\n  IdentityFile ~/.ssh/escape\n')
    const outside = mkdtempSync(join(tmpdir(), 'opsdeck-outside-'))
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'key'), generateEd25519('x').privateKey, { mode: 0o600 })
    symlinkSync(join(outside, 'key'), join(f.sshDir, 'escape'))
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] })
    expect(r.keysLinked).toBe(0)
    expect(f.keys.list()).toEqual([])
    expect(r.warnings.some((w) => w.includes('outside'))).toBe(true)
    const id = f.identities.list().find((i) => i.id === r.created[0].identityId)!
    expect(id).toMatchObject({ label: 'deploy', username: 'deploy', auth: 'agent' })
  })

  it("falls back to agent auth when a key can't be linked", async () => {
    const f = await withConfig('Host web-1\n  HostName 10.0.0.5\n  User deploy\n  IdentityFile ~/.ssh/broken\n')
    writeFileSync(join(f.sshDir, 'broken'), 'not a key', { mode: 0o600 })
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] })
    expect(r.keysLinked).toBe(0)
    expect(r.created).toHaveLength(1)
    expect(r.warnings.some((w) => w.includes('broken') && w.includes('agent'))).toBe(true)
  })

  it('makes no identity when an entry has neither User nor IdentityFile', async () => {
    const f = await withConfig('Host plain\n  HostName 10.0.0.9\n')
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['plain'] })
    expect(r.identitiesCreated).toBe(0)
    expect(r.created[0]).toMatchObject({ identityId: null, vaultIds: [] })
  })

  it('refuses hostile aliases, addresses and users', async () => {
    const f = await withConfig(
      [
        'Host web\u200b',
        '  HostName 10.0.0.1',
        'Host rtl',
        '  HostName 10.0.0.2\u202e',
        'Host opt-user',
        '  HostName 10.0.0.3',
        '  User -oProxyCommand=x',
        '  IdentityFile ~/.ssh/id_ed25519',
        'Host sep-user',
        '  HostName 10.0.0.4',
        '  User a\u0085b',
        'Host fmt-user',
        '  HostName 10.0.0.5',
        '  User root\u202e',
        'Host pad-user',
        '  HostName 10.0.0.6',
        '  User " -x"',
        '',
      ].join('\n'),
    )
    const imp = makeImporter(f)
    const by = new Map((await imp.preview()).candidates.map((c) => [c.alias, c]))
    expect(by.get('web\u200b')!.valid).toBe(false)
    expect(by.get('rtl')!.valid).toBe(false)
    for (const a of ['opt-user', 'sep-user', 'fmt-user', 'pad-user']) {
      expect(by.get(a)).toMatchObject({ valid: true, user: null, identityFile: null })
      expect(by.get(a)!.warnings).toContain("User isn't a plain username; the host inherits an identity")
    }
    const r = await imp.import({ vaultId: DEFAULT_VAULT_ID, aliases: ['opt-user', 'sep-user', 'fmt-user'] })
    expect(r.created.map((h) => h.identityId)).toEqual([null, null, null])
    expect(r).toMatchObject({ identitiesCreated: 0, keysLinked: 0 })
    expect(f.identities.list()).toEqual([])
  })

  it('skips a host whose label was taken after the preview', async () => {
    const f = await withConfig('Host web\n  HostName 10.0.0.1\n  User deploy\nHost api\n  HostName 10.0.0.2\n  User deploy\n')
    const create = f.identities.create.bind(f.identities)
    f.identities.create = (input) => {
      if (!f.hosts.list().some((h) => h.label === 'WEB')) f.hosts.create({ label: 'WEB', address: '10.9.9.9' })
      return create(input)
    }
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web', 'api'] })
    expect(r.created.map((h) => h.label)).toEqual(['api'])
    expect(r.skipped).toEqual([{ alias: 'web', reason: 'exists' }])
  })

  it('imports without a jump host deleted after the preview', async () => {
    const f = await withConfig('Host db\n  HostName 10.0.0.1\n  User deploy\n  ProxyJump gate\n')
    const gate = f.hosts.create({ label: 'gate', address: '10.0.0.254' })
    const create = f.identities.create.bind(f.identities)
    f.identities.create = (input) => {
      f.hosts.delete(gate.id)
      return create(input)
    }
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['db'] })
    expect(r.created).toHaveLength(1)
    expect(r.created[0].jumpHostId).toBeNull()
    expect(r.warnings).toContain("db: jump host gate wasn't imported; set it by hand")
  })

  it('rethrows identity errors that are not validation', async () => {
    const f = await withConfig('Host web\n  HostName 10.0.0.1\n  User deploy\n')
    f.identities.create = () => {
      throw new Error('database is locked')
    }
    await expect(makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web'] })).rejects.toThrow('database is locked')
    expect(counts(f).hosts).toBe(0)
  })

  it('keeps secrets out of audit and results', async () => {
    const f = await withConfig(fixture('basic.conf'))
    const r = await makeImporter(f).import({ vaultId: DEFAULT_VAULT_ID, aliases: ['web-1', 'db-1', 'bastion'] })
    expect(auditRows(f.db)).not.toContain('BEGIN OPENSSH')
    expect(JSON.stringify(r)).not.toContain('BEGIN OPENSSH')
    expect(JSON.stringify(await makeImporter(f).preview())).not.toContain('BEGIN OPENSSH')
    const imp = f.audit.list({ actions: ['host.import'] })[0]
    expect(JSON.stringify(imp.details)).not.toContain('web-1')
  })
})

describe('sshconfig IPC', () => {
  async function ipc() {
    const f = await withConfig(fixture('basic.conf'))
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    registerHandlers(
      { handle: (c: string, fn: never) => void registered.set(c, fn) },
      stubHandlers(createSshImportHandlers(makeImporter(f))),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS },
    )
    const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
    const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
    return { f, call }
  }

  it('previews and imports through the channels', async () => {
    const { call } = await ipc()
    const p = (await call('sshconfig:preview')) as { candidates: unknown[] }
    expect(p.candidates).toHaveLength(3)
    const r = await call('sshconfig:import', { vaultId: DEFAULT_VAULT_ID, aliases: ['bastion'] })
    expect(r).toMatchObject({ created: [{ label: 'bastion' }] })
  })

  it('rejects malformed requests', async () => {
    const { f, call } = await ipc()
    const bad = [
      { vaultId: 'x', aliases: ['a'] },
      { vaultId: DEFAULT_VAULT_ID, aliases: [''] },
      { vaultId: DEFAULT_VAULT_ID, aliases: ['a'.repeat(200)] },
      { vaultId: DEFAULT_VAULT_ID, aliases: Array.from({ length: MAX_IMPORT_ALIASES + 1 }, (_, i) => `h${i}`) },
      { vaultId: DEFAULT_VAULT_ID, aliases: ['a'], role: 'boss' },
      { vaultId: DEFAULT_VAULT_ID, aliases: ['a'], environmentId: 'x' },
      { vaultId: DEFAULT_VAULT_ID, aliases: ['a'], configText: 'Host a' },
    ]
    for (const req of bad) {
      await expect(call('sshconfig:import', req)).rejects.toThrow(/invalid arguments/)
    }
    // Extra args are dropped: config text sent by the renderer is never parsed.
    const p = (await call('sshconfig:preview', 'Host injected\n  HostName 1.2.3.4\n')) as { candidates: { alias: string }[] }
    expect(p.candidates.map((c) => c.alias)).toEqual(['web-1', 'db-1', 'bastion'])
    expect(counts(f).hosts).toBe(0)
  })
})
