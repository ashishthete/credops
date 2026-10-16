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
  {
    version: 2,
    name: 'vaults',
    up: `
CREATE TABLE vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
  wrapped_key TEXT, kdf_params TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO vaults VALUES ('00000000-0000-4000-8000-000000000001','Default','#5b8cff',NULL,NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE secrets(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('password','token','env','webhook','api_key')),
  value_enc TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(vault_id, name));
CREATE TABLE ssh_keys(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  label TEXT NOT NULL, key_type TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  private_key_enc TEXT, passphrase_enc TEXT,
  source TEXT NOT NULL CHECK (source IN ('file','imported','generated')), file_path TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((source = 'file') = (file_path IS NOT NULL)), CHECK (source = 'file' OR private_key_enc IS NOT NULL));
CREATE TABLE identities(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  label TEXT NOT NULL, username TEXT NOT NULL, auth TEXT NOT NULL CHECK (auth IN ('agent','key','password')),
  ssh_key_id TEXT REFERENCES ssh_keys(id), password_enc TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (auth <> 'key' OR ssh_key_id IS NOT NULL), CHECK (auth <> 'password' OR password_enc IS NOT NULL));
CREATE TABLE vault_state(id INTEGER PRIMARY KEY CHECK (id = 1), failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_failed_at TEXT, quick_unlock TEXT NOT NULL DEFAULT 'off' CHECK (quick_unlock IN ('off','touchId','login')),
  quick_unlock_blob TEXT, auto_lock_minutes INTEGER DEFAULT 15);
INSERT INTO vault_state(id) VALUES (1);
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
