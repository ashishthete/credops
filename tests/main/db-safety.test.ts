import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBeforeMigrating, KEEP_BACKUPS, pruneBackups } from '../../src/main/db/backup'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion, migrate, migrations, SchemaTooNewError, type Migration } from '../../src/main/db/migrations'

const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
const latest = migrations.at(-1)!.version
const m = (version: number): Migration => ({ version, name: `m${version}`, up: `CREATE TABLE t${version}(x)` })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credops-db-safety-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function backups(): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.bak'))
    .sort()
}

describe('downgrade guard', () => {
  it('refuses a database recording a version newer than this build knows', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [m(1), m(2)])
    expect(() => migrate(db, [m(1)])).toThrow(SchemaTooNewError)
    expect(() => migrate(db, [m(1)])).toThrow(
      'This data was written by a newer CredOps (schema 2); this build knows up to 1. Update CredOps.',
    )
  })

  it('names the product it is given', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [m(1), m(2)])
    expect(() => migrate(db, [m(1)], { product: 'CredOps Hub' })).toThrow(/newer CredOps Hub .*Update CredOps Hub\./)
  })

  it('openDatabase refuses a newer file, leaves it unchanged and writes no backup', () => {
    const file = join(dir, 'credops.db')
    openDatabase(file).close()
    const raw = new DatabaseSync(file)
    raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(latest + 5, 'future', 'now')
    raw.close()

    let caught: unknown
    try {
      openDatabase(file)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SchemaTooNewError)
    expect(caught).toMatchObject({ dbVersion: latest + 5, knownVersion: latest })
    expect((caught as Error).message).toContain(`schema ${latest + 5}`)
    expect(backups()).toEqual([])

    const check = new DatabaseSync(file)
    expect(currentVersion(check)).toBe(latest + 5)
    check.close()
  })

  it('the database file is readable only by its owner', () => {
    const file = join(dir, 'app.db')
    writeFileSync(file, '', { mode: 0o644 })
    openDatabase(file).close()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('opens a database at exactly the newest known version', () => {
    const file = join(dir, 'credops.db')
    openDatabase(file).close()
    const db = openDatabase(file)
    expect(currentVersion(db)).toBe(latest)
    db.close()
  })
})

describe('backup before migrating', () => {
  it('never backs up a brand-new database', () => {
    const file = join(dir, 'credops.db')
    openDatabase(file).close()
    expect(backups()).toEqual([])
  })

  it('does not back up when nothing is pending', () => {
    const file = join(dir, 'credops.db')
    openDatabase(file).close()
    openDatabase(file).close()
    expect(backups()).toEqual([])
  })

  it('copies an existing database aside before applying pending migrations, data and WAL included', () => {
    const file = join(dir, 'credops.db')
    const old = new DatabaseSync(file)
    old.exec('PRAGMA journal_mode = WAL')
    migrate(old, migrations.filter((x) => x.version < latest))
    // Still in the WAL, not checkpointed: the backup must see it.
    old.exec("INSERT INTO vaults(id, name, color, created_at, updated_at) VALUES ('v2', 'Second', '#000', 'now', 'now')")

    const target = backupBeforeMigrating(old, file, migrations)
    expect(target).toBe(`${file}.pre-v${latest}.bak`)
    old.close()
    expect(backups()).toEqual([`credops.db.pre-v${latest}.bak`])
    expect(statSync(target!).mode & 0o777).toBe(0o600)

    const copy = new DatabaseSync(target!)
    expect(currentVersion(copy)).toBe(latest - 1)
    expect(copy.prepare("SELECT name FROM vaults WHERE id = 'v2'").get()).toEqual({ name: 'Second' })
    copy.close()

    const db = openDatabase(file)
    expect(currentVersion(db)).toBe(latest)
    db.close()
  })

  it('openDatabase writes the backup itself when it upgrades an existing file', () => {
    const file = join(dir, 'credops.db')
    const old = new DatabaseSync(file)
    migrate(old, migrations.filter((x) => x.version < latest))
    old.close()
    openDatabase(file).close()
    expect(backups()).toEqual([`credops.db.pre-v${latest}.bak`])
  })

  it('skips in-memory databases', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [m(1)])
    expect(backupBeforeMigrating(db, ':memory:', [m(1), m(2)])).toBeNull()
  })

  it('keeps only the newest few backups of the same file', () => {
    const file = join(dir, 'credops.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    const list: Migration[] = []
    for (let v = 1; v <= KEEP_BACKUPS + 3; v++) {
      list.push(m(v))
      backupBeforeMigrating(db, file, list)
      migrate(db, list)
    }
    db.close()
    // v1 ran on an empty database: no copy. Then one per upgrade, pruned to the newest KEEP_BACKUPS.
    const expected = Array.from({ length: KEEP_BACKUPS }, (_, i) => `credops.db.pre-v${KEEP_BACKUPS + 3 - i}.bak`).sort()
    expect(backups()).toEqual(expected)
  })

  it('prunes by version and leaves other files alone', () => {
    const file = join(dir, 'credops.db')
    for (const n of ['credops.db.pre-v9.bak', 'credops.db.pre-v10.bak', 'credops.db.pre-v2.bak', 'other.db.pre-v1.bak', 'notes.txt']) {
      writeFileSync(join(dir, n), '')
    }
    expect(pruneBackups(file, 2)).toEqual(['credops.db.pre-v2.bak'])
    expect(existsSync(join(dir, 'other.db.pre-v1.bak'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, 'credops.db.pre-v10.bak'))).toBe(true)
  })
})
