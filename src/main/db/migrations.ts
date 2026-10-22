import type { DatabaseSync } from 'node:sqlite'
import { AuditLog } from '../audit/audit-log'
import { ssoMigration } from './sso-migration'
import { REGIONS_REPORT_KEY, hasRepoCredentials, stripRepoCredentials, type RegionsUpgradeReport } from '../../shared/inventory'

export type Db = DatabaseSync

export interface Migration {
  version: number
  name: string
  up: string
  /** Data fix-up run in the same transaction right after `up`. */
  after?: (db: Db) => void
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
    // The script and the variable defaults are sealed with the Default vault (AAD snippet:<id>:script and
    // snippet:<id>:defaults); label, description, tags, variable names and destructive stay plaintext metadata.
    up: `
CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  script_sealed TEXT NOT NULL,            -- sealed script
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON array of TAG strings, sorted, unique
  variables TEXT NOT NULL DEFAULT '[]',   -- JSON array of variable names in first-use order
  defaults_sealed TEXT,                   -- sealed JSON object { name: default }, or NULL when there are none
  destructive INTEGER NOT NULL DEFAULT 0 CHECK (destructive IN (0,1)), -- 1 = always needs the protected-env confirmation
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX snippets_label ON snippets (label COLLATE NOCASE);
`,
  },
  {
    version: 7,
    name: 'deployments',
    up: `
ALTER TABLE environments ADD COLUMN versioned INTEGER NOT NULL DEFAULT 0 CHECK (versioned IN (0,1));
ALTER TABLE environments ADD COLUMN auto_rollback INTEGER NOT NULL DEFAULT 1 CHECK (auto_rollback IN (0,1));
ALTER TABLE environments ADD COLUMN current_version TEXT;
ALTER TABLE environments ADD COLUMN domain TEXT;
CREATE TABLE deployments(id TEXT PRIMARY KEY, name TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  repo_url TEXT, compose_project TEXT,
  repo_path TEXT NOT NULL, default_branch TEXT NOT NULL,
  compose_file TEXT NOT NULL DEFAULT 'docker-compose.yml',
  deploy_tag TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  urls TEXT NOT NULL DEFAULT '[]',
  health_status INTEGER NOT NULL DEFAULT 200 CHECK (health_status BETWEEN 100 AND 599),
  health_timeout_sec INTEGER NOT NULL DEFAULT 60 CHECK (health_timeout_sec BETWEEN 5 AND 600),
  db_backup INTEGER NOT NULL DEFAULT 0 CHECK (db_backup IN (0,1)), backup_dir TEXT,
  pre_hook TEXT, post_hook TEXT,
  build_timeout_sec INTEGER NOT NULL DEFAULT 300 CHECK (build_timeout_sec BETWEEN 10 AND 3600),
  compose_timeout_sec INTEGER NOT NULL DEFAULT 120 CHECK (compose_timeout_sec BETWEEN 10 AND 3600),
  use_sudo TEXT NOT NULL DEFAULT 'auto' CHECK (use_sudo IN ('auto','yes','no')),
  become_secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  managed_env INTEGER NOT NULL DEFAULT 0 CHECK (managed_env IN (0,1)), env_template TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (db_backup = 0 OR backup_dir IS NOT NULL),
  CHECK (managed_env = 0 OR env_template IS NOT NULL));
CREATE UNIQUE INDEX deployments_name ON deployments(environment_id, name COLLATE NOCASE);
CREATE INDEX deployments_host ON deployments(host_id);
CREATE TABLE deployment_vaults(deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, PRIMARY KEY(deployment_id, vault_id));
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
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
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
CREATE TABLE services(id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('service','db')),
  position INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '',
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  compose_service TEXT, url TEXT, url_check_from TEXT CHECK (url_check_from IN ('mac','host')),
  last_deployed_commit TEXT, last_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  db_engine TEXT CHECK (db_engine IN ('postgres','mysql','mongodb','redis','other')),
  db_address TEXT, db_port INTEGER CHECK (db_port BETWEEN 1 AND 65535),
  via_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  local_port INTEGER CHECK (local_port BETWEEN 1 AND 65535),
  tunnel_id TEXT REFERENCES tunnels(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (kind = 'db' OR (compose_service IS NOT NULL AND url_check_from IS NOT NULL
    AND db_engine IS NULL AND db_address IS NULL AND db_port IS NULL AND via_host_id IS NULL
    AND local_port IS NULL AND tunnel_id IS NULL)),
  CHECK (kind = 'service' OR (db_engine IS NOT NULL AND db_address IS NOT NULL AND db_port IS NOT NULL
    AND deployment_id IS NULL AND compose_service IS NULL AND url IS NULL AND url_check_from IS NULL
    AND last_deployed_commit IS NULL AND last_release_id IS NULL)));
CREATE UNIQUE INDEX services_name ON services(environment_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX services_compose ON services(deployment_id, compose_service) WHERE deployment_id IS NOT NULL;
CREATE INDEX services_env ON services(environment_id, position);
`,
  },
  {
    version: 8,
    name: 'notifications',
    up: `
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE environment_integrations(
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  notify_events TEXT NOT NULL DEFAULT '[]',              -- JSON NotifyEventKey[]
  teams_webhook_secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  email_to TEXT NOT NULL DEFAULT '[]', email_cc TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  qa_on_deploy INTEGER NOT NULL DEFAULT 0 CHECK (qa_on_deploy IN (0,1)),
  qa_repo TEXT, qa_workflow TEXT, qa_ref TEXT,
  qa_wait INTEGER NOT NULL DEFAULT 0 CHECK (qa_wait IN (0,1)),
  updated_at TEXT NOT NULL,
  CHECK ((qa_repo IS NULL) = (qa_workflow IS NULL)));
CREATE TABLE notification_log(
  id TEXT PRIMARY KEY,                                    -- UUIDv7
  at TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('release','tunnel','test')),  -- release id = run stream id
  source_id TEXT NOT NULL,
  event TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('teams','email','macos','qa')),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
  detail TEXT,                                            -- redacted, <= 200 chars, never a URL
  UNIQUE (source_type, source_id, event, channel));
CREATE INDEX notification_log_at ON notification_log(at);
`,
  },
  {
    version: 9,
    name: 'hub',
    up: `
CREATE TABLE hub_link(id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL, hub_id TEXT NOT NULL, hub_name TEXT NOT NULL,
  user_oid TEXT, user_upn TEXT, user_name TEXT,
  session_enc BLOB, session_expires_at TEXT, refresh_enc BLOB,
  linked_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((session_enc IS NULL) = (session_expires_at IS NULL)));
CREATE TABLE hub_env_links(
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL, published_at TEXT NOT NULL, manifest_hash TEXT NOT NULL);
`,
  },
  {
    version: 10,
    name: 'qa_wait_minutes',
    up: `
ALTER TABLE environment_integrations ADD COLUMN qa_wait_minutes INTEGER CHECK (qa_wait_minutes IS NULL OR (qa_wait_minutes BETWEEN 5 AND 180));
`,
  },
  {
    version: 11,
    name: 'strip_repo_credentials',
    up: '',
    after: (db) => {
      stripSavedRepoCredentials(db)
    },
  },
  {
    // Regions on hosts, and one product per environment. migrate() holds a transaction, so the new columns can't
    // be NOT NULL (no table rebuild): triggers are the backstop, the stores reject first. What moved is recorded
    // in settings for the banner and summarised in one audit event; nothing is written when nothing moved.
    version: 12,
    name: 'regions',
    up: `
CREATE TABLE regions(id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE
    CHECK (length(code) BETWEEN 1 AND 63 AND code NOT GLOB '*[^a-z0-9-]*' AND code NOT GLOB '-*'),
  provider TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE hosts ADD COLUMN region_id TEXT REFERENCES regions(id);
ALTER TABLE environments ADD COLUMN product_id TEXT REFERENCES products(id);

CREATE TEMP TABLE m12_now AS SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at;
-- A random v4 UUID per row: the Hub validates ids as UUIDs.
CREATE TEMP VIEW m12_uuid AS SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))) AS id;

-- 1, 2: a Default region, only when there are hosts to put in it.
INSERT INTO regions(id, code, provider, display_name, created_at, updated_at)
  SELECT (SELECT id FROM m12_uuid), 'default', '', 'Default', at, at FROM m12_now WHERE EXISTS (SELECT 1 FROM hosts);
UPDATE hosts SET region_id = (SELECT id FROM regions WHERE code = 'default');

-- 3: the product whose name sorts first; the rest are dropped links.
CREATE TEMP TABLE m12_links AS
  SELECT pe.environment_id AS env_id, p.id AS product_id, p.name AS product_name,
    row_number() OVER (PARTITION BY pe.environment_id ORDER BY lower(p.name), p.id) AS n
  FROM product_environments pe JOIN products p ON p.id = pe.product_id;
UPDATE environments SET product_id = (SELECT product_id FROM m12_links WHERE env_id = environments.id AND n = 1);

-- No product: an Unassigned product, named past any product that already has the name.
CREATE TEMP TABLE m12_orphans AS SELECT id FROM environments WHERE product_id IS NULL;
CREATE TEMP TABLE m12_unassigned AS
  WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 1000),
  names(n, name) AS (SELECT n, CASE n WHEN 1 THEN 'Unassigned' ELSE 'Unassigned ' || n END FROM k)
  SELECT (SELECT id FROM m12_uuid) AS id, name FROM names
  WHERE EXISTS (SELECT 1 FROM m12_orphans) AND NOT EXISTS (SELECT 1 FROM products WHERE products.name = names.name)
  ORDER BY n LIMIT 1;
INSERT INTO products(id, name, color, icon, description, repo_url, created_at, updated_at)
  SELECT id, name, '#8a91a3', 'boxes', '', NULL, at, at FROM m12_unassigned, m12_now;
UPDATE environments SET product_id = (SELECT id FROM m12_unassigned) WHERE product_id IS NULL;

-- Names stay unique within a product: the later by created_at gets " (2)", and the id when that is taken too.
CREATE TEMP TABLE m12_renames AS
  SELECT id AS env_id, name AS old_name FROM (
    SELECT id, name, row_number() OVER (PARTITION BY product_id, lower(name) ORDER BY created_at, id) AS n FROM environments
  ) WHERE n > 1;
UPDATE environments SET name = name || ' (' || (
    SELECT n FROM (SELECT id, row_number() OVER (PARTITION BY product_id, lower(name) ORDER BY created_at, id) AS n FROM environments) r
    WHERE r.id = environments.id) || ')'
  WHERE id IN (SELECT env_id FROM m12_renames);
UPDATE environments SET name = name || ' ' || substr(id, 1, 8)
  WHERE id IN (SELECT env_id FROM m12_renames) AND EXISTS (
    SELECT 1 FROM environments o WHERE o.product_id = environments.product_id AND lower(o.name) = lower(environments.name) AND o.id <> environments.id);

INSERT INTO settings(key, value, updated_at)
  SELECT 'migration.regions.report', json_object(
    'region', json((SELECT json_object('id', id, 'code', code, 'displayName', display_name, 'hostCount', (SELECT count(*) FROM hosts))
      FROM regions)),
    'productLinks', json((SELECT json_group_array(json(x)) FROM (
      SELECT json_object('environmentId', e.id, 'environmentName', e.name,
        'kept', json_object('id', k.product_id, 'name', k.product_name),
        'removed', json((SELECT json_group_array(json(r)) FROM (
          SELECT json_object('id', product_id, 'name', product_name) AS r FROM m12_links WHERE env_id = e.id AND n > 1 ORDER BY n)))) AS x
      FROM m12_links k JOIN environments e ON e.id = k.env_id
      WHERE k.n = 1 AND EXISTS (SELECT 1 FROM m12_links d WHERE d.env_id = k.env_id AND d.n > 1)
      ORDER BY lower(e.name), e.id))),
    'unassigned', json((SELECT json_object('product', json_object('id', u.id, 'name', u.name),
      'environments', json((SELECT json_group_array(json(x)) FROM (
        SELECT json_object('id', e.id, 'name', e.name) AS x FROM environments e JOIN m12_orphans o ON o.id = e.id ORDER BY e.created_at, e.id))))
      FROM m12_unassigned u)),
    'renamed', json((SELECT json_group_array(json(x)) FROM (
      SELECT json_object('environmentId', e.id, 'from', r.old_name, 'to', e.name) AS x
      FROM m12_renames r JOIN environments e ON e.id = r.env_id ORDER BY e.created_at, e.id)))
  ), at FROM m12_now
  WHERE EXISTS (SELECT 1 FROM regions) OR EXISTS (SELECT 1 FROM m12_links WHERE n > 1)
    OR EXISTS (SELECT 1 FROM m12_orphans) OR EXISTS (SELECT 1 FROM m12_renames);

DROP VIEW m12_uuid;
DROP TABLE m12_now;
DROP TABLE m12_links;
DROP TABLE m12_orphans;
DROP TABLE m12_unassigned;
DROP TABLE m12_renames;

-- 4
DROP TABLE product_environments;
CREATE INDEX hosts_region ON hosts(region_id);
CREATE INDEX environments_product ON environments(product_id);
CREATE UNIQUE INDEX environments_product_name ON environments(product_id, name COLLATE NOCASE);
CREATE TRIGGER hosts_region_required BEFORE INSERT ON hosts WHEN NEW.region_id IS NULL
  BEGIN SELECT RAISE(ABORT, 'a host needs a region'); END;
CREATE TRIGGER hosts_region_kept BEFORE UPDATE OF region_id ON hosts WHEN NEW.region_id IS NULL
  BEGIN SELECT RAISE(ABORT, 'a host needs a region'); END;
CREATE TRIGGER environments_product_required BEFORE INSERT ON environments WHEN NEW.product_id IS NULL
  BEGIN SELECT RAISE(ABORT, 'an environment needs a product'); END;
CREATE TRIGGER environments_product_kept BEFORE UPDATE OF product_id ON environments WHEN NEW.product_id IS NULL
  BEGIN SELECT RAISE(ABORT, 'an environment needs a product'); END;
`,
    after: (db) => {
      auditRegionsUpgrade(db)
    },
  },
  {
    version: 13,
    name: 'playbook_ops',
    up: `
ALTER TABLE deployments ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE environments ADD COLUMN release_flow TEXT;
ALTER TABLE environments ADD COLUMN parallel_prepare INTEGER NOT NULL DEFAULT 1 CHECK (parallel_prepare IN (0,1));
ALTER TABLE environments ADD COLUMN prepare_cap INTEGER NOT NULL DEFAULT 3 CHECK (prepare_cap BETWEEN 1 AND 8);
ALTER TABLE services ADD COLUMN skip_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE releases ADD COLUMN operation TEXT;
ALTER TABLE releases ADD COLUMN playbook_source TEXT;
ALTER TABLE releases ADD COLUMN playbook_generated TEXT;
CREATE TABLE runbooks(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment_id, name));
`,
  },
  ssoMigration,
]

