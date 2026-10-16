import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { createIdentityHandlers } from '../../src/main/ipc/handlers/identities'
import { createKeyHandlers } from '../../src/main/ipc/handlers/keys'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { KeyStore } from '../../src/main/vault/key-store'
import { generateEd25519, parsePrivateKey } from '../../src/main/vault/openssh'
import type { ClipboardLike } from '../../src/main/vault/types'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { auditRows, makeVault } from './vault-helpers'

// Wraps open so a test can see which files the store opened (every key read goes through it).
vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>()
  return { ...mod, open: vi.fn(mod.open) }
})

const opened = (): string[] => vi.mocked(open).mock.calls.map((c) => String(c[0]))

const PW = 'correct horse'
const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined
const isRoot = process.getuid?.() === 0

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsdeck-keys-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) {
    try {
      chmodSync(join(d, 'locked'), 0o600)
    } catch {
      // not every dir has one
    }
    rmSync(d, { recursive: true, force: true })
  }
})

function keygen(args: string[]): void {
  const r = spawnSync('ssh-keygen', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ssh-keygen ${args.join(' ')}: ${r.stderr}`)
}

function fakeClipboard(): ClipboardLike & { text: string } {
  return {
    text: '',
    async writeText(t) {
      this.text = t
    },
    async readText() {
      return this.text
    },
  }
}

async function setup() {
  const sshDir = tmp()
  const clipboard = fakeClipboard()
  const f = makeVault({ clipboard })
  await f.vault.setup(PW)
  const keys = new KeyStore(f.db, f.vault, f.audit, { sshDir, clipboard, defaultComment: 'tester@box' })
  const ids = new IdentityStore(f.db, f.vault, keys, f.audit)
  return { ...f, sshDir, clipboard, keys, ids }
}
type Fixture = Awaited<ReturnType<typeof setup>>

function writeKey(dir: string, name: string, comment = 'me@laptop'): { path: string; privateKey: string } {
  const g = generateEd25519(comment)
  const path = join(dir, name)
  writeFileSync(path, g.privateKey, { mode: 0o600 })
  writeFileSync(`${path}.pub`, `${g.publicKey}\n`)
  return { path, privateKey: g.privateKey }
}

function encryptedPem(passphrase: string): string {
  return generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

function keyRow(f: Fixture, id: string) {
  return f.db.prepare('SELECT * FROM ssh_keys WHERE id = ?').get(id) as {
    source: string
    file_path: string | null
    private_key_enc: string | null
    passphrase_enc: string | null
    public_key: string
  }
}

function actions(f: Fixture): string[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => e.action)
    .filter((a) => a.startsWith('key.') || a.startsWith('identity.'))
}

beforeEach(() => {
  vi.mocked(open).mockClear()
})

describe('KeyStore', () => {
  it.skipIf(!hasSshKeygen)('scans a messy ~/.ssh', async () => {
    const f = await setup()
    const d = f.sshDir
    const ed = writeKey(d, 'id_ed25519')
    keygen(['-q', '-t', 'ed25519', '-N', 'pw', '-C', '', '-f', join(d, 'id_work')])
    writeFileSync(join(d, 'known_hosts'), 'github.com ssh-ed25519 AAAA\n')
    writeFileSync(join(d, 'known_hosts.old'), 'x\n')
    writeFileSync(join(d, 'config'), 'Host *\n  IdentityFile ~/.ssh/id_ed25519\n')
    writeFileSync(join(d, 'authorized_keys'), 'ssh-ed25519 AAAA\n')
    writeFileSync(join(d, 'orphan.pub'), generateEd25519('o').publicKey)
    mkdirSync(join(d, 'old'))
    writeFileSync(join(d, 'old', 'id_rsa'), generateEd25519('nested').privateKey)
    symlinkSync(join(d, 'nowhere'), join(d, 'gone'))
    writeFileSync(join(d, 'locked'), generateEd25519('locked').privateKey)
    chmodSync(join(d, 'locked'), 0)
    writeFileSync(join(d, 'big'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(5 * 1024 * 1024)}\n`)
    writeFileSync(join(d, 'notes.txt'), 'not a key\n')

    const found = await f.keys.scanLocal()
    const expected = [ed.path, join(d, 'id_work')]
    if (isRoot) expected.push(join(d, 'locked'))
    expect(found.map((c) => c.path)).toEqual(expected.sort())
    const work = found.find((c) => c.path.endsWith('id_work'))!
    expect(work).toMatchObject({ keyType: 'ssh-ed25519', encrypted: true, alreadyLinked: false })
    expect(work.fingerprint).toMatch(/^SHA256:/)
    expect(found.find((c) => c.path === ed.path)).toMatchObject({ encrypted: false, alreadyLinked: false })

    // Size cap and name rules: never read, not just discarded.
    const read = opened()
    expect(read).toContain(ed.path)
    for (const name of ['big', 'known_hosts', 'known_hosts.old', 'config', 'authorized_keys', 'orphan.pub', 'id_ed25519.pub']) {
      expect(read).not.toContain(join(d, name))
    }

    await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'laptop', path: ed.path })
    const again = await f.keys.scanLocal()
    expect(again.find((c) => c.path === ed.path)?.alreadyLinked).toBe(true)
    expect(again.find((c) => c.path.endsWith('id_work'))?.alreadyLinked).toBe(false)
  })

  it('an encrypted PEM key is identified from its .pub', async () => {
    const f = await setup()
    const pem = encryptedPem('pw')
    writeFileSync(join(f.sshDir, 'id_pem'), pem)
    writeFileSync(join(f.sshDir, 'id_pem.pub'), `${parsePrivateKey(pem, 'pw').publicKey} me@old\n`)
    writeFileSync(join(f.sshDir, 'id_nopub'), encryptedPem('pw'))
    expect(await f.keys.scanLocal()).toEqual([
      {
        path: join(f.sshDir, 'id_pem'),
        keyType: 'ssh-ed25519',
        fingerprint: parsePrivateKey(pem, 'pw').fingerprint,
        encrypted: true,
        alreadyLinked: false,
      },
    ])
  })

  it('scan skips a 20 KiB file without opening it', async () => {
    const f = await setup()
    const big = join(f.sshDir, 'id_big')
    writeFileSync(big, `${generateEd25519('').privateKey}${'#'.repeat(20 * 1024)}`)
    const ok = writeKey(f.sshDir, 'id_ok')
    expect((await f.keys.scanLocal()).map((c) => c.path)).toEqual([ok.path])
    expect(opened()).toContain(ok.path)
    expect(opened()).not.toContain(big)
  })

  it('the .pub fallback ignores a symlinked .pub', async () => {
    const f = await setup()
    const pem = encryptedPem('pw')
    writeFileSync(join(f.sshDir, 'id_pem'), pem)
    const elsewhere = join(tmp(), 'id_pem.pub')
    writeFileSync(elsewhere, `${parsePrivateKey(pem, 'pw').publicKey}\n`)
    symlinkSync(elsewhere, join(f.sshDir, 'id_pem.pub'))
    expect(await f.keys.scanLocal()).toEqual([])
    expect(opened()).not.toContain(join(f.sshDir, 'id_pem.pub'))
  })

  it('scanLocal works while locked and never throws', async () => {
    const f = await setup()
    writeKey(f.sshDir, 'id_ed25519')
    f.vault.lock('manual')
    expect(await f.keys.scanLocal()).toHaveLength(1)
    const missing = new KeyStore(f.db, f.vault, f.audit, {
      sshDir: join(f.sshDir, 'absent'),
      clipboard: f.clipboard,
      defaultComment: 'x',
    })
    expect(await missing.scanLocal()).toEqual([])
  })

  it('link stores a reference only', async () => {
    const f = await setup()
    const { path, privateKey } = writeKey(f.sshDir, 'id_ed25519')
    const meta = await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'laptop', path })
    expect(meta).toMatchObject({
      label: 'laptop',
      source: 'file',
      filePath: path,
      keyType: 'ssh-ed25519',
      hasPassphrase: false,
      fingerprint: parsePrivateKey(privateKey).fingerprint,
    })
    const row = keyRow(f, meta.id)
    expect(row).toMatchObject({ source: 'file', file_path: path, private_key_enc: null, passphrase_enc: null })
    expect((await f.keys.material(meta.id)).privateKey).toBe(readFileSync(path, 'utf8'))
    expect(actions(f)).toEqual(['key.link'])
    expect(auditRows(f.db)).not.toContain('BEGIN OPENSSH')

    await expect(f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'hosts', path: '/etc/hosts' })).rejects.toThrow(
      /outside ~\/.ssh/,
    )
    // A symlink inside ~/.ssh pointing out of it is outside too.
    const outside = tmp()
    const far = writeKey(outside, 'id_far')
    symlinkSync(far.path, join(f.sshDir, 'id_link'))
    await expect(
      f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'far', path: join(f.sshDir, 'id_link') }),
    ).rejects.toThrow(/outside ~\/.ssh/)
  })

  it('a linked file that changed or vanished is refused at use', async () => {
    const f = await setup()
    const { path } = writeKey(f.sshDir, 'id_ed25519')
    const meta = await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'laptop', path })
    writeFileSync(path, generateEd25519('other').privateKey)
    await expect(f.keys.material(meta.id)).rejects.toThrow(/key file changed/)
    rmSync(path)
    await expect(f.keys.material(meta.id)).rejects.toThrow(/cannot read key file/)
  })

  it('material refuses a linked file grown past the cap', async () => {
    const f = await setup()
    const { path, privateKey } = writeKey(f.sshDir, 'id_ed25519')
    const meta = await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'laptop', path })
    writeFileSync(path, `${privateKey}${'#'.repeat(16 * 1024)}`)
    await expect(f.keys.material(meta.id)).rejects.toThrow(/too large/)
  })

  it('a linked path that became a symlink is still checked against ~/.ssh', async () => {
    const f = await setup()
    const { path } = writeKey(f.sshDir, 'id_ed25519')
    const meta = await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'laptop', path })
    const far = writeKey(tmp(), 'id_far')
    rmSync(path)
    symlinkSync(far.path, path)
    await expect(f.keys.material(meta.id)).rejects.toThrow(/outside ~\/.ssh/)
  })

  it('import and generate encrypt at rest', async () => {
    const f = await setup()
    const g = generateEd25519('ci@runner')
    const imported = f.keys.import({ vaultId: DEFAULT_VAULT_ID, label: 'ci', privateKey: g.privateKey })
    const generated = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy' })
    expect(imported).toMatchObject({ source: 'imported', filePath: null, publicKey: g.publicKey })
    expect(generated).toMatchObject({ source: 'generated', filePath: null, keyType: 'ssh-ed25519' })
    for (const id of [imported.id, generated.id]) {
      expect(keyRow(f, id).private_key_enc).toMatch(/^v1\./)
      expect(keyRow(f, id).private_key_enc).not.toContain('OPENSSH')
    }
    expect((await f.keys.material(imported.id)).privateKey).toBe(g.privateKey)
    const material = await f.keys.material(generated.id)
    expect(parsePrivateKey(material.privateKey)).toMatchObject({
      fingerprint: generated.fingerprint,
      comment: 'tester@box',
    })
    expect(generated.publicKey).toMatch(/ tester@box$/)
    expect(f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'c', comment: 'me@there' }).publicKey).toMatch(
      / me@there$/,
    )
    expect(actions(f)).toEqual(['key.import', 'key.generate', 'key.generate'])
    const rows = auditRows(f.db)
    expect(rows).not.toContain('BEGIN OPENSSH')
    expect(rows).not.toContain(material.privateKey.split('\n')[1])
  })

  it('import with passphrase', async () => {
    const f = await setup()
    const pem = encryptedPem('pw-secret')
    const meta = f.keys.import({ vaultId: DEFAULT_VAULT_ID, label: 'enc', privateKey: pem, passphrase: 'pw-secret' })
    expect(meta.hasPassphrase).toBe(true)
    expect(keyRow(f, meta.id).passphrase_enc).toMatch(/^v1\./)
    expect(f.keys.knownValues()).toContain('pw-secret')
    expect(await f.keys.material(meta.id)).toEqual({ privateKey: pem, passphrase: 'pw-secret' })
    expect(auditRows(f.db)).not.toContain('pw-secret')
    expect(auditRows(f.db)).not.toContain('ENCRYPTED PRIVATE KEY')

    // Known values are dropped on lock and reloaded once after unlock.
    f.vault.lock('manual')
    expect(f.keys.knownValues()).toEqual([])
    await f.vault.unlock(PW)
    expect(f.keys.knownValues()).toEqual(['pw-secret'])

    expect(() => f.keys.import({ vaultId: DEFAULT_VAULT_ID, label: 'x', privateKey: pem })).toThrow(
      /passphrase required/,
    )
    expect(() =>
      f.keys.import({ vaultId: DEFAULT_VAULT_ID, label: 'x', privateKey: pem, passphrase: 'nope' }),
    ).toThrow(/wrong passphrase/)
    const plain = generateEd25519('p').privateKey
    expect(() =>
      f.keys.import({ vaultId: DEFAULT_VAULT_ID, label: 'x', privateKey: plain, passphrase: 'pw' }),
    ).toThrow(/not encrypted/)
  })

  it.skipIf(!hasSshKeygen)('an encrypted openssh key needs a passphrase (unchecked until connect)', async () => {
    const f = await setup()
    const path = join(f.sshDir, 'id_work')
    keygen(['-q', '-t', 'ed25519', '-N', 'pw', '-C', '', '-f', path])
    await expect(f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'work', path })).rejects.toThrow(
      /passphrase required/,
    )
    const meta = await f.keys.link({ vaultId: DEFAULT_VAULT_ID, label: 'work', path, passphrase: 'pw' })
    expect(meta.hasPassphrase).toBe(true)
    expect(await f.keys.material(meta.id)).toEqual({ privateKey: readFileSync(path, 'utf8'), passphrase: 'pw' })
  })

  it('importFile reads the key in main', async () => {
    const f = await setup()
    const { path, privateKey } = writeKey(tmp(), 'id_any')
    const meta = await f.keys.importFile({ vaultId: DEFAULT_VAULT_ID, label: 'any' }, path)
    expect(meta).toMatchObject({ source: 'imported', filePath: null })
    expect((await f.keys.material(meta.id)).privateKey).toBe(privateKey)
    const big = join(tmp(), 'big')
    writeFileSync(big, 'x'.repeat(20_000))
    // Opened, then refused on the handle's fstat before any read.
    await expect(f.keys.importFile({ vaultId: DEFAULT_VAULT_ID, label: 'big' }, big)).rejects.toThrow(/too large/)
  })

  it('rejects bad input', async () => {
    const f = await setup()
    const v = DEFAULT_VAULT_ID
    expect(() => f.keys.import({ vaultId: v, label: 'x', privateKey: 'nope' })).toThrow(/unsupported key format/)
    expect(() => f.keys.import({ vaultId: v, label: ' ', privateKey: generateEd25519('').privateKey })).toThrow(/label/)
    expect(() => f.keys.generate({ vaultId: v, label: 'x', comment: 'a\nb' })).toThrow(/comment/)
    expect(() => f.keys.generate({ vaultId: '00000000-0000-4000-8000-0000000000ff', label: 'x' })).toThrow(
      /vault not found/,
    )
  })

  it('update relabels and is audited', async () => {
    const f = await setup()
    const k = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy' })
    expect(f.keys.update(k.id, { label: ' prod ' }).label).toBe('prod')
    expect(f.keys.update(k.id, {}).label).toBe('prod')
    expect(actions(f)).toEqual(['key.generate', 'key.update'])
  })

  it('locked writes are refused; list works locked', async () => {
    const f = await setup()
    const k = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy' })
    f.vault.lock('manual')
    expect(f.keys.list()).toHaveLength(1)
    expect(f.keys.list(DEFAULT_VAULT_ID)).toHaveLength(1)
    expect(() => f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'x' })).toThrow(VAULT_LOCKED)
    expect(() => f.keys.update(k.id, { label: 'y' })).toThrow(VAULT_LOCKED)
    expect(() => f.keys.delete(k.id)).toThrow(VAULT_LOCKED)
    await expect(f.keys.material(k.id)).rejects.toThrow(VAULT_LOCKED)
  })

  it('delete refuses keys in use', async () => {
    const f = await setup()
    const k = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy' })
    const id = f.ids.create({ vaultId: DEFAULT_VAULT_ID, label: 'prod', username: 'deploy', auth: 'key', sshKeyId: k.id })
    expect(() => f.keys.delete(k.id)).toThrow('key is used by identity prod')
    f.ids.delete(id.id)
    f.keys.delete(k.id)
    expect(f.keys.list()).toEqual([])
    expect(actions(f)).toEqual(['key.generate', 'identity.create', 'identity.delete', 'key.delete'])
  })

  it('copyPublic', async () => {
    const f = await setup()
    const k = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy' })
    const before = f.audit.list({ limit: 1000 }).length
    await f.keys.copyPublic(k.id)
    expect(f.clipboard.text).toBe(k.publicKey)
    expect(f.clipboard.text).toMatch(/^ssh-ed25519 \S+ tester@box$/)
    expect(f.audit.list({ limit: 1000 })).toHaveLength(before)
  })
})

