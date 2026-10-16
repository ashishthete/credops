import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion, migrate, migrations, type Migration } from '../../src/main/db/migrations'

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  )
}

describe('database migrations', () => {
  it('applies migrations in order', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBe(migrations.at(-1)!.version)
    expect(tableExists(db, 'audit_events')).toBe(true)
  })

  it('is idempotent', () => {
    const db = openDatabase(':memory:')
    const n = migrations.at(-1)!.version
    expect(migrate(db)).toEqual({ from: n, to: n })
  })

  it('rolls back a failing migration', () => {
    const fresh = openDatabase(':memory:')
    const list: Migration[] = [
      { version: 1, name: 'a', up: 'CREATE TABLE a(x)' },
      { version: 2, name: 'b', up: 'CREATE TABLE b(x); SELECT * FROM nope' },
    ]
    expect(() => migrate(fresh, list)).toThrow(/2.*b/)
    expect(currentVersion(fresh)).toBe(1)
    expect(tableExists(fresh, 'a')).toBe(true)
    expect(tableExists(fresh, 'b')).toBe(false)
  })

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })
})
