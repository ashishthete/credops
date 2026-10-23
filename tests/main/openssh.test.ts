import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_PRIVATE_KEY_BYTES,
  fingerprintOf,
  generateEd25519,
  parsePrivateKey,
  parsePublicKeyLine,
} from '../../src/main/vault/openssh'

const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'credops-openssh-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function keygen(args: string[]): string {
  const r = spawnSync('ssh-keygen', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ssh-keygen ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** "type b64 comment" -> "type b64" */
function stripComment(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(' ')
}

describe('openssh keys', () => {
  it('generates a parseable ed25519 key', () => {
    const g = generateEd25519('me@mac')
    expect(g.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(g.privateKey.endsWith('\n-----END OPENSSH PRIVATE KEY-----\n')).toBe(true)
    expect(g.publicKey).toMatch(/^ssh-ed25519 AAAA[\w+/]+=* me@mac$/)
    expect(g.fingerprint).toMatch(/^SHA256:[\w+/]{43}$/)
    expect(parsePrivateKey(g.privateKey)).toEqual({
      keyType: 'ssh-ed25519',
      publicKey: stripComment(g.publicKey),
      fingerprint: g.fingerprint,
      encrypted: false,
      comment: 'me@mac',
    })
    const pub = parsePublicKeyLine(g.publicKey)
    expect(pub.keyType).toBe('ssh-ed25519')
    expect(pub.comment).toBe('me@mac')
    expect(fingerprintOf(pub.blob)).toBe(g.fingerprint)
  })

  it('handles empty and multi-line comments', () => {
    const g = generateEd25519('')
    expect(g.publicKey).toMatch(/^ssh-ed25519 AAAA[\w+/]+=*$/)
    expect(parsePrivateKey(g.privateKey).comment).toBe('')
    expect(parsePublicKeyLine(g.publicKey).comment).toBe('')
    expect(() => generateEd25519('a\nb')).toThrow(/invalid comment/)
    expect(() => generateEd25519('a\rb')).toThrow(/invalid comment/)
  })

  it('rejects tampered openssh bodies', () => {
    const body = (): Buffer =>
      Buffer.from(generateEd25519('x').privateKey.split('\n').slice(1, -2).join(''), 'base64')
    const armor = (b: Buffer): string =>
      ['BEGIN', 'END']
        .map((w) => `-----${w} OPENSSH PRIVATE KEY-----`)
        .join(`\n${b.toString('base64')}\n`)
    expect(parsePrivateKey(armor(body())).comment).toBe('x')
    // magic(15) | "none"(8) | "none"(8) | ""(4) | uint32 1 | pubblob(4+51) | priv length(4)
    const privStart = 15 + 8 + 8 + 4 + 4 + 55 + 4
    const flipped = body()
    flipped[privStart] ^= 0xff
    expect(() => parsePrivateKey(armor(flipped))).toThrow(/unsupported key format/)
    const huge = body()
    huge.writeUInt32BE(0xffffffff, 15) // ciphername length
    expect(() => parsePrivateKey(armor(huge))).toThrow(/unsupported key format/)
    const kdf = body()
    kdf.write('nope', 15 + 8 + 4, 'latin1') // kdfname "none" -> "nope"
    expect(() => parsePrivateKey(armor(kdf))).toThrow(/unsupported key format/)
  })

  it.skipIf(!hasSshKeygen)('interoperates with ssh-keygen', () => {
    const g = generateEd25519('me@mac')
    const d = tmp()
    const file = join(d, 'id_ed25519')
    writeFileSync(file, g.privateKey, { mode: 0o600 })
    expect(stripComment(keygen(['-y', '-f', file]))).toBe(stripComment(g.publicKey))
    writeFileSync(`${file}.pub`, `${g.publicKey}\n`)
    expect(keygen(['-lf', `${file}.pub`])).toContain(g.fingerprint)
  })

  it.skipIf(!hasSshKeygen)('reads keys made by ssh-keygen', () => {
    const cases: Array<{ args: string[]; type: string; encrypted: boolean }> = [
      { args: ['-t', 'ed25519', '-N', ''], type: 'ssh-ed25519', encrypted: false },
      { args: ['-t', 'rsa', '-b', '2048', '-N', ''], type: 'ssh-rsa', encrypted: false },
      { args: ['-t', 'ecdsa', '-N', ''], type: 'ecdsa-sha2-nistp256', encrypted: false },
      { args: ['-t', 'ed25519', '-N', 'pw'], type: 'ssh-ed25519', encrypted: true },
    ]
    const d = tmp()
    cases.forEach((c, i) => {
      const file = join(d, `k${i}`)
      keygen([...c.args, '-C', `case${i}`, '-q', '-f', file])
      const parsed = parsePrivateKey(readFileSync(file, 'utf8'))
      const fp = keygen(['-lf', `${file}.pub`]).split(/\s+/)[1]
      expect(parsed.fingerprint).toBe(fp)
      expect(parsed.keyType).toBe(c.type)
      expect(parsed.encrypted).toBe(c.encrypted)
      expect(parsed.publicKey).toBe(stripComment(readFileSync(`${file}.pub`, 'utf8')))
      // An encrypted key's comment lives in the encrypted section.
      expect(parsed.comment).toBe(c.encrypted ? '' : `case${i}`)
    })
  })

  it('reads pem keys', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    expect(pkcs1).toContain('BEGIN RSA PRIVATE KEY')
    const a = parsePrivateKey(pkcs8)
    const b = parsePrivateKey(pkcs1)
    expect(a.keyType).toBe('ssh-rsa')
    expect(a.encrypted).toBe(false)
    expect(b).toEqual(a)
    expect(a.fingerprint).toBe(fingerprintOf(parsePublicKeyLine(a.publicKey).blob))

    const enc = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'pw',
    }) as string
    expect(enc).toContain('BEGIN ENCRYPTED PRIVATE KEY')
    expect(() => parsePrivateKey(enc)).toThrow(/passphrase required/)
    expect(() => parsePrivateKey(enc, 'nope')).toThrow(/wrong passphrase/)
    expect(parsePrivateKey(enc, 'pw')).toEqual({ ...a, encrypted: true })
  })

  it.skipIf(!hasSshKeygen)('pem fingerprints match ssh-keygen', () => {
    const d = tmp()
    const curves = [
      ['prime256v1', 'ecdsa-sha2-nistp256'],
      ['secp384r1', 'ecdsa-sha2-nistp384'],
      ['secp521r1', 'ecdsa-sha2-nistp521'],
    ] as const
    const keys = [
      ['rsa', 'ssh-rsa', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey],
      ...curves.map(
        ([c, t]) => ['ec', t, generateKeyPairSync('ec', { namedCurve: c }).privateKey] as const,
      ),
    ] as const
    keys.forEach(([kind, type, key], i) => {
      const pem = key.export({ type: kind === 'rsa' ? 'pkcs1' : 'sec1', format: 'pem' }) as string
      const file = join(d, `pem${i}`)
      writeFileSync(file, pem, { mode: 0o600 })
      const parsed = parsePrivateKey(pem)
      expect(parsed.keyType).toBe(type)
      expect(parsed.publicKey).toBe(stripComment(keygen(['-y', '-f', file])))
      writeFileSync(`${file}.pub`, `${parsed.publicKey}\n`)
      expect(keygen(['-lf', `${file}.pub`])).toContain(parsed.fingerprint)
    })
  })

  it('rejects junk', () => {
    const g = generateEd25519('x')
    expect(() => parsePrivateKey('hello')).toThrow(/unsupported key format/)
    expect(() => parsePrivateKey(g.publicKey)).toThrow(/unsupported key format/)
    expect(() => parsePrivateKey(g.privateKey.slice(0, 120))).toThrow(/unsupported key format/)
    expect(() => parsePrivateKey('x'.repeat(MAX_PRIVATE_KEY_BYTES + 1))).toThrow(
      /unsupported key format/,
    )
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
    expect(parsePrivateKey(ed as string).keyType).toBe('ssh-ed25519')
    const x = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
    expect(() => parsePrivateKey(x as string)).toThrow(/unsupported key format/)
    const dsa = generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
    expect(() => parsePrivateKey(dsa as string)).toThrow(/unsupported key format/)
    expect(() => parsePublicKeyLine('hello')).toThrow(/unsupported key format/)
    expect(() => parsePublicKeyLine('ssh-ed25519 AAAA')).toThrow(/unsupported key format/)
  })
})
