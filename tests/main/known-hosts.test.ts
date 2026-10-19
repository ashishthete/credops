import { createHash, createHmac } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fingerprintOf, hostToken, KnownHostStore, parseKnownHosts } from '../../src/main/ssh/known-hosts'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { generateKey } from './ssh-server'
import { makeVault } from './vault-helpers'

interface Key {
  type: string
  b64: string
  raw: Buffer
}

function gen(kind: 'ed25519' | 'ecdsa'): Key {
  const parsed = generateKey(kind).public
  const raw = parsed.getPublicSSH()
  return { type: parsed.type, b64: raw.toString('base64'), raw }
}

const hashed = (token: string, salt = Buffer.from('0123456789abcdefghij')): string =>
  `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(token).digest('base64')}`

async function setup(file?: string) {
  const f = makeVault()
  await f.vault.setup('correct horse')
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-kh-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'known_hosts')
  if (file !== undefined) writeFileSync(path, file)
  const clock = { t: Date.UTC(2026, 5, 1) }
  const store = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: path, now: () => new Date(clock.t) })
  return { ...f, store, path, clock }
}

describe('hostToken', () => {
  it('brackets non-22 ports and lowercases', () => {
    expect(hostToken('DB.Example', 22)).toBe('db.example')
    expect(hostToken('db', 2222)).toBe('[db]:2222')
    expect(hostToken('::1', 2200)).toBe('[::1]:2200')
  })
})

describe('fingerprintOf', () => {
  it('matches OpenSSH', () => {
    const k = gen('ed25519')
    expect(fingerprintOf(k.b64)).toBe('SHA256:' + createHash('sha256').update(k.raw).digest('base64').replace(/=+$/, ''))
  })
})

describe('parseKnownHosts', () => {
  it('matches plain, comma lists, wildcards and negation', () => {
    const k = gen('ed25519')
    const [l] = parseKnownHosts(`a.example,*.db.example,!bad.db.example ${k.type} ${k.b64}`)
    expect(l.matches('a.example')).toBe(true)
    expect(l.matches('x.db.example')).toBe(true)
    expect(l.matches('bad.db.example')).toBe(false)
    expect(l.matches('b.example')).toBe(false)
  })

  it('matches hashed entries', () => {
    const k = gen('ed25519')
    const [l] = parseKnownHosts(`${hashed('[db]:2222')} ${k.type} ${k.b64}`)
    expect(l.matches('[db]:2222')).toBe(true)
    expect(l.matches('db')).toBe(false)
  })

  it('skips malformed lines and markers it does not know', () => {
    const k = gen('ed25519')
    const text = ['junk', '', '# comment', `@unknown host ${k.type} ${k.b64}`, `good ${k.type} ${k.b64}`, `@revoked r ${k.type} ${k.b64}`].join('\n')
    const lines = parseKnownHosts(text)
    expect(lines.map((l) => [l.line, l.marker])).toEqual([
      [5, null],
      [6, 'revoked'],
    ])
  })
})

