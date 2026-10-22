import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion, migrate, migrations } from '../../src/main/db/migrations'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { KeyStore } from '../../src/main/vault/key-store'
import { makeVault } from './vault-helpers'

const NOW = '2026-01-01T00:00:00.000Z'

/** Hosts need a region and environments a product: `r0` and `p0`. */
function withParents<T extends ReturnType<typeof openDatabase>>(db: T): T {
  db.prepare("INSERT INTO regions(id, code, display_name, created_at, updated_at) VALUES ('r0', 'test-1', 'Test', ?, ?)").run(NOW, NOW)
  db.prepare("INSERT INTO products(id, name, color, icon, created_at, updated_at) VALUES ('p0', 'Fixture', '#112233', 'boxes', ?, ?)").run(NOW, NOW)
  return db
}
const testDb = () => withParents(openDatabase(':memory:'))

describe('inventory schema', () => {
  it('migrates to the latest version', () => {
    const db = testDb()
    expect(currentVersion(db)).toBe(migrations.at(-1)!.version)
    for (const t of ['regions', 'products', 'hosts', 'environments', 'environment_hosts', 'host_vaults']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)).toBeDefined()
    }
  })

  it('fk fallbacks', async () => {
    const f = makeVault()
    await f.vault.setup('correct horse')
    withParents(f.db)
    const keys = new KeyStore(f.db, f.vault, f.audit, { sshDir: '/nonexistent-opsdeck-test', clipboard: { writeText: () => undefined, readText: () => '' }, defaultComment: 'tester@box' })
    const ids = new IdentityStore(f.db, f.vault, keys, f.audit)
    const ops = f.vault.createVault({ name: 'Ops', color: '#112233' })
    const identity = ids.create({ vaultId: ops.id, label: 'deploy', username: 'deploy', auth: 'agent' })

    f.db
      .prepare("INSERT INTO hosts(region_id, id, label, address, identity_id, created_at, updated_at) VALUES ('r0', ?,?,?,?,?,?)")
      .run('h1', 'web-1', '10.0.0.1', identity.id, NOW, NOW)
    f.db
      .prepare("INSERT INTO environments(product_id, id, name, color, default_identity_id, created_at, updated_at) VALUES ('p0', ?,?,?,?,?,?)")
      .run('e1', 'prod', '#aabbcc', identity.id, NOW, NOW)
    f.db.prepare('INSERT INTO host_vaults(host_id, vault_id) VALUES (?, ?)').run('h1', ops.id)

    f.vault.deleteVault(ops.id)

    expect(f.db.prepare('SELECT identity_id FROM hosts WHERE id = ?').get('h1')).toEqual({ identity_id: null })
    expect(f.db.prepare('SELECT default_identity_id FROM environments WHERE id = ?').get('e1')).toEqual({
      default_identity_id: null,
    })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM host_vaults').get()).toEqual({ n: 0 })

    f.db
      .prepare("INSERT INTO hosts(region_id, id, label, address, created_at, updated_at) VALUES ('r0', ?,?,?,?,?)")
      .run('j1', 'bastion', '10.0.0.9', NOW, NOW)
    f.db.prepare('UPDATE environments SET default_jump_host_id = ? WHERE id = ?').run('j1', 'e1')
    expect(() => f.db.prepare('DELETE FROM hosts WHERE id = ?').run('j1')).toThrow(/FOREIGN KEY/i)
  })

  it('role and port checks', () => {
    const db = testDb()
    const host = (id: string, port: number | null): void => {
      db.prepare("INSERT INTO hosts(region_id, id, label, address, port, created_at, updated_at) VALUES ('r0', ?,?,?,?,?,?)").run(
        id,
        id,
        'a',
        port,
        NOW,
        NOW,
      )
    }
    host('h1', 22)
    db.prepare("INSERT INTO environments(product_id, id, name, color, created_at, updated_at) VALUES ('p0', ?,?,?,?,?)").run(
      'e1',
      'prod',
      '#aabbcc',
      NOW,
      NOW,
    )
    expect(() => host('h2', 70000)).toThrow(/CHECK/i)
    expect(() =>
      db.prepare("INSERT INTO environment_hosts(environment_id, host_id, role) VALUES ('e1','h1','web')").run(),
    ).toThrow(/CHECK/i)
    expect(() => db.prepare("UPDATE hosts SET jump_host_id = 'h1' WHERE id = 'h1'").run()).toThrow(/CHECK/i)
  })

  it('migration 4 adds keepalive, env vars and known_hosts', () => {
    const db = testDb()
    const cols = (db.prepare('PRAGMA table_info(hosts)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['keepalive_sec', 'env_vars']))
    const insert = (id: string, keepalive: number): void => {
      db.prepare("INSERT INTO hosts(region_id, id, label, address, keepalive_sec, created_at, updated_at) VALUES ('r0', ?,?,?,?,?,?)").run(
        id,
        id,
        'a',
        keepalive,
        NOW,
        NOW,
      )
    }
    insert('h1', 0)
    expect(() => insert('h2', 4000)).toThrow(/CHECK/i)
    const known = (id: string): void => {
      db.prepare(
        'INSERT INTO known_hosts(id, host, key_type, key, fingerprint, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)',
      ).run(id, 'h:22', 'ssh-ed25519', 'k', 'SHA256:x', NOW, NOW)
    }
    known('k1')
    expect(() => known('k2')).toThrow(/UNIQUE/i)
  })

  it('migration 5 adds tunnels with checks and cascades', () => {
    const db = testDb()
    const cols = (db.prepare('PRAGMA table_info(tunnels)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'id', 'label', 'host_id', 'environment_id', 'type', 'bind_address', 'bind_port', 'target_host',
      'target_port', 'auto_start', 'auto_reconnect', 'created_at', 'updated_at',
    ])
    db.prepare("INSERT INTO hosts(region_id, id, label, address, created_at, updated_at) VALUES ('r0', ?,?,?,?,?)").run('h1', 'web', '10.0.0.1', NOW, NOW)
    db.prepare("INSERT INTO environments(product_id, id, name, color, created_at, updated_at) VALUES ('p0', ?,?,?,?,?)").run('e1', 'prod', '#aabbcc', NOW, NOW)
    const insert = db.prepare(
      `INSERT INTO tunnels(id, label, host_id, environment_id, type, bind_port, target_host, target_port, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    expect(() => insert.run('t1', 'd', 'h1', null, 'D', 1080, null, 22, NOW, NOW)).toThrow(/CHECK/)
    expect(() => insert.run('t2', 'l', 'h1', null, 'L', 5433, null, null, NOW, NOW)).toThrow(/CHECK/)
    insert.run('t3', 'l', 'h1', 'e1', 'L', 5433, 'localhost', 5432, NOW, NOW)
    db.prepare('DELETE FROM environments WHERE id = ?').run('e1')
    expect(db.prepare('SELECT environment_id FROM tunnels WHERE id = ?').get('t3')).toEqual({ environment_id: null })
    db.prepare('DELETE FROM hosts WHERE id = ?').run('h1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM tunnels').get()).toEqual({ n: 0 })
  })
})

describe('migration 7 (deployments)', () => {
  const cols = (db: ReturnType<typeof openDatabase>, t: string): string[] =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name)

  function seed(db: ReturnType<typeof openDatabase>): void {
    db.prepare("INSERT INTO hosts(region_id, id, label, address, created_at, updated_at) VALUES ('r0', ?,?,?,?,?)").run('h1', 'web', '10.0.0.1', NOW, NOW)
    db.prepare("INSERT INTO environments(product_id, id, name, color, created_at, updated_at) VALUES ('p0', ?,?,?,?,?)").run('e1', 'prod', '#aabbcc', NOW, NOW)
  }
  const dep = (db: ReturnType<typeof openDatabase>, extra = '', vals: (string | number)[] = []): void => {
    db.prepare(
      `INSERT INTO deployments(id, name, environment_id, host_id, ${extra}repo_path, default_branch, deploy_tag, created_at, updated_at) VALUES (?,?,?,?,${vals.map(() => '?,').join('')}?,?,?,?,?)`,
    ).run('d1', 'api', 'e1', 'h1', ...vals, '/srv/app', 'main', 'deploy_prod', NOW, NOW)
  }

  it('adds deployment tables, checks, cascades and the append-only trigger', () => {
    const db = testDb()
    expect(migrations.some((m) => m.version === 7 && m.name === 'deployments')).toBe(true)
    expect(cols(db, 'deployments')).toEqual([
      'id', 'name', 'environment_id', 'host_id', 'repo_url', 'compose_project', 'repo_path', 'default_branch', 'compose_file', 'deploy_tag',
      'position', 'urls', 'health_status', 'health_timeout_sec', 'db_backup', 'backup_dir', 'pre_hook', 'post_hook',
      'build_timeout_sec', 'compose_timeout_sec', 'use_sudo', 'become_secret_id', 'managed_env', 'env_template',
      'created_at', 'updated_at', 'steps',
    ])
    expect(cols(db, 'releases')).toEqual([
      'id', 'environment_id', 'kind', 'status', 'version', 'previous_version', 'version_bump', 'redeploy', 'rollback_of',
      'options', 'service_ids', 'release_notes', 'error', 'playbook', 'triggered_by', 'created_at', 'started_at', 'finished_at',
      'operation', 'playbook_source', 'playbook_generated',
    ])
    expect(cols(db, 'deployment_runs')).toEqual([
      'id', 'release_id', 'deployment_id', 'deployment_name', 'host_id', 'host_label', 'position', 'branch',
      'previous_commit', 'deployed_commit', 'commits', 'services', 'whole_checkout', 'steps', 'status', 'rolled_back', 'backup_file', 'started_at',
      'finished_at',
    ])
    expect(cols(db, 'run_events')).toEqual(['id', 'release_id', 'seq', 'at', 'type', 'payload'])
    expect(cols(db, 'deployment_vaults')).toEqual(['deployment_id', 'vault_id'])

    seed(db)
    expect(() => dep(db, 'db_backup, ', [1])).toThrow(/CHECK/)
    expect(() => dep(db, 'managed_env, ', [1])).toThrow(/CHECK/)
    dep(db, 'repo_url, compose_project, ', ['git@github.com:acme/api.git', 'api'])
    db.prepare("INSERT INTO releases(id, environment_id, kind, status, triggered_by, created_at) VALUES ('r1','e1','release','ready','me@box',?)").run(NOW)
    db.prepare("INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES ('ev1','r1',1,?,'log','{}')").run(NOW)
    expect(() => db.exec("UPDATE run_events SET type = 'x'")).toThrow(/run_events is append-only/)

    expect(db.prepare("SELECT service_ids FROM releases WHERE id = 'r1'").get()).toEqual({ service_ids: '[]' })

    db.prepare('DELETE FROM environments WHERE id = ?').run('e1')
    for (const t of ['deployments', 'releases']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 })
    }
  })

  const svc = (db: ReturnType<typeof openDatabase>, id: string, cols: string, vals: (string | number | null)[]): void => {
    db.prepare(
      `INSERT INTO services(id, environment_id, name, ${cols}, created_at, updated_at) VALUES (?,?,?,${vals.map(() => '?').join(',')},?,?)`,
    ).run(id, 'e1', id, ...vals, NOW, NOW)
  }

  it('migration 7 creates services and no apps table', () => {
    const db = testDb()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'apps'").get()).toBeUndefined()
    expect(cols(db, 'services')).toEqual([
      'id', 'environment_id', 'name', 'kind', 'position', 'description', 'deployment_id', 'compose_service', 'url',
      'url_check_from', 'last_deployed_commit', 'last_release_id', 'db_engine', 'db_address', 'db_port', 'via_host_id',
      'local_port', 'tunnel_id', 'created_at', 'updated_at', 'skip_unchanged',
    ])
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'services'").all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['services_name', 'services_compose', 'services_env']))
    expect(cols(db, 'deployment_runs')).toContain('whole_checkout')
    seed(db)
    dep(db)
    svc(db, 'esg', 'kind, deployment_id, compose_service, url_check_from', ['service', 'd1', 'esg', 'mac'])
    svc(db, 'pg', 'kind, db_engine, db_address, db_port', ['db', 'postgres', 'db.internal', 5432])
    expect(() => svc(db, 'ESG', 'kind, deployment_id, compose_service, url_check_from', ['service', 'd1', 'other', 'mac'])).toThrow(/UNIQUE/)
    expect(() => svc(db, 'bad-kind', 'kind', ['queue'])).toThrow(/CHECK/)
    expect(() => svc(db, 'no-compose', 'kind, url_check_from', ['service', 'mac'])).toThrow(/CHECK/)
    expect(() => svc(db, 'bad-port', 'kind, db_engine, db_address, db_port', ['db', 'redis', 'r', 70000])).toThrow(/CHECK/)
    db.prepare('DELETE FROM environments WHERE id = ?').run('e1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 0 })
  })

  it('a db row with compose_service violates the kind CHECK', () => {
    const db = testDb()
    seed(db)
    expect(() => svc(db, 'pg', 'kind, db_engine, db_address, db_port, compose_service', ['db', 'postgres', 'db', 5432, 'pg'])).toThrow(/CHECK/)
    expect(() => svc(db, 'esg', 'kind, compose_service, url_check_from, db_engine', ['service', 'esg', 'mac', 'redis'])).toThrow(/CHECK/)
  })

  it('compose_service is unique per checkout', () => {
    const db = testDb()
    seed(db)
    dep(db)
    const app = 'kind, deployment_id, compose_service, url_check_from'
    svc(db, 'esg', app, ['service', 'd1', 'esg', 'mac'])
    expect(() => svc(db, 'esg2', app, ['service', 'd1', 'esg', 'host'])).toThrow(/UNIQUE/)
    // Without a checkout the same compose service name is free.
    svc(db, 'loose1', app, ['service', null, 'esg', 'mac'])
    svc(db, 'loose2', app, ['service', null, 'esg', 'mac'])
  })

  it('deleting a checkout sets services.deployment_id null', () => {
    const db = testDb()
    seed(db)
    dep(db)
    svc(db, 'esg', 'kind, deployment_id, compose_service, url_check_from', ['service', 'd1', 'esg', 'mac'])
    db.prepare('DELETE FROM deployments WHERE id = ?').run('d1')
    expect(db.prepare("SELECT deployment_id, compose_service FROM services WHERE id = 'esg'").get()).toEqual({ deployment_id: null, compose_service: 'esg' })
  })

  it('deleting a host cascades to its deployments', () => {
    const db = testDb()
    seed(db)
    dep(db)
    db.prepare('DELETE FROM hosts WHERE id = ?').run('h1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM deployments').get()).toEqual({ n: 0 })
  })

  it('gives rows that existed before migration 7 the deploy defaults and a NULL domain', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, migrations.filter((m) => m.version < 7))
    db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run('e1', 'prod', '#aabbcc', NOW, NOW)
    migrate(db)
    expect(db.prepare('SELECT versioned, auto_rollback, current_version, domain FROM environments').get()).toEqual({
      versioned: 0,
      auto_rollback: 1,
      current_version: null,
      domain: null,
    })
    const d = (db.prepare('PRAGMA table_info(environments)').all() as { name: string; type: string; notnull: number; dflt_value: unknown }[]).find(
      (c) => c.name === 'domain',
    )
    expect(d).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })
})

describe('migration 8 (notifications)', () => {
  const cols = (db: ReturnType<typeof openDatabase>, t: string): string[] =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name)

  it('notifications migration adds settings, integrations and log', () => {
    const db = testDb()
    expect(currentVersion(db)).toBeGreaterThanOrEqual(8)
    expect(migrations.some((m) => m.version === 8 && m.name === 'notifications')).toBe(true)
    expect(cols(db, 'settings')).toEqual(['key', 'value', 'updated_at'])
    expect(cols(db, 'environment_integrations')).toEqual([
      'environment_id', 'notify_events', 'teams_webhook_secret_id', 'email_to', 'email_cc', 'qa_on_deploy',
      'qa_repo', 'qa_workflow', 'qa_ref', 'qa_wait', 'updated_at', 'qa_wait_minutes',
    ])
    expect(cols(db, 'notification_log')).toEqual(['id', 'at', 'source_type', 'source_id', 'event', 'channel', 'status', 'detail'])

    db.prepare("INSERT INTO environments(product_id, id, name, color, created_at, updated_at) VALUES ('p0', ?,?,?,?,?)").run('e1', 'prod', '#aabbcc', NOW, NOW)
    db.prepare("INSERT INTO environments(product_id, id, name, color, created_at, updated_at) VALUES ('p0', ?,?,?,?,?)").run('e2', 'uat', '#aabbcc', NOW, NOW)
    const vault = db.prepare('SELECT id FROM vaults LIMIT 1').get() as { id: string } | undefined
    const vaultId = vault?.id ?? 'v1'
    if (!vault) {
      db.prepare("INSERT INTO vaults(id, name, color, created_at, updated_at) VALUES (?, 'v', '#aabbcc', ?, ?)").run(vaultId, NOW, NOW)
    }
    db.prepare(
      "INSERT INTO secrets(id, vault_id, name, kind, value_enc, created_at, updated_at) VALUES ('s1', ?, 'hook', 'webhook', 'x', ?, ?)",
    ).run(vaultId, NOW, NOW)
    const integ = db.prepare(
      'INSERT INTO environment_integrations(environment_id, teams_webhook_secret_id, qa_repo, qa_workflow, updated_at) VALUES (?,?,?,?,?)',
    )
    integ.run('e1', 's1', null, null, NOW)
    expect(() => integ.run('e2', null, 'acme/app', null, NOW)).toThrow(/CHECK/)
    integ.run('e2', null, 'acme/app', 'qa.yml', NOW)

    db.prepare('DELETE FROM secrets WHERE id = ?').run('s1')
    expect(db.prepare('SELECT teams_webhook_secret_id AS s FROM environment_integrations WHERE environment_id = ?').get('e1')).toEqual({ s: null })
    db.prepare('DELETE FROM environments WHERE id = ?').run('e1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM environment_integrations').get()).toEqual({ n: 1 })

    const log = db.prepare(
      "INSERT INTO notification_log(id, at, source_type, source_id, event, channel, status) VALUES (?, ?, 'release', 'r1', 'release.failed', 'teams', 'pending')",
    )
    log.run('n1', NOW)
    expect(() => log.run('n2', NOW)).toThrow(/UNIQUE/)
  })
})