describe('IdentityStore', () => {
  it('identities validate their auth', async () => {
    const f = await setup()
    const v = DEFAULT_VAULT_ID
    const other = f.vault.createVault({ name: 'Other', color: '#123456' })
    const foreign = f.keys.generate({ vaultId: other.id, label: 'theirs' })
    expect(() => f.ids.create({ vaultId: v, label: 'a', username: 'u', auth: 'key' })).toThrow(/ssh key/)
    expect(() => f.ids.create({ vaultId: v, label: 'a', username: 'u', auth: 'key', sshKeyId: foreign.id })).toThrow(
      /same vault/,
    )
    expect(() => f.ids.create({ vaultId: v, label: 'a', username: 'u', auth: 'password' })).toThrow(/password/)
    expect(() => f.ids.create({ vaultId: v, label: 'a', username: ' ', auth: 'agent' })).toThrow(/username/)
    for (const username of ['-oProxyCommand=x', 'root\u202e', 'a\u2028b', 'a\u0085b', 'a\tb']) {
      expect(() => f.ids.create({ vaultId: v, label: 'a', username, auth: 'agent' })).toThrow(/username/)
    }

    const pw = f.ids.create({ vaultId: v, label: 'db', username: 'root', auth: 'password', password: 'pw12345' })
    expect(pw).toMatchObject({ auth: 'password', hasPassword: true, sshKeyId: null })
    expect(() => f.ids.update(pw.id, { username: '-l' })).toThrow(/username/)
    expect(f.ids.knownValues()).toContain('pw12345')
    const updated = f.ids.update(pw.id, { auth: 'agent' })
    expect(updated).toMatchObject({ auth: 'agent', hasPassword: false })
    expect(f.db.prepare('SELECT password_enc FROM identities WHERE id = ?').get(pw.id)).toEqual({ password_enc: null })
    expect(f.ids.knownValues()).not.toContain('pw12345')
    expect(() => f.ids.update(pw.id, { auth: 'password' })).toThrow(/password/)

    const mine = f.keys.generate({ vaultId: v, label: 'mine' })
    expect(f.ids.update(pw.id, { auth: 'key', sshKeyId: mine.id })).toMatchObject({ sshKeyId: mine.id })
    expect(f.ids.update(pw.id, { auth: 'agent' }).sshKeyId).toBeNull()
    f.ids.delete(pw.id)
    expect(f.ids.list()).toEqual([])
    expect(actions(f).filter((a) => a.startsWith('identity.'))).toEqual([
      'identity.create',
      'identity.update',
      'identity.update',
      'identity.update',
      'identity.delete',
    ])
    expect(auditRows(f.db)).not.toContain('pw12345')
  })

  it('resolve returns material', async () => {
    const f = await setup()
    const v = DEFAULT_VAULT_ID
    const k = f.keys.generate({ vaultId: v, label: 'deploy' })
    const keyId = f.ids.create({ vaultId: v, label: 'k', username: 'deploy', auth: 'key', sshKeyId: k.id })
    const pwId = f.ids.create({ vaultId: v, label: 'p', username: 'root', auth: 'password', password: 'pw12345' })
    const agentId = f.ids.create({ vaultId: v, label: 'a', username: 'me', auth: 'agent' })
    const key = await f.ids.resolve(keyId.id)
    expect(key).toMatchObject({ username: 'deploy', auth: 'key' })
    expect(key.auth === 'key' && parsePrivateKey(key.privateKey).fingerprint).toBe(k.fingerprint)
    expect(await f.ids.resolve(pwId.id)).toEqual({ username: 'root', auth: 'password', password: 'pw12345' })
    expect(await f.ids.resolve(agentId.id)).toEqual({ username: 'me', auth: 'agent' })
    f.vault.lock('manual')
    expect(f.ids.list()).toHaveLength(3)
    expect(f.ids.knownValues()).toEqual([])
    await expect(f.ids.resolve(pwId.id)).rejects.toThrow(VAULT_LOCKED)
    await expect(f.ids.resolve(keyId.id)).rejects.toThrow(VAULT_LOCKED)
    await f.vault.unlock(PW)
    expect(f.ids.knownValues()).toEqual(['pw12345'])
  })

  it('key and identity writes throw on a corrupt vault', async () => {
    const f = await setup()
    const other = f.vault.createVault({ name: 'Prod', color: '#112233' })
    const pem = encryptedPem('pw-secret')
    const k = f.keys.import({ vaultId: other.id, label: 'enc', privateKey: pem, passphrase: 'pw-secret' })
    const pw = f.ids.create({ vaultId: other.id, label: 'p', username: 'root', auth: 'password', password: 'pw12345' })
    f.vault.lock('manual')
    f.db.prepare("UPDATE vaults SET wrapped_key = 'v1.AAAA.AAAA.AAAA' WHERE id = ?").run(other.id)
    await f.vault.unlock(PW)
    expect(f.vault.status().corruptVaultIds).toEqual([other.id])
    expect(f.keys.list(other.id)).toHaveLength(1)
    expect(f.ids.list(other.id)).toHaveLength(1)
    expect(f.keys.knownValues()).toEqual([])
    expect(f.ids.knownValues()).toEqual([])
    const v = other.id
    expect(() => f.keys.generate({ vaultId: v, label: 'x' })).toThrow(/corrupt/)
    expect(() => f.keys.import({ vaultId: v, label: 'x', privateKey: generateEd25519('').privateKey })).toThrow(
      /corrupt/,
    )
    const { path } = writeKey(f.sshDir, 'id_ed25519')
    await expect(f.keys.link({ vaultId: v, label: 'x', path })).rejects.toThrow(/corrupt/)
    expect(() => f.keys.update(k.id, { label: 'y' })).toThrow(/corrupt/)
    expect(() => f.keys.delete(k.id)).toThrow(/corrupt/)
    await expect(f.keys.material(k.id)).rejects.toThrow(/corrupt/)
    expect(() => f.ids.create({ vaultId: v, label: 'a', username: 'u', auth: 'agent' })).toThrow(/corrupt/)
    expect(() => f.ids.update(pw.id, { label: 'q' })).toThrow(/corrupt/)
    expect(() => f.ids.delete(pw.id)).toThrow(/corrupt/)
    await expect(f.ids.resolve(pw.id)).rejects.toThrow(/corrupt/)
  })

  it('deleting a vault removes its identities, keys and secrets', async () => {
    const f = await setup()
    const other = f.vault.createVault({ name: 'Other', color: '#123456' })
    const k = f.keys.generate({ vaultId: other.id, label: 'theirs' })
    f.ids.create({ vaultId: other.id, label: 'i', username: 'u', auth: 'key', sshKeyId: k.id })
    f.db
      .prepare(
        "INSERT INTO secrets(id, vault_id, name, kind, value_enc, created_at, updated_at) VALUES ('s1', ?, 'n', 'env', 'v1.x', 't', 't')",
      )
      .run(other.id)
    f.vault.deleteVault(other.id)
    for (const table of ['identities', 'ssh_keys', 'secrets']) {
      expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id = ?`).get(other.id)).toEqual({ n: 0 })
    }
  })
})

describe('key and identity ipc', () => {
  type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown
  const frame = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent

  async function wire(dialogPath?: string) {
    const f = await setup()
    const dialogDirs: string[] = []
    const openDialog = async (dir: string): Promise<string | undefined> => {
      dialogDirs.push(dir)
      return dialogPath
    }
    const registered = new Map<string, Fn>()
    const ipc = { handle: (c: string, fn: Fn) => void registered.set(c, fn) }
    registerHandlers(
      ipc,
      stubHandlers({ ...createKeyHandlers(f.keys, { openDialog }), ...createIdentityHandlers(f.ids) }),
      (u) => u === 'file:///ok',
      { validators: VALIDATORS, knownSecrets: () => [...f.keys.knownValues(), ...f.ids.knownValues()] },
    )
    return { f, dialogDirs, call: (c: string, ...a: unknown[]) => registered.get(c)!(frame, ...a) }
  }

  it('rejects bad args', async () => {
    const { call } = await wire()
    const v = DEFAULT_VAULT_ID
    const bad: [string, ...unknown[]][] = [
      ['key:list', 42],
      ['key:link', { vaultId: v, label: 'x' }],
      ['key:import', { vaultId: v, label: 'x', privateKey: 'k'.repeat(16385) }],
      ['key:import', { vaultId: 'nope', label: 'x', privateKey: 'k' }],
      ['key:importFile', { vaultId: v, label: 'x', privateKey: 'k' }],
      ['key:generate', { vaultId: v, label: 'x'.repeat(121) }],
      ['key:update', v, { label: 'x', vaultId: v }],
      ['key:delete', 'nope'],
      ['key:copyPublic', 'nope'],
      ['identity:create', { vaultId: v, label: 'x', username: 'u', auth: 'cert' }],
      ['identity:create', { vaultId: v, label: 'x', username: 'u'.repeat(257), auth: 'agent' }],
      ['identity:create', { vaultId: v, label: 'x', username: 'u', auth: 'password', password: 'p'.repeat(65537) }],
      ['identity:update', v, { vaultId: v }],
      ['identity:delete', 'nope'],
    ]
    for (const [channel, ...a] of bad) {
      const err = await (call(channel, ...a) as Promise<unknown>).then(
        () => null,
        (e: Error) => e,
      )
      expect(err?.message, channel).toMatch(/invalid arguments/)
      expect(err?.message).not.toContain('kkkk')
    }
  })

  it('maps each channel onto the stores', async () => {
    const outside = tmp()
    const file = writeKey(outside, 'id_pick')
    const { f, call, dialogDirs } = await wire(file.path)
    const v = DEFAULT_VAULT_ID
    const local = writeKey(f.sshDir, 'id_ed25519')
    expect(await call('key:scanLocal')).toHaveLength(1)
    const linked = (await call('key:link', { vaultId: v, label: 'laptop', path: local.path })) as { id: string }
    const gen = (await call('key:generate', { vaultId: v, label: ' deploy ' })) as { id: string; label: string }
    expect(gen.label).toBe('deploy')
    await call('key:import', { vaultId: v, label: 'ci', privateKey: generateEd25519('').privateKey })
    expect(await call('key:importFile', { vaultId: v, label: 'picked' })).toMatchObject({ source: 'imported' })
    expect(dialogDirs).toEqual([f.sshDir])
    expect(await call('key:list')).toHaveLength(4)
    expect(await call('key:list', v)).toHaveLength(4)
    expect(await call('key:update', linked.id, { label: 'mac' })).toMatchObject({ label: 'mac' })
    await call('key:copyPublic', gen.id)
    expect(f.clipboard.text).toMatch(/^ssh-ed25519 /)
    await call('key:delete', linked.id)

    const ident = (await call('identity:create', {
      vaultId: v,
      label: 'prod',
      username: 'deploy',
      auth: 'key',
      sshKeyId: gen.id,
    })) as { id: string }
    expect(await call('identity:list')).toHaveLength(1)
    expect(await call('identity:list', v)).toHaveLength(1)
    expect(await call('identity:update', ident.id, { username: 'root' })).toMatchObject({ username: 'root' })
    await call('identity:delete', ident.id)
    expect(await call('identity:list')).toEqual([])
  })

  it('a cancelled import dialog returns null', async () => {
    const { call } = await wire(undefined)
    expect(await call('key:importFile', { vaultId: DEFAULT_VAULT_ID, label: 'x' })).toBeNull()
  })
})