describe('KnownHostStore.check', () => {
  it('unknown when neither source knows the host', async () => {
    const k = gen('ed25519')
    const s = await setup('')
    const r = await s.store.check('db', 22, k.type, k.b64)
    expect(r.status).toBe('unknown')
    expect(r.info.known).toEqual([])
    expect(r.info.host).toBe('db')
  })

  it('match from openssh file and from app store', async () => {
    const k = gen('ed25519')
    const s = await setup(`db ${k.type} ${k.b64}\n`)
    expect((await s.store.check('db', 22, k.type, k.b64)).status).toBe('match')
    const k2 = gen('ed25519')
    s.store.trust('other', 22, k2.type, k2.b64)
    s.clock.t += 60_000
    expect((await s.store.check('other', 22, k2.type, k2.b64)).status).toBe('match')
    expect(s.store.list()[0].lastSeen).toBe(new Date(s.clock.t).toISOString())
  })

  it('hashed bracketed entry with a different key is changed', async () => {
    const a = gen('ed25519')
    const b = gen('ed25519')
    const s = await setup(`${hashed('[db]:2222')} ${a.type} ${a.b64}\n`)
    const r = await s.store.check('db', 2222, b.type, b.b64)
    expect(r.status).toBe('changed')
    expect(r.info.known).toEqual([{ keyType: a.type, fingerprint: fingerprintOf(a.b64), source: 'openssh', line: 1 }])
  })

  it('different key type only is unknown, with known listed', async () => {
    const e = gen('ecdsa')
    const k = gen('ed25519')
    const s = await setup(`db ${e.type} ${e.b64}\n`)
    const r = await s.store.check('db', 22, k.type, k.b64)
    expect(r.status).toBe('unknown')
    expect(r.info.known).toEqual([{ keyType: e.type, fingerprint: fingerprintOf(e.b64), source: 'openssh', line: 1 }])
  })

  it('revoked wins over match', async () => {
    const k = gen('ed25519')
    const s = await setup(`@revoked db ${k.type} ${k.b64}\ndb ${k.type} ${k.b64}\n`)
    expect((await s.store.check('db', 22, k.type, k.b64)).status).toBe('revoked')
  })

  it('pinned() drops a key revoked in the OpenSSH file, from both sources', async () => {
    const k = gen('ed25519')
    const other = gen('ed25519')
    const s = await setup(`@revoked db ${k.type} ${k.b64}\ndb ${other.type} ${other.b64}\n`)
    s.store.trust('db', 22, k.type, k.b64)
    expect(await s.store.pinned('db', 22)).toEqual([`db ${other.type} ${other.b64}`])
    const s2 = await setup(`@revoked db ${k.type} ${k.b64}\ndb ${k.type} ${k.b64}\n`)
    expect(await s2.store.pinned('db', 22)).toEqual([])
  })

  it('cert-authority lines are ignored', async () => {
    const k = gen('ed25519')
    const s = await setup(`@cert-authority db ${k.type} ${k.b64}\n`)
    const r = await s.store.check('db', 22, k.type, k.b64)
    expect(r.status).toBe('unknown')
    expect(r.info.known).toEqual([])
  })

  it('missing file is empty; oversized file is skipped', async () => {
    const k = gen('ed25519')
    const s = await setup()
    expect((await s.store.check('db', 22, k.type, k.b64)).status).toBe('unknown')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const line = `db ${k.type} ${k.b64}\n`
    writeFileSync(s.path, line + '#'.repeat(4 * 1024 * 1024 + 1 - line.length))
    expect((await s.store.check('db', 22, k.type, k.b64)).status).toBe('unknown')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('hardening', () => {
  it('ignores unpadded and mislabelled key lines', async () => {
    const e = gen('ecdsa')
    const k = gen('ed25519')
    const unpadded = k.b64.replace(/=+$/, '')
    expect(e.b64.length % 4).toBe(0)
    // Force an unpadded variant even when the key needs no padding: drop a char (non-canonical).
    const bad = unpadded === k.b64 ? k.b64.slice(0, -1) : unpadded
    const s = await setup(`db ${k.type} ${bad}\ndb ssh-ed25519 ${e.b64}\n`)
    const r = await s.store.check('db', 22, k.type, k.b64)
    expect(r.status).toBe('unknown')
    expect(r.info.known).toEqual([])
  })

  it('unreadable file warns once and is unknown', async () => {
    if (process.getuid?.() === 0) return
    const k = gen('ed25519')
    const s = await setup(`db ${k.type} ${k.b64}\n`)
    chmodSync(s.path, 0o000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    expect((await s.store.check('db', 22, k.type, k.b64)).status).toBe('unknown')
    await s.store.check('db', 22, k.type, k.b64)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('EACCES')
    expect(String(warn.mock.calls[0][0])).not.toContain(s.path)
  })

  it('app-store different key is changed, listed as app', async () => {
    const a = gen('ed25519')
    const b = gen('ed25519')
    const s = await setup('')
    s.store.trust('db', 22, a.type, a.b64)
    const r = await s.store.check('db', 22, b.type, b.b64)
    expect(r.status).toBe('changed')
    expect(r.info.known).toEqual([{ keyType: a.type, fingerprint: fingerprintOf(a.b64), source: 'app' }])
  })

  it('revoked hashed entry blocks; ? and [db]:* wildcards match', async () => {
    const k = gen('ed25519')
    const s = await setup(`@revoked ${hashed('[db]:2222')} ${k.type} ${k.b64}\n`)
    expect((await s.store.check('db', 2222, k.type, k.b64)).status).toBe('revoked')
    const [q, br] = parseKnownHosts(`db?.example ${k.type} ${k.b64}\n[db]:* ${k.type} ${k.b64}\n`)
    expect(q.matches('db1.example')).toBe(true)
    expect(q.matches('db12.example')).toBe(false)
    expect(br.matches('[db]:2222')).toBe(true)
    expect(br.matches('db')).toBe(false)
  })
})

describe('KnownHostStore writes', () => {
  it('trust upserts and audits without the address', async () => {
    const a = gen('ed25519')
    const b = gen('ed25519')
    const s = await setup('')
    s.store.trust('Secret.Host', 2222, a.type, a.b64)
    s.store.trust('Secret.Host', 2222, b.type, b.b64)
    const rows = s.store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].fingerprint).toBe(fingerprintOf(b.b64))
    const ev = s.audit.list({ actions: ['knownhost.trust'] })
    expect(ev).toHaveLength(2)
    const fps = ev.map((e) => e.details.fingerprint).sort()
    expect(fps).toEqual([fingerprintOf(a.b64), fingerprintOf(b.b64)].sort())
    for (const e of ev) {
      expect(e.details).toEqual({ keyType: a.type, fingerprint: e.details.fingerprint })
      expect(e.targetLabel).toBe('[secret.host]:2222')
    }
    s.vault.lock('manual')
    expect(() => s.store.trust('x', 22, a.type, a.b64)).toThrow(VAULT_LOCKED)
  })

  it('remove audits and works by id; list works while locked', async () => {
    const a = gen('ed25519')
    const s = await setup('')
    const m = s.store.trust('db', 22, a.type, a.b64)
    s.vault.lock('manual')
    expect(s.store.list()).toHaveLength(1)
    expect(() => s.store.remove(m.id)).toThrow(VAULT_LOCKED)
    await s.vault.unlock('correct horse')
    s.store.remove(m.id)
    expect(s.store.list()).toEqual([])
    const ev = s.audit.list({ actions: ['knownhost.remove'] })
    expect(ev).toHaveLength(1)
    expect(ev[0].targetLabel).toBe('db')
  })

  it('recordMismatch audits a denial', async () => {
    const a = gen('ed25519')
    const s = await setup('')
    s.store.recordMismatch({ host: 'db', keyType: a.type, fingerprint: fingerprintOf(a.b64), known: [] }, 'h1')
    const ev = s.audit.list({ actions: ['knownhost.mismatch'] })
    expect(ev[0]).toMatchObject({ outcome: 'denied', targetType: 'knownhost', targetId: 'h1', targetLabel: 'db' })
  })
})
