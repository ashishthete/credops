import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { migrate, type Migration } from '../../src/main/db/migrations'
import { DEFAULT_ALL_GRANT_ID, DEFAULT_GROUP_ID } from '../../src/shared/hub'

export type HubDb = DatabaseSync

const CORE = `
CREATE TABLE hub_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users(oid TEXT PRIMARY KEY, tid TEXT NOT NULL, upn TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','maintainer')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at TEXT NOT NULL, last_seen_at TEXT);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,
  oid TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX sessions_oid ON sessions(oid);
CREATE TABLE groups(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE group_members(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  oid TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  added_at TEXT NOT NULL, added_by TEXT NOT NULL, PRIMARY KEY (group_id, oid));
CREATE INDEX group_members_oid ON group_members(oid);
CREATE TABLE grants(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all','environment','deployment')),
  environment_id TEXT, deployment_id TEXT, created_at TEXT NOT NULL,
  CHECK ((scope = 'all') = (environment_id IS NULL)),
  CHECK ((scope = 'deployment') = (deployment_id IS NOT NULL)));
CREATE UNIQUE INDEX grants_unique ON grants(group_id, scope, IFNULL(environment_id,''), IFNULL(deployment_id,''));
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  actor_oid TEXT, actor_upn TEXT, actor_name TEXT, actor_role TEXT, via_group TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, target_label TEXT,
  outcome TEXT NOT NULL, details TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER groups_builtin_keep BEFORE DELETE ON groups WHEN OLD.builtin = 1
  BEGIN SELECT RAISE(ABORT, 'builtin group'); END;
CREATE TRIGGER grants_builtin_keep BEFORE DELETE ON grants
  WHEN (SELECT builtin FROM groups WHERE id = OLD.group_id) = 1
  BEGIN SELECT RAISE(ABORT, 'builtin group'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
INSERT INTO groups VALUES ('${DEFAULT_GROUP_ID}', 'Default', 'Everyone. Grants every environment.', 1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO grants VALUES ('${DEFAULT_ALL_GRANT_ID}', '${DEFAULT_GROUP_ID}', 'all', NULL, NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO hub_meta(key, value) VALUES ('hub_id', '${randomUUID()}');
`

const REGISTRY = `
CREATE TABLE environments(id TEXT PRIMARY KEY, name TEXT NOT NULL, protected INTEGER NOT NULL CHECK (protected IN (0,1)),
  versioned INTEGER NOT NULL, auto_rollback INTEGER NOT NULL, current_version TEXT,
  integrations TEXT NOT NULL, manifest_hash TEXT NOT NULL, published_by TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE hosts(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  label TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
  hops TEXT NOT NULL, known_hosts TEXT NOT NULL, use_sudo TEXT NOT NULL);
CREATE TABLE apps(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, meta TEXT NOT NULL);
CREATE TABLE deployments(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE, app_id TEXT, name TEXT NOT NULL,
  position INTEGER NOT NULL, meta TEXT NOT NULL);
`

// The Hub keeps no notion of apps: a deployment is a checkout, and its services come with the manifest.
const SERVICES = `
DROP TABLE apps;
ALTER TABLE deployments DROP COLUMN app_id;
CREATE TABLE services(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('service','db')), name TEXT NOT NULL, meta TEXT NOT NULL);
`

const SECRETS = `
CREATE TABLE hub_secrets(id TEXT NOT NULL, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('env','become','teams_webhook','sendgrid_api_key','github_token','anthropic_api_key')),
  value_enc TEXT NOT NULL, key_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (id, environment_id));
-- A NULL environment (Hub-wide secret) never collides in the primary key, so scope is also unique by this index.
CREATE UNIQUE INDEX hub_secrets_id_scope ON hub_secrets(id, IFNULL(environment_id,'*'));
CREATE UNIQUE INDEX hub_secrets_name ON hub_secrets(IFNULL(environment_id,'*'), name);
CREATE TABLE env_deploy_keys(environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, private_enc TEXT NOT NULL, key_id TEXT NOT NULL,
  created_at TEXT NOT NULL);
`

const LOCKS = `
CREATE TABLE env_locks(environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('release','manual')), release_id TEXT,
  holder_oid TEXT NOT NULL, holder_name TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, expires_at TEXT,
  -- A holder's freeze that a release of theirs took over; it comes back when that release ends (if not yet expired).
  frozen_reason TEXT, frozen_created_at TEXT, frozen_expires_at TEXT,
  CHECK ((kind = 'release') = (release_id IS NOT NULL)), CHECK ((kind = 'manual') = (expires_at IS NOT NULL)),
  CHECK ((frozen_reason IS NULL) = (frozen_created_at IS NULL) AND (frozen_created_at IS NULL) = (frozen_expires_at IS NULL)),
  CHECK (kind = 'release' OR frozen_reason IS NULL), CHECK (kind <> 'manual' OR reason IS NOT NULL));
`

export const HUB_MIGRATIONS: Migration[] = [
  { version: 1, name: 'core', up: CORE },
  { version: 2, name: 'registry', up: REGISTRY },
  { version: 3, name: 'secrets', up: SECRETS },
  { version: 4, name: 'locks', up: LOCKS },
  { version: 5, name: 'services', up: SERVICES },
]

export function openHubDb(file: string): HubDb {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db, HUB_MIGRATIONS)
  if (file !== ':memory:') chmodSync(file, 0o600)
  return db
}
