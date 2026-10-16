import type { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

export interface Migration {
  version: number
  name: string
  up: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init_audit',
    up: `
CREATE TABLE audit_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, actor_os_user TEXT NOT NULL, actor_machine TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, target_label TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied','info')),
  details TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE INDEX audit_events_ts ON audit_events(ts);
CREATE INDEX audit_events_action ON audit_events(action);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
`,
  },
]

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`

export function currentVersion(db: Db): number {
  db.exec(ENSURE_TABLE)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null
  }
  return row.v ?? 0
}

export function migrate(db: Db, list: Migration[] = migrations): { from: number; to: number } {
  const from = currentVersion(db)
  let to = from
  const insert = db.prepare(
    'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const m of list) {
    if (m.version <= from) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.up)
      insert.run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK')
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`migration ${m.version} (${m.name}) failed: ${reason}`, { cause: err })
    }
    to = m.version
  }
  return { from, to }
}
