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

export const HUB_MIGRATIONS: Migration[] = [{ version: 1, name: 'core', up: CORE }]

export function openHubDb(file: string): HubDb {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db, HUB_MIGRATIONS)
  if (file !== ':memory:') chmodSync(file, 0o600)
  return db
}
