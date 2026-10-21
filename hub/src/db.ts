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

// Phase 8's release tables without the foreign keys to inventory rows the Hub replaces on republish.
const RELEASES = `
CREATE TABLE releases(id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('release','rollback')),
  status TEXT NOT NULL CHECK (status IN ('preflight','ready','blocked','running','rolling_back',
    'succeeded','failed','rolled_back','cancelled','discarded')),
  version TEXT, previous_version TEXT,
  version_bump TEXT NOT NULL DEFAULT 'none' CHECK (version_bump IN ('major','minor','patch','none')),
  redeploy INTEGER NOT NULL DEFAULT 0 CHECK (redeploy IN (0,1)),
  rollback_of TEXT REFERENCES releases(id) ON DELETE SET NULL,
  options TEXT NOT NULL DEFAULT '{}', service_ids TEXT NOT NULL DEFAULT '[]', release_notes TEXT, error TEXT, playbook TEXT,
  triggered_by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX releases_env ON releases(environment_id, created_at);
CREATE TABLE deployment_runs(id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  deployment_id TEXT,
  deployment_name TEXT NOT NULL, host_id TEXT, host_label TEXT NOT NULL, position INTEGER NOT NULL,
  branch TEXT NOT NULL, previous_commit TEXT, deployed_commit TEXT,
  commits TEXT NOT NULL DEFAULT '[]', services TEXT NOT NULL DEFAULT '[]',
  whole_checkout INTEGER NOT NULL DEFAULT 1 CHECK (whole_checkout IN (0,1)), steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped',
    'cancelled','rolled_back','rollback_failed')),
  rolled_back INTEGER NOT NULL DEFAULT 0 CHECK (rolled_back IN (0,1)),
  backup_file TEXT, started_at TEXT, finished_at TEXT);
CREATE INDEX deployment_runs_release ON deployment_runs(release_id, position);
CREATE TABLE run_events(id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE(release_id, seq));
CREATE TRIGGER run_events_append_only BEFORE UPDATE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
-- What each service last deployed. Kept apart from services, whose rows a republish replaces.
CREATE TABLE service_deploy_state(service_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  last_deployed_commit TEXT, last_release_id TEXT);
`

// Phase 9's idempotency table, as the desktop keeps it: one row per (source, event, channel).
const NOTIFY = `
CREATE TABLE notification_log(
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('release','tunnel','test')),
  source_id TEXT NOT NULL,
  event TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('teams','email','macos','qa')),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
  detail TEXT,
  UNIQUE (source_type, source_id, event, channel));
CREATE INDEX notification_log_at ON notification_log(at);
`

// Unpublishing keeps an environment's row (and so its releases) with unpublished_at set; every published read
// filters on PUBLISHED. The grants it had are moved to unpublished_grants: they say who may still read its history.
const HISTORY = `
ALTER TABLE environments ADD COLUMN unpublished_at TEXT;
CREATE TABLE unpublished_grants(grant_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, deployment_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX unpublished_grants_env ON unpublished_grants(environment_id);
`

/** The SQL condition for an environment that is published now, for queries on `environments`. */
export const PUBLISHED = 'unpublished_at IS NULL'

// A desktop host can serve several environments, each publishing its own address, user and hops for it:
// hosts are keyed by (environment, id), and a deployment's host must be one of its own environment's.
// The new tables are renamed into place last, which also rewrites deployments' reference to hosts_v9.
const SHARED_HOSTS = `
CREATE TABLE hosts_v9(id TEXT NOT NULL, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  label TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
  hops TEXT NOT NULL, known_hosts TEXT NOT NULL, use_sudo TEXT NOT NULL, PRIMARY KEY (environment_id, id));
INSERT INTO hosts_v9(id, environment_id, label, address, port, username, hops, known_hosts, use_sudo)
  SELECT id, environment_id, label, address, port, username, hops, known_hosts, use_sudo FROM hosts;
CREATE TABLE deployments_v9(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, meta TEXT NOT NULL,
  FOREIGN KEY (environment_id, host_id) REFERENCES hosts_v9(environment_id, id) ON DELETE CASCADE);
INSERT INTO deployments_v9(id, environment_id, host_id, name, position, meta)
  SELECT id, environment_id, host_id, name, position, meta FROM deployments;
DROP TABLE deployments;
DROP TABLE hosts;
ALTER TABLE hosts_v9 RENAME TO hosts;
ALTER TABLE deployments_v9 RENAME TO deployments;
`

// The publisher's product and each host's region. Nullable: an older desktop's manifest has neither, and rows
// published before this get them on their next publish.
const PRODUCT_REGION = `
ALTER TABLE environments ADD COLUMN product_id TEXT;
ALTER TABLE environments ADD COLUMN product_name TEXT;
ALTER TABLE hosts ADD COLUMN region_code TEXT;
ALTER TABLE hosts ADD COLUMN region_name TEXT;
`

export const HUB_MIGRATIONS: Migration[] = [
  { version: 1, name: 'core', up: CORE },
  { version: 2, name: 'registry', up: REGISTRY },
  { version: 3, name: 'secrets', up: SECRETS },
  { version: 4, name: 'locks', up: LOCKS },
  { version: 5, name: 'services', up: SERVICES },
  { version: 6, name: 'releases', up: RELEASES },
  { version: 7, name: 'notify', up: NOTIFY },
  { version: 8, name: 'history', up: HISTORY },
  { version: 9, name: 'shared_hosts', up: SHARED_HOSTS },
  { version: 10, name: 'product_region', up: PRODUCT_REGION },
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
