import type { SshKeyType } from '../../shared/vault'

const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } =
  process.getBuiltinModule('node:crypto')

/** Upper bound on private key text we will look at (ledger P8). */
export const MAX_PRIVATE_KEY_BYTES = 16384

export interface ParsedKey {
  keyType: SshKeyType
  /** "type b64", no comment */
  publicKey: string
  fingerprint: string
  /**
   * The key is encrypted at rest. For an encrypted openssh-key-v1 key the
   * passphrase is NOT checked here: the public key comes from the plaintext
   * header, and ssh2 verifies the passphrase when it connects (Phase 4).
   */
  encrypted: boolean
  /** Empty when the key carries none, or it sits in an encrypted section. */
  comment: string
}

const KEY_TYPES: readonly SshKeyType[] = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
]
const isKeyType = (t: string): t is SshKeyType => (KEY_TYPES as readonly string[]).includes(t)

const EC_CURVES: Record<string, { type: SshKeyType; name: string; bytes: number }> = {
  'P-256': { type: 'ecdsa-sha2-nistp256', name: 'nistp256', bytes: 32 },
  'P-384': { type: 'ecdsa-sha2-nistp384', name: 'nistp384', bytes: 48 },
  'P-521': { type: 'ecdsa-sha2-nistp521', name: 'nistp521', bytes: 66 },
}

const MAGIC = Buffer.from('openssh-key-v1\0', 'latin1')
const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----'
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----'
const PEM_BEGIN = /^-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----$/m
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

class SshWriter {
  private parts: Buffer[] = []

  uint32(n: number): this {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    this.parts.push(b)
    return this
  }

  string(s: Buffer | string): this {
    const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s
    this.uint32(b.length)
    this.parts.push(b)
    return this
  }

  /** Unsigned big-endian integer; a leading zero keeps the high bit clear. */
  mpint(n: Buffer): this {
    let i = 0
    while (i < n.length && n[i] === 0) i++
    const v = n.subarray(i)
    return this.string(v.length > 0 && v[0] & 0x80 ? Buffer.concat([Buffer.of(0), v]) : v)
  }

  raw(b: Buffer): this {
    this.parts.push(b)
    return this
  }

  get length(): number {
    return this.parts.reduce((n, p) => n + p.length, 0)
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts)
  }
}

class SshReader {
  private pos = 0

  constructor(private readonly buf: Buffer) {}

  private take(n: number): Buffer {
    if (n > this.buf.length - this.pos) throw new Error('truncated')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  uint32(): number {
    return this.take(4).readUInt32BE()
  }

  string(): Buffer {
    return this.take(this.uint32())
  }

  text(): string {
    return this.string().toString('utf8')
  }

  raw(n: number): Buffer {
    return this.take(n)
  }
}

const unsupported = (): Error => new Error('unsupported key format')

export function fingerprintOf(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

const publicLine = (type: SshKeyType, blob: Buffer): string =>
  `${type} ${blob.toString('base64')}`

function wrap(b64: string, width: number): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width))
  return lines.join('\n')
}

export function generateEd25519(comment: string): {
  privateKey: string
  publicKey: string
  fingerprint: string
} {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const seed = Buffer.from(jwk.d as string, 'base64url')
  const pub = Buffer.from(jwk.x as string, 'base64url')

  const pubBlob = new SshWriter().string('ssh-ed25519').string(pub).toBuffer()
  const check = randomBytes(4)
  const priv = new SshWriter()
    .raw(check)
    .raw(check)
    .string('ssh-ed25519')
    .string(pub)
    .string(Buffer.concat([seed, pub]))
    .string(comment)
  for (let pad = 1; priv.length % 8 !== 0; pad++) priv.raw(Buffer.of(pad))
  const privBuf = priv.toBuffer()

  const body = new SshWriter()
    .raw(MAGIC)
    .string('none')
    .string('none')
    .string('')
    .uint32(1)
    .string(pubBlob)
    .string(privBuf)
    .toBuffer()
  seed.fill(0)
  privBuf.fill(0)

  return {
    privateKey: `${OPENSSH_BEGIN}\n${wrap(body.toString('base64'), 70)}\n${OPENSSH_END}\n`,
    publicKey: `${publicLine('ssh-ed25519', pubBlob)} ${comment}`,
    fingerprint: fingerprintOf(pubBlob),
  }
}

