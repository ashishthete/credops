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
    const fresh = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:')
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

describe('vault schema', () => {
  it('seeds the default vault', async () => {
    const { DEFAULT_VAULT_ID } = await import('../../src/shared/vault')
    const db = openDatabase(':memory:')
    const rows = db.prepare('SELECT id,name,wrapped_key FROM vaults').all()
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: DEFAULT_VAULT_ID, name: 'Default', wrapped_key: null },
    ])
    const state = db.prepare('SELECT * FROM vault_state').all() as { auto_lock_minutes: number }[]
    expect(state).toHaveLength(1)
    expect(state[0]!.auto_lock_minutes).toBe(15)
  })

  it('enforces key and identity shapes', async () => {
    const { DEFAULT_VAULT_ID: v } = await import('../../src/shared/vault')
    const db = openDatabase(':memory:')
    expect(() =>
      db
        .prepare(
          "INSERT INTO ssh_keys(id,vault_id,label,key_type,public_key,fingerprint,source,file_path,created_at,updated_at) VALUES ('k',?,'l','ssh-ed25519','p','f','file',NULL,'t','t')",
        )
        .run(v),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      db
        .prepare(
          "INSERT INTO identities(id,vault_id,label,username,auth,password_enc,created_at,updated_at) VALUES ('i',?,'l','u','password',NULL,'t','t')",
        )
        .run(v),
    ).toThrow(/CHECK constraint failed/)
    // Control: a well-formed row of each shape is accepted.
    db.prepare(
      "INSERT INTO ssh_keys(id,vault_id,label,key_type,public_key,fingerprint,source,file_path,created_at,updated_at) VALUES ('k',?,'l','ssh-ed25519','p','f','file','/k','t','t')",
    ).run(v)
    db.prepare(
      "INSERT INTO identities(id,vault_id,label,username,auth,ssh_key_id,created_at,updated_at) VALUES ('i',?,'l','u','key','k','t','t')",
    ).run(v)
    expect(db.prepare('SELECT COUNT(*) AS n FROM identities').get()).toEqual({ n: 1 })
  })
})
