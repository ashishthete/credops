import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { openSealed, seal } from '../../../src/main/vault/crypto'
import type { HubDb } from '../db'

const KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const SENTINEL_PLAIN = 'opsdeck-hub-key-check'
const SENTINEL_AAD = 'hub-keycheck:v1'
export const MASTER_KEY_ENV = 'OPSDECK_HUB_MASTER_KEY'

function decode(text: string): Buffer {
  const trimmed = text.trim()
  const key = BASE64.test(trimmed) ? Buffer.from(trimmed, 'base64') : null
  if (key?.length !== KEY_BYTES) throw new Error('master key must be 32 bytes (base64)')
  return key
}

/**
 * The 32-byte master key from `file` (mode 0600 or 0400, owned by this user) or, with no file, from the
 * environment. A configured file is never bypassed by the variable. Errors never carry key material.
 */
export function loadMasterKey(opts: { file?: string; env?: Record<string, string | undefined> } = {}): Buffer {
  const env = opts.env ?? process.env
  if (opts.file) {
    let text: string
    try {
      const st = statSync(opts.file)
      const mode = st.mode & 0o777
      if (mode !== 0o600 && mode !== 0o400) throw new Error('masterKeyFile must be chmod 600')
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('masterKeyFile must be owned by the Hub user')
      text = readFileSync(opts.file, 'utf8')
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('masterKeyFile must')) throw err
      throw new Error('masterKeyFile could not be read')
    }
    return decode(text)
  }
  const fromEnv = env[MASTER_KEY_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return decode(fromEnv)
  throw new Error(`no master key: set masterKeyFile or ${MASTER_KEY_ENV}`)
}

/** Writes a fresh random key to a new 0600 file. Refuses to overwrite an existing one. */
export function createMasterKeyFile(file: string): void {
  let fd: number
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('masterKeyFile already exists; refusing to overwrite it')
    throw new Error('masterKeyFile could not be created')
  }
  try {
    writeSync(fd, `${randomBytes(KEY_BYTES).toString('base64')}\n`)
  } finally {
    closeSync(fd)
  }
  chmodSync(file, 0o600)
}

/** Seals and opens values with the master key. Boot fails if the key is not the one this database was made with. */
export class KeyRing {
  readonly keyId: string

  constructor(
    db: HubDb,
    private readonly key: Buffer,
  ) {
    if (key.length !== KEY_BYTES) throw new Error('master key must be 32 bytes (base64)')
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const row = db.prepare("SELECT value FROM hub_meta WHERE key = 'key_check'").get() as { value: string } | undefined
    if (!row) {
      db.prepare("INSERT INTO hub_meta(key, value) VALUES ('key_check', ?)").run(this.seal(SENTINEL_PLAIN, SENTINEL_AAD))
      return
    }
    let ok = false
    try {
      ok = this.open(row.value, SENTINEL_AAD) === SENTINEL_PLAIN
    } catch {
      ok = false
    }
    if (!ok) throw new Error('master key does not match this database')
  }

  seal(plain: string, aad: string): string {
    return seal(this.key, plain, aad)
  }

  open(blob: string, aad: string): string {
    return openSealed(this.key, blob, aad).toString('utf8')
  }
}
