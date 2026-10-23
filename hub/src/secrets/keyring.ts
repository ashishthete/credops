import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, fstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { openSealed, seal } from '../../../src/main/vault/crypto'
import type { HubDb } from '../db'

const KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const SENTINEL_PLAIN = 'opsdeck-hub-key-check'
const SENTINEL_AAD = 'hub-keycheck:v1'
export const MASTER_KEY_ENV = 'CREDOPS_HUB_MASTER_KEY'

function decode(text: string): Buffer {
  const trimmed = text.trim()
  const key = BASE64.test(trimmed) ? Buffer.from(trimmed, 'base64') : null
  if (key?.length !== KEY_BYTES) throw new Error('master key must be 32 bytes (base64)')
  return key
}

/** True when `file` resolves (symlinks followed) to a path inside `dir`. A link that escapes it is outside. */
function insideDir(file: string, dir: string | undefined): boolean {
  if (!dir || !isAbsolute(dir) || dir === sep) return false
  try {
    const root = realpathSync(dir)
    return realpathSync(file).startsWith(root.endsWith(sep) ? root : root + sep)
  } catch {
    return false
  }
}

/**
 * The 32-byte master key from `file` (mode 0600 or 0400, owned by this user) or, with no file, from the
 * environment. A configured file is never bypassed by the variable. Errors never carry key material.
 *
 * Exception: a file that resolves inside $CREDENTIALS_DIRECTORY (systemd LoadCredential=) is owned by root
 * with the service user's access granted by ACL, so it shows as 0440. There it is enough that the owner is
 * root or this user, nobody can write, and the file has no "other" bits. Unverified on a live systemd.
 */
export function loadMasterKey(
  opts: { file?: string; env?: Record<string, string | undefined>; fstat?: (fd: number) => Pick<Stats, 'mode' | 'uid'> } = {},
): Buffer {
  const env = opts.env ?? process.env
  const fstat = opts.fstat ?? fstatSync
  if (opts.file) {
    let text: string
    let fd: number | undefined
    try {
      // One open file for both the checks and the read, so the file cannot be swapped in between.
      fd = openSync(opts.file, 'r')
      const st = fstat(fd)
      const mode = st.mode & 0o777
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
      if (insideDir(opts.file, env.CREDENTIALS_DIRECTORY)) {
        if (mode & 0o222) throw new Error('masterKeyFile must not be writable')
        if (mode & 0o007) throw new Error('masterKeyFile must not be readable by other users')
        if (uid !== undefined && st.uid !== 0 && st.uid !== uid) throw new Error('masterKeyFile must be owned by root or the Hub user')
      } else {
        if (mode !== 0o600 && mode !== 0o400) throw new Error('masterKeyFile must be chmod 600')
        if (uid !== undefined && st.uid !== uid) throw new Error('masterKeyFile must be owned by the Hub user')
      }
      text = readFileSync(fd, 'utf8')
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('masterKeyFile must')) throw err
      throw new Error('masterKeyFile could not be read')
    } finally {
      if (fd !== undefined) closeSync(fd)
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
    fchmodSync(fd, 0o600)
  } catch {
    // Only reached for the file this call just created with wx, so removing it cannot touch anyone else's.
    closeSync(fd)
    try {
      unlinkSync(file)
    } catch {
      /* nothing more to do */
    }
    throw new Error('masterKeyFile could not be written')
  }
  closeSync(fd)
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
