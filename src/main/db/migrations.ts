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
  {
    version: 3,
    name: 'inventory',
    up: `
CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
  icon TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', repo_url TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE hosts(id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE COLLATE NOCASE, address TEXT NOT NULL,
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  jump_host_id TEXT REFERENCES hosts(id),
  tags TEXT NOT NULL DEFAULT '[]', os_icon TEXT NOT NULL DEFAULT 'linux', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (jump_host_id IS NULL OR jump_host_id <> id));
CREATE TABLE environments(id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
  default_identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  default_port INTEGER CHECK (default_port IS NULL OR default_port BETWEEN 1 AND 65535),
  default_jump_host_id TEXT REFERENCES hosts(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE product_environments(product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, PRIMARY KEY(product_id, environment_id));
CREATE TABLE environment_hosts(environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('app','db','bastion','other')), PRIMARY KEY(environment_id, host_id));
CREATE TABLE host_vaults(host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, PRIMARY KEY(host_id, vault_id));
CREATE INDEX product_environments_env ON product_environments(environment_id);
CREATE INDEX environment_hosts_host ON environment_hosts(host_id);
CREATE INDEX host_vaults_vault ON host_vaults(vault_id);
`,
  },
  {
    version: 4,
    name: 'ssh-terminal',
    up: `
ALTER TABLE hosts ADD COLUMN keepalive_sec INTEGER CHECK (keepalive_sec IS NULL OR keepalive_sec BETWEEN 0 AND 3600);
ALTER TABLE hosts ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}';
CREATE TABLE known_hosts(id TEXT PRIMARY KEY, host TEXT NOT NULL, key_type TEXT NOT NULL, key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(host, key_type));
`,
  },
  {
    version: 5,
    name: 'tunnels',
    up: `
CREATE TABLE tunnels(id TEXT PRIMARY KEY, label TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('L','R','D')),
  bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
  target_host TEXT,
  target_port INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
  auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1)),
  auto_reconnect INTEGER NOT NULL DEFAULT 1 CHECK (auto_reconnect IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((type = 'D') = (target_host IS NULL AND target_port IS NULL)));
CREATE INDEX tunnels_host ON tunnels(host_id);
`,
  },
  {
    version: 6,
    name: 'snippets',
    // NOCASE folds ASCII only; labels are mostly ASCII, so that is accepted for v1.
    up: `
CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  script TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON array of TAG strings, sorted, unique
  variables TEXT NOT NULL DEFAULT '[]',   -- JSON array of { name, default } in first-use order
  destructive INTEGER NOT NULL DEFAULT 0 CHECK (destructive IN (0,1)), -- 1 = always needs the protected-env confirmation
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX snippets_label ON snippets (label COLLATE NOCASE);
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
