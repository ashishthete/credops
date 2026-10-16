const { createCipheriv, createDecipheriv, randomBytes, scrypt } =
  process.getBuiltinModule('node:crypto')

export interface KdfParams {
  alg: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
}

export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1 }

const SALT_BYTES = 16
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAXMEM = 256 * 1024 * 1024

export function newKdfParams(base: Omit<KdfParams, 'salt'> = DEFAULT_KDF): KdfParams {
  return { ...base, salt: randomBytes(SALT_BYTES).toString('base64') }
}

const MIN_N = 2 ** 10

/** Params come from the db: refuse anything weaker than we would write. The message carries no values. */
function usableParams(params: KdfParams): boolean {
  return (
    params.alg === 'scrypt' &&
    Number.isInteger(params.N) &&
    params.N >= MIN_N &&
    typeof params.salt === 'string' &&
    Buffer.from(params.salt, 'base64').length === SALT_BYTES
  )
}

export function deriveKek(password: string, params: KdfParams): Promise<Buffer> {
  if (!usableParams(params)) return Promise.reject(new Error('invalid kdf params'))
  const pw = Buffer.from(password.normalize('NFC'), 'utf8')
  return new Promise((resolve, reject) => {
    scrypt(
      pw,
      Buffer.from(params.salt, 'base64'),
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Returns `v1.<iv>.<ciphertext>.<tag>` (base64url segments), AES-256-GCM with `aad` bound. */
export function seal(key: Buffer, plaintext: string | Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv, ct, tag].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function openSealed(key: Buffer, sealed: string, aad: string): Buffer {
  try {
    const parts = sealed.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('format')
    const iv = Buffer.from(parts[1]!, 'base64url')
    const ct = Buffer.from(parts[2]!, 'base64url')
    const tag = Buffer.from(parts[3]!, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('format')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new Error('decrypt failed')
  }
}