export function parsePublicKeyLine(line: string): {
  keyType: SshKeyType
  blob: Buffer
  comment: string
} {
  const [type = '', b64 = '', ...rest] = line.trim().split(/\s+/)
  if (!isKeyType(type) || !BASE64.test(b64)) throw unsupported()
  const blob = Buffer.from(b64, 'base64')
  try {
    if (new SshReader(blob).text() !== type) throw unsupported()
  } catch {
    throw unsupported()
  }
  return { keyType: type, blob, comment: rest.join(' ') }
}

export function parsePrivateKey(text: string, passphrase?: string): ParsedKey {
  if (Buffer.byteLength(text, 'utf8') > MAX_PRIVATE_KEY_BYTES) throw unsupported()
  const trimmed = text.trim()
  if (trimmed.startsWith(OPENSSH_BEGIN)) {
    try {
      return parseOpenSsh(trimmed)
    } catch {
      throw unsupported()
    }
  }
  if (PEM_BEGIN.test(trimmed)) return parsePem(trimmed, passphrase)
  throw unsupported()
}

function parseOpenSsh(text: string): ParsedKey {
  const end = text.indexOf(OPENSSH_END)
  if (end < 0) throw unsupported()
  const b64 = text.slice(OPENSSH_BEGIN.length, end).replace(/\s+/g, '')
  if (!BASE64.test(b64)) throw unsupported()
  const r = new SshReader(Buffer.from(b64, 'base64'))
  if (!r.raw(MAGIC.length).equals(MAGIC)) throw unsupported()
  const cipher = r.text()
  r.string() // kdfname
  r.string() // kdfoptions
  if (r.uint32() !== 1) throw unsupported()
  const pubBlob = r.string()
  const privSection = r.string()

  const keyType = new SshReader(pubBlob).text()
  if (!isKeyType(keyType)) throw unsupported()
  const encrypted = cipher !== 'none'
  return {
    keyType,
    publicKey: publicLine(keyType, pubBlob),
    fingerprint: fingerprintOf(pubBlob),
    encrypted,
    comment: encrypted ? '' : readComment(privSection, keyType),
  }
}

/** Walks the plaintext private section past the key fields to the comment. */
function readComment(section: Buffer, keyType: SshKeyType): string {
  const r = new SshReader(section)
  if (r.uint32() !== r.uint32()) throw unsupported()
  if (r.text() !== keyType) throw unsupported()
  const fields = keyType === 'ssh-ed25519' ? 2 : keyType === 'ssh-rsa' ? 6 : 3
  for (let i = 0; i < fields; i++) r.string()
  return r.text()
}

function parsePem(text: string, passphrase?: string): ParsedKey {
  const encrypted = /^-----BEGIN ENCRYPTED PRIVATE KEY-----$|^Proc-Type: 4,ENCRYPTED$/m.test(text)
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(passphrase === undefined ? text : { key: text, passphrase })
  } catch {
    if (!encrypted) throw unsupported()
    throw new Error(passphrase === undefined ? 'passphrase required' : 'wrong passphrase')
  }
  let jwk: Parameters<typeof wireBlob>[0]
  try {
    jwk = createPublicKey(key).export({ format: 'jwk' })
  } catch {
    throw unsupported() // e.g. DSA, which has no JWK form
  }
  const { keyType, blob } = wireBlob(jwk)
  return {
    keyType,
    publicKey: publicLine(keyType, blob),
    fingerprint: fingerprintOf(blob),
    encrypted,
    comment: '',
  }
}

function wireBlob(jwk: {
  kty?: string
  crv?: string
  n?: string
  e?: string
  x?: string
  y?: string
}): { keyType: SshKeyType; blob: Buffer } {
  const b = (s: string | undefined): Buffer => {
    if (!s) throw unsupported()
    return Buffer.from(s, 'base64url')
  }
  const w = new SshWriter()
  if (jwk.kty === 'RSA') {
    return {
      keyType: 'ssh-rsa',
      blob: w.string('ssh-rsa').mpint(b(jwk.e)).mpint(b(jwk.n)).toBuffer(),
    }
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return { keyType: 'ssh-ed25519', blob: w.string('ssh-ed25519').string(b(jwk.x)).toBuffer() }
  }
  const curve = jwk.kty === 'EC' && jwk.crv ? EC_CURVES[jwk.crv] : undefined
  if (!curve) throw unsupported()
  const coord = (s: string | undefined): Buffer => {
    const v = b(s)
    if (v.length > curve.bytes) throw unsupported()
    return Buffer.concat([Buffer.alloc(curve.bytes - v.length), v])
  }
  const point = Buffer.concat([Buffer.of(4), coord(jwk.x), coord(jwk.y)])
  return {
    keyType: curve.type,
    blob: w.string(curve.type).string(curve.name).string(point).toBuffer(),
  }
}
