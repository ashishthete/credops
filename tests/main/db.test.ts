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

  it('applies a version missing below the highest one, and only that one', () => {
    const fresh = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:')
    const m = (version: number): Migration => ({ version, name: `m${version}`, up: `CREATE TABLE t${version}(x)` })
    expect(migrate(fresh, [m(1), m(2), m(4)])).toEqual({ from: 0, to: 4 })
    const before = fresh.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()
    expect(migrate(fresh, [m(1), m(2), m(3), m(4)])).toEqual({ from: 4, to: 4 })
    const after = fresh.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()
    expect(after.map((r) => r.version)).toEqual([1, 2, 3, 4])
    // 1, 2 and 4 were not re-run.
    expect(after.filter((r) => r.version !== 3)).toEqual(before)
    expect(tableExists(fresh, 't3')).toBe(true)
    expect(migrate(fresh, [m(1), m(2), m(3), m(4)])).toEqual({ from: 4, to: 4 })
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

describe('migration versions', () => {
  // Version 8 is Phase 9's and merges from another branch, so this branch alone may skip it.
  it('are strictly increasing and unique, skipping only other branches\' versions 8, 12 and 13', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b))
    // 8 is Phase 9's, 12 is regions' and 13 is playbook-ops'; each merges from another branch.
    const rest = versions.filter((v) => v !== 8 && v !== 12 && v !== 13)
    expect(rest).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 14])
  })
})

describe('hub schema', () => {
  it('migration 10 adds a nullable, range-checked qa_wait_minutes', () => {
    const db = openDatabase(':memory:')
    expect(migrations.find((m) => m.version === 10)?.name).toBe('qa_wait_minutes')
    db.exec("INSERT INTO environments(id,name,color,created_at,updated_at) VALUES ('e','e','#000','t','t')")
    const ins = (n: number | null) => db.prepare("INSERT OR REPLACE INTO environment_integrations(environment_id,updated_at,qa_wait_minutes) VALUES ('e','t',?)").run(n)
    ins(null)
    ins(5)
    ins(180)
    expect(() => ins(4)).toThrow(/CHECK constraint failed/)
    expect(() => ins(181)).toThrow(/CHECK constraint failed/)
  })

  it('migration 9 creates hub_link and hub_env_links', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBeGreaterThanOrEqual(9)
    expect(migrations.find((m) => m.version === 9)?.name).toBe('hub')
    const insert = (id: number, enc: unknown, exp: unknown) =>
      db
        .prepare(
          "INSERT INTO hub_link(id,url,hub_id,hub_name,session_enc,session_expires_at,linked_at,updated_at) VALUES (?,'u','h','n',?,?,'t','t')",
        )
        .run(id, enc as null, exp as null)
    insert(1, null, null)
    // A second row violates id = 1.
    expect(() => insert(2, null, null)).toThrow(/CHECK constraint failed/)
    db.exec('DELETE FROM hub_link')
    // A session without an expiry (or the reverse) is rejected.
    expect(() => insert(1, Buffer.from('x'), null)).toThrow(/CHECK constraint failed/)
    insert(1, Buffer.from('x'), 't')
    const cols = db.prepare("SELECT name FROM pragma_table_info('hub_env_links')").all().map((r) => (r as { name: string }).name)
    expect(cols).toEqual(['environment_id', 'hub_id', 'published_at', 'manifest_hash'])
  })
})

describe('snippets schema', () => {
  const insert = (db: ReturnType<typeof openDatabase>, id: string, label: string, destructive = 0) =>
    db
      .prepare(
        'INSERT INTO snippets(id,label,script_sealed,destructive,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, label, 'sealed', destructive, 't', 't')

  it('migration 6 creates snippets with a case-insensitive unique label', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBeGreaterThanOrEqual(6)
    expect(migrations.find((m) => m.version === 6)?.name).toBe('snippets')
    insert(db, 's1', 'Deploy')
    expect(() => insert(db, 's2', 'deploy')).toThrow(/UNIQUE constraint failed/)
    const cols = db.prepare("SELECT name FROM pragma_table_info('snippets')").all().map((r) => (r as { name: string }).name)
    // The script and defaults exist only sealed.
    expect(cols).toContain('script_sealed')
    expect(cols).toContain('defaults_sealed')
    expect(cols).not.toContain('script')
    const row = db.prepare('SELECT description, tags, variables, defaults_sealed, destructive FROM snippets').get()
    expect({ ...row }).toEqual({ description: '', tags: '[]', variables: '[]', defaults_sealed: null, destructive: 0 })
    // Migration 5's table is untouched.
    const tunnelCols = db.prepare("SELECT name FROM pragma_table_info('tunnels')").all().map((r) => (r as { name: string }).name)
    expect(tunnelCols).toEqual([
      'id', 'label', 'host_id', 'environment_id', 'type', 'bind_address', 'bind_port',
      'target_host', 'target_port', 'auto_start', 'auto_reconnect', 'created_at', 'updated_at',
    ])
  })

  it('destructive is 0 or 1', () => {
    const db = openDatabase(':memory:')
    expect(() => insert(db, 's1', 'a', 2)).toThrow(/CHECK constraint failed/)
    insert(db, 's1', 'a', 1)
  })
})
