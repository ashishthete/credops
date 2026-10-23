import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The app was called OpsDeck. On the first CredOps launch its data folder is copied over and
 * the Keychain key that safeStorage derives from the app name ("<Name> Safe Storage") is copied
 * too, or the Touch ID cache, the PIN pepper and Hub tokens would no longer decrypt. The old
 * folder and Keychain item are left in place: nothing of the user's is deleted.
 */
export const OLD_DB = 'opsdeck.db'
export const DB_FILE = 'credops.db'
const OLD_KEY = { service: 'OpsDeck Safe Storage', account: 'OpsDeck Key' }
const NEW_KEY = { service: 'CredOps Safe Storage', account: 'CredOps Key' }
/** Chromium's per-profile instance lock: copying it would make the new app think the old one runs. */
const SINGLETON = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
/** Chromium's safeStorage password is base64; anything else is refused rather than quoted into a command. */
const KEY_SHAPE = /^[A-Za-z0-9+/=]{8,256}$/

export interface MigrationDeps {
  exists(path: string): boolean
  /** Recursive copy that skips Chromium's singleton lock files. */
  copyDir(from: string, to: string): void
  rename(from: string, to: string): void
  remove(path: string): void
  list(dir: string): string[]
  now(): number
  keychain: {
    /** True when an item exists; reads attributes only. */
    has(item: { service: string; account: string }): boolean
    /** The item's password, or null when there is none. Never log the result. */
    read(item: { service: string; account: string }): string | null
    remove(item: { service: string; account: string }): void
    /** Adds the item; the password goes over stdin, never argv. */
    add(item: { service: string; account: string }, password: string): void
  }
}

export type MigrationResult = 'none' | 'migrated'

/**
 * Copies `oldDir` to `newDir` once, the Keychain key first. Throws when the key cannot be copied,
 * before any data moves, so a relaunch retries; the copy goes through a temp folder and is renamed
 * into place last, so a crash part-way also retries.
 *
 * Done means `newDir` holds the CredOps database: Electron creates the folder itself before this
 * runs, so the folder alone says nothing. Whatever is in it then is Chromium's, made by a launch
 * that had no data; it is moved aside (or removed when empty), never merged.
 */
export function migrateFromOpsDeck(paths: { oldDir: string; newDir: string }, d: MigrationDeps): MigrationResult {
  const { oldDir, newDir } = paths
  if (d.exists(join(newDir, DB_FILE)) || !d.exists(join(oldDir, OLD_DB))) return 'none'

  let key: string | null
  try {
    key = d.keychain.read(OLD_KEY)
  } catch {
    throw new Error("CredOps couldn't read the OpsDeck key from the Keychain")
  }
  if (key !== null) {
    if (!KEY_SHAPE.test(key)) throw new Error('The OpsDeck key in the Keychain is not in the expected format')
    // A CredOps key already there was made by Electron for a launch without data, so it encrypts
    // nothing that is kept: replace it.
    let saved: string | null
    try {
      if (d.keychain.has(NEW_KEY)) d.keychain.remove(NEW_KEY)
      d.keychain.add(NEW_KEY, key)
      saved = d.keychain.read(NEW_KEY)
    } catch {
      throw new Error("CredOps couldn't save its key to the Keychain")
    }
    // `security -i` can report success for a command that failed: read the key back.
    if (saved !== key) throw new Error("CredOps couldn't save its key to the Keychain")
  }

  const tmp = `${newDir}.migrating`
  if (d.exists(tmp)) d.remove(tmp)
  d.copyDir(oldDir, tmp)
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(tmp, OLD_DB + suffix)
    if (d.exists(from)) d.rename(from, join(tmp, DB_FILE + suffix))
  }
  if (d.exists(newDir)) {
    if (d.list(newDir).length === 0) d.remove(newDir)
    else d.rename(newDir, `${newDir}.unused-${d.now()}`)
  }
  d.rename(tmp, newDir)
  return 'migrated'
}

const security = (args: string[], input?: string): string =>
  execFileSync('/usr/bin/security', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })

/** `security` exits 44 for "The specified item could not be found in the keychain." */
const notFound = (err: unknown): boolean => (err as { status?: number }).status === 44

const quote = (s: string): string => {
  if (/["\\\n]/.test(s)) throw new Error('Unquotable Keychain argument')
  return `"${s}"`
}

export function systemMigrationDeps(trustedApp: string): MigrationDeps {
  return {
    exists: existsSync,
    copyDir: (from, to) => cpSync(from, to, { recursive: true, preserveTimestamps: true, filter: (src) => !SINGLETON.has(basename(src)) }),
    rename: renameSync,
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    list: (dir) => readdirSync(dir),
    now: Date.now,
    keychain: {
      has: (item) => {
        try {
          security(['find-generic-password', '-s', item.service, '-a', item.account])
          return true
        } catch (err) {
          if (notFound(err)) return false
          throw err
        }
      },
      read: (item) => {
        try {
          return security(['find-generic-password', '-s', item.service, '-a', item.account, '-w']).replace(/\n$/, '')
        } catch (err) {
          if (notFound(err)) return null
          throw err
        }
      },
      remove: (item) => {
        security(['delete-generic-password', '-s', item.service, '-a', item.account])
      },
      // `security -i` reads its command from stdin, so the password is never in a process list.
      add: (item, password) => {
        const line = ['add-generic-password', '-s', quote(item.service), '-a', quote(item.account), '-T', quote(trustedApp), '-w', quote(password)].join(' ')
        security(['-i'], `${line}\n`)
      },
    },
  }
}