/** One audit event summarising migration 12's report, by id and count only; none when there is no report. */
function auditRegionsUpgrade(db: Db): void {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(REGIONS_REPORT_KEY) as { value: string } | undefined
  if (!row) return
  const r = JSON.parse(row.value) as RegionsUpgradeReport
  new AuditLog(db).appendInTx({
    action: 'inventory.regions_upgrade',
    outcome: 'info',
    targetType: 'region',
    targetId: r.region?.id,
    targetLabel: r.region?.code,
    details: {
      hostsMoved: r.region?.hostCount ?? 0,
      productLinksRemoved: r.productLinks.map((l) => ({ environmentId: l.environmentId, kept: l.kept.id, removed: l.removed.map((p) => p.id) })),
      unassigned: r.unassigned ? { productId: r.unassigned.product.id, environments: r.unassigned.environments.length } : null,
      renamed: r.renamed.map((x) => x.environmentId),
    },
  })
}

/**
 * Removes userinfo from every saved repo URL (products and deployments), leaving the rest byte for byte.
 * Audits the count only, and only when something changed. Safe to run again: clean rows are not touched.
 */
export function stripSavedRepoCredentials(db: Db): number {
  let count = 0
  for (const table of ['products', 'deployments'] as const) {
    const rows = db.prepare(`SELECT id, repo_url FROM ${table} WHERE repo_url IS NOT NULL`).all() as {
      id: string
      repo_url: string
    }[]
    const update = db.prepare(`UPDATE ${table} SET repo_url = ? WHERE id = ?`)
    for (const r of rows) {
      if (!hasRepoCredentials(r.repo_url)) continue
      update.run(stripRepoCredentials(r.repo_url), r.id)
      count++
    }
  }
  if (count > 0) {
    new AuditLog(db).appendInTx({
      action: 'repo.credentials_stripped',
      outcome: 'info',
      details: { count },
    })
  }
  return count
}

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`

export function currentVersion(db: Db): number {
  db.exec(ENSURE_TABLE)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null
  }
  return row.v ?? 0
}

/**
 * Applies every listed migration missing from schema_migrations, in ascending order, so a version merged in
 * after a later one (parallel phase branches) still runs. `to` is the highest version recorded afterwards.
 */
export function migrate(db: Db, list: Migration[] = migrations): { from: number; to: number } {
  const from = currentVersion(db)
  let to = from
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  )
  const insert = db.prepare(
    'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const m of [...list].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.up)
      m.after?.(db)
      insert.run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK')
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`migration ${m.version} (${m.name}) failed: ${reason}`, { cause: err })
    }
    to = Math.max(to, m.version)
  }
  return { from, to }
}
