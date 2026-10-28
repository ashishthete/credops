import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OWNER, migrateFromOpsDeck, systemMigrationDeps, type MigrationDeps } from '../../src/main/rename-migration'

const OLD = '/data/opsdeck'
const NEW = '/data/credops'
const KEY = 'c2VjcmV0LWtleS1ieXRlcw=='

interface FakeOpts {
  files?: string[]
  oldKey?: string | null
  newKey?: boolean
  addFails?: boolean
  addSilentlyFails?: boolean
  readFails?: boolean
  /** pid in OpsDeck's SingletonLock */
  lockPid?: number
  /** pid recorded in an existing .migrating folder */
  ownerPid?: number
  /** pids that exist */
  alive?: number[]
  /** the second claim of .migrating loses to another launch */
  claimRace?: boolean
}

const DB_NAMES = new Set(['opsdeck.db', 'opsdeck.db-wal', 'opsdeck.db-shm'])

function fake(opts: FakeOpts = {}) {
  const files = new Set(opts.files ?? [OLD, `${OLD}/opsdeck.db`, `${OLD}/opsdeck.db-wal`, `${OLD}/Local Storage`])
  const keys = new Map<string, string>()
  if (opts.oldKey !== null) keys.set('OpsDeck Safe Storage', opts.oldKey ?? KEY)
  if (opts.newKey) keys.set('CredOps Safe Storage', 'existing')
  const calls: string[] = []
  const d: MigrationDeps = {
    exists: (p) => files.has(p),
    copyDir: (from, to) => {
      calls.push(`copy ${from} ${to}`)
      for (const f of [...files])
        if (f.startsWith(`${from}/`) && !DB_NAMES.has(f.slice(from.length + 1))) files.add(to + f.slice(from.length))
    },
    snapshotDb: (from, to) => {
      calls.push(`snapshot ${from} ${to}`)
      files.add(to)
    },
    lockHolder: () => opts.lockPid ?? null,
    alive: (pid) => (opts.alive ?? []).includes(pid),
    claimDir: (p) => {
      calls.push(`claim ${p}`)
      if (files.has(p)) return false
      if (opts.claimRace && calls.filter((c) => c === `claim ${p}`).length > 1) return false
      files.add(p)
      files.add(`${p}/${OWNER}`)
      return true
    },
    owner: () => opts.ownerPid ?? null,
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`)
      for (const f of [...files])
        if (f === from || f.startsWith(`${from}/`)) {
          files.delete(f)
          files.add(to + f.slice(from.length))
        }
    },
    remove: (p) => {
      calls.push(`remove ${p}`)
      for (const f of [...files]) if (f === p || f.startsWith(`${p}/`)) files.delete(f)
    },
    list: (dir) => [...files].filter((f) => f.startsWith(`${dir}/`)),
    now: () => 123,
    keychain: {
      has: (i) => keys.has(i.service),
      remove: (i) => {
        calls.push(`delete ${i.service}`)
        keys.delete(i.service)
      },
      read: (i) => {
        if (opts.readFails) throw new Error('denied')
        return keys.get(i.service) ?? null
      },
      add: (i, pw) => {
        calls.push(`add ${i.service} ${i.account}`)
        if (opts.addFails) throw new Error('denied')
        if (!opts.addSilentlyFails) keys.set(i.service, pw)
      },
    },
  }
  return { d, files, keys, calls }
}

describe('migrateFromOpsDeck', () => {
  it('copies the key, then the folder, snapshotting the database as credops.db', () => {
    const f = fake()
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.keys.get('CredOps Safe Storage')).toBe(KEY)
    expect(f.calls.indexOf('add CredOps Safe Storage CredOps Key')).toBeLessThan(f.calls.findIndex((c) => c.startsWith('copy')))
    expect(f.calls).toContain(`snapshot ${OLD}/opsdeck.db ${NEW}.migrating/credops.db`)
    expect([...f.files].filter((p) => p.startsWith(NEW)).sort()).toEqual([NEW, `${NEW}/Local Storage`, `${NEW}/credops.db`])
  })

  it('moves nothing while OpsDeck is running', () => {
    const f = fake({ lockPid: 4242, alive: [4242] })
    expect(() => migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toThrow('OpsDeck is still running')
    expect(f.calls).toEqual([])
    expect(f.keys.has('CredOps Safe Storage')).toBe(false)
  })

  it('migrates past a lock a crashed OpsDeck left', () => {
    const f = fake({ lockPid: 4242, alive: [] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
  })

  it('leaves a copy in progress by another live launch alone', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, `${NEW}.migrating`], ownerPid: 77, alive: [77] })
    expect(() => migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toThrow('Another CredOps launch')
    expect(f.calls.some((c) => c.startsWith('remove') || c.startsWith('copy'))).toBe(false)
  })

  it('gives way when another launch claims the folder after the stale one is removed', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, `${NEW}.migrating`], claimRace: true })
    expect(() => migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toThrow('Another CredOps launch')
    expect(f.calls.some((c) => c.startsWith('copy'))).toBe(false)
  })

  it('keeps the OpsDeck folder and Keychain item', () => {
    const f = fake()
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.files.has(`${OLD}/opsdeck.db`)).toBe(true)
    expect(f.keys.get('OpsDeck Safe Storage')).toBe(KEY)
    expect(f.calls.some((c) => c.startsWith(`remove ${OLD}`))).toBe(false)
  })

  it('does nothing once CredOps has its database, or when there was no OpsDeck', () => {
    const done = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW, `${NEW}/credops.db`] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, done.d)).toBe('none')
    const fresh = fake({ files: [] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, fresh.d)).toBe('none')
    expect([...done.calls, ...fresh.calls]).toEqual([])
  })

  it('replaces a key Electron made before the data moved', () => {
    const f = fake({ newKey: true })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain('delete CredOps Safe Storage')
    expect(f.keys.get('CredOps Safe Storage')).toBe(KEY)
  })

  it('moves aside a folder Electron filled before the data moved', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW, `${NEW}/Local State`] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.files.has(`${NEW}.unused-123/Local State`)).toBe(true)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
    expect(f.files.has(`${NEW}/Local State`)).toBe(false)
  })

  it('removes the folder Electron made when it is still empty', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW] })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain(`remove ${NEW}`)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
  })

  it('still moves the data when OpsDeck never made a key', () => {
    const f = fake({ oldKey: null })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.keys.has('CredOps Safe Storage')).toBe(false)
  })

  it.each([
    ['the key cannot be read', { readFails: true }, "couldn't read"],
    ['the key cannot be saved', { addFails: true }, "couldn't save"],
    ['the save reports success but the key does not read back', { addSilentlyFails: true }, "couldn't save"],
    ['the save reports success but an old key stays', { addSilentlyFails: true, newKey: true }, "couldn't save"],
    ['the key has an unexpected shape', { oldKey: 'a" -A "b' }, 'expected format'],
  ])('moves no data when %s', (_why, opts, message) => {
    const f = fake(opts)
    expect(() => migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toThrow(message)
    expect([...f.files].some((p) => p.startsWith(NEW))).toBe(false)
  })

  it('never puts the key in an error message', () => {
    const f = fake({ oldKey: 'bad key with spaces' })
    try {
      migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    } catch (err) {
      expect((err as Error).message).not.toContain('bad key')
    }
  })

  it('restarts a copy a crash left half-done', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, `${NEW}.migrating`, `${NEW}.migrating/junk`], ownerPid: 99, alive: [] })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain(`remove ${NEW}.migrating`)
    expect(f.files.has(`${NEW}/junk`)).toBe(false)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
  })
})

describe('systemMigrationDeps', () => {
  const d = systemMigrationDeps('/Applications/CredOps.app')
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })
  const setup = (): string => (root = mkdtempSync(join(tmpdir(), 'credops-migration-')))

  it('snapshots a database whose rows are still in the WAL into one consistent file', () => {
    const dir = setup()
    const src = join(dir, 'opsdeck.db')
    const live = new DatabaseSync(src)
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'a\'), (\'b\')')
    expect(existsSync(`${src}-wal`)).toBe(true)
    const out = join(dir, 'credops.db')
    d.snapshotDb(src, out)
    live.close()
    expect(existsSync(`${out}-wal`)).toBe(false)
    const copy = new DatabaseSync(out, { readOnly: true })
    expect(copy.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r['v'])).toEqual(['a', 'b'])
    copy.close()
  })

  it('copies the folder without the database files or Chromium locks', () => {
    const dir = setup()
    const from = join(dir, 'opsdeck')
    mkdirSync(join(from, 'Local Storage'), { recursive: true })
    for (const f of ['opsdeck.db', 'opsdeck.db-wal', 'opsdeck.db-shm', 'Preferences', 'Local Storage/leveldb']) writeFileSync(join(from, f), 'x')
    symlinkSync('host-1', join(from, 'SingletonLock'))
    const to = join(dir, 'credops.migrating')
    mkdirSync(to)
    d.copyDir(from, to)
    expect(readdirSync(to).sort()).toEqual(['Local Storage', 'Preferences'])
    expect(readFileSync(join(to, 'Local Storage/leveldb'), 'utf8')).toBe('x')
  })

  it('reads the pid from SingletonLock and tells a live pid from a dead one', () => {
    const dir = setup()
    expect(d.lockHolder(dir)).toBeNull()
    symlinkSync(`some-host.local-${process.pid}`, join(dir, 'SingletonLock'))
    expect(d.lockHolder(dir)).toBe(process.pid)
    expect(d.alive(process.pid)).toBe(true)
    expect(d.alive(2 ** 22 + 12345)).toBe(false)
  })

  it('claims the temp folder once, recording this process as owner', () => {
    const dir = setup()
    const tmp = join(dir, 'credops.migrating')
    expect(d.claimDir(tmp)).toBe(true)
    expect(d.owner(tmp)).toBe(process.pid)
    expect(d.claimDir(tmp)).toBe(false)
    rmSync(join(tmp, OWNER))
    expect(d.owner(tmp)).toBeNull()
  })

  it('migrates a real folder end to end', () => {
    const dir = setup()
    const oldDir = join(dir, 'opsdeck')
    const newDir = join(dir, 'credops')
    mkdirSync(oldDir)
    writeFileSync(join(oldDir, 'Preferences'), 'p')
    const live = new DatabaseSync(join(oldDir, 'opsdeck.db'))
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\')')
    live.close()
    const deps: MigrationDeps = { ...d, keychain: { has: () => false, read: () => null, remove: () => {}, add: () => {} } }
    expect(migrateFromOpsDeck({ oldDir, newDir }, deps)).toBe('migrated')
    expect(readdirSync(newDir).sort()).toEqual(['Preferences', 'credops.db'])
    expect(existsSync(`${newDir}.migrating`)).toBe(false)
    const db = new DatabaseSync(join(newDir, 'credops.db'))
    expect(db.prepare('SELECT v FROM t').all().map((r) => r['v'])).toEqual(['kept'])
    db.close()
  })
})
