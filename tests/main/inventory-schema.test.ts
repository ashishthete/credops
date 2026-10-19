import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion, migrate, migrations } from '../../src/main/db/migrations'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { KeyStore } from '../../src/main/vault/key-store'
import { makeVault } from './vault-helpers'

const NOW = '2026-01-01T00:00:00.000Z'

describe('inventory schema', () => {
  it('migrates to the latest version', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBe(migrations.at(-1)!.version)
    for (const t of ['products', 'hosts', 'environments', 'product_environments', 'environment_hosts', 'host_vaults']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)).toBeDefined()
    }
  })

  it('fk fallbacks', async () => {
    const f = makeVault()
    await f.vault.setup('correct horse')
    const keys = new KeyStore(f.db, f.vault, f.audit, { sshDir: '/nonexistent-opsdeck-test', clipboard: { writeText: () => undefined, readText: () => '' }, defaultComment: 'tester@box' })
    const ids = new IdentityStore(f.db, f.vault, keys, f.audit)
    const ops = f.vault.createVault({ name: 'Ops', color: '#112233' })
    const identity = ids.create({ vaultId: ops.id, label: 'deploy', username: 'deploy', auth: 'agent' })

    f.db
      .prepare('INSERT INTO hosts(id, label, address, identity_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('h1', 'web-1', '10.0.0.1', identity.id, NOW, NOW)
    f.db
      .prepare('INSERT INTO environments(id, name, color, default_identity_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('e1', 'prod', '#aabbcc', identity.id, NOW, NOW)
    f.db.prepare('INSERT INTO host_vaults(host_id, vault_id) VALUES (?, ?)').run('h1', ops.id)

    f.vault.deleteVault(ops.id)

    expect(f.db.prepare('SELECT identity_id FROM hosts WHERE id = ?').get('h1')).toEqual({ identity_id: null })
    expect(f.db.prepare('SELECT default_identity_id FROM environments WHERE id = ?').get('e1')).toEqual({
      default_identity_id: null,
    })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM host_vaults').get()).toEqual({ n: 0 })

    f.db
      .prepare('INSERT INTO hosts(id, label, address, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('j1', 'bastion', '10.0.0.9', NOW, NOW)
    f.db.prepare('UPDATE environments SET default_jump_host_id = ? WHERE id = ?').run('j1', 'e1')
    expect(() => f.db.prepare('DELETE FROM hosts WHERE id = ?').run('j1')).toThrow(/FOREIGN KEY/i)
  })

  it('role and port checks', () => {
    const db = openDatabase(':memory:')
    const host = (id: string, port: number | null): void => {
      db.prepare('INSERT INTO hosts(id, label, address, port, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
        id,
        id,
        'a',
        port,
        NOW,
        NOW,
      )
    }
    host('h1', 22)
    db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run(
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
    const db = openDatabase(':memory:')
    const cols = (db.prepare('PRAGMA table_info(hosts)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['keepalive_sec', 'env_vars']))
    const insert = (id: string, keepalive: number): void => {
      db.prepare('INSERT INTO hosts(id, label, address, keepalive_sec, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
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
    const db = openDatabase(':memory:')
    const cols = (db.prepare('PRAGMA table_info(tunnels)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'id', 'label', 'host_id', 'environment_id', 'type', 'bind_address', 'bind_port', 'target_host',
      'target_port', 'auto_start', 'auto_reconnect', 'created_at', 'updated_at',
    ])
    db.prepare('INSERT INTO hosts(id, label, address, created_at, updated_at) VALUES (?,?,?,?,?)').run('h1', 'web', '10.0.0.1', NOW, NOW)
    db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run('e1', 'prod', '#aabbcc', NOW, NOW)
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
    db.prepare('INSERT INTO hosts(id, label, address, created_at, updated_at) VALUES (?,?,?,?,?)').run('h1', 'web', '10.0.0.1', NOW, NOW)
    db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run('e1', 'prod', '#aabbcc', NOW, NOW)
  }
  const dep = (db: ReturnType<typeof openDatabase>, extra = '', vals: (string | number)[] = []): void => {
    db.prepare(
      `INSERT INTO deployments(id, name, environment_id, host_id, ${extra}repo_path, default_branch, deploy_tag, created_at, updated_at) VALUES (?,?,?,?,${vals.map(() => '?,').join('')}?,?,?,?,?)`,
    ).run('d1', 'api', 'e1', 'h1', ...vals, '/srv/app', 'main', 'deploy_prod', NOW, NOW)
  }

  it('adds deployment tables, checks, cascades and the append-only trigger', () => {
    const db = openDatabase(':memory:')
    expect(migrations.some((m) => m.version === 7 && m.name === 'deployments')).toBe(true)
    expect(cols(db, 'apps')).toEqual(['id', 'environment_id', 'host_id', 'name', 'compose_project', 'description', 'created_at', 'updated_at'])
    expect(cols(db, 'deployments')).toEqual([
      'id', 'name', 'environment_id', 'host_id', 'app_id', 'repo_path', 'default_branch', 'compose_file', 'deploy_tag',
      'position', 'urls', 'health_status', 'health_timeout_sec', 'db_backup', 'backup_dir', 'pre_hook', 'post_hook',
      'build_timeout_sec', 'compose_timeout_sec', 'use_sudo', 'become_secret_id', 'managed_env', 'env_template',
      'created_at', 'updated_at',
    ])
    expect(cols(db, 'releases')).toEqual([
      'id', 'environment_id', 'kind', 'status', 'version', 'previous_version', 'version_bump', 'redeploy', 'rollback_of',
      'options', 'release_notes', 'error', 'playbook', 'triggered_by', 'created_at', 'started_at', 'finished_at',
    ])
    expect(cols(db, 'deployment_runs')).toEqual([
      'id', 'release_id', 'deployment_id', 'deployment_name', 'host_id', 'host_label', 'position', 'branch',
      'previous_commit', 'deployed_commit', 'commits', 'steps', 'status', 'rolled_back', 'backup_file', 'started_at',
      'finished_at',
    ])
    expect(cols(db, 'run_events')).toEqual(['id', 'release_id', 'seq', 'at', 'type', 'payload'])
    expect(cols(db, 'deployment_vaults')).toEqual(['deployment_id', 'vault_id'])

    seed(db)
    expect(() => dep(db, 'db_backup, ', [1])).toThrow(/CHECK/)
    expect(() => dep(db, 'managed_env, ', [1])).toThrow(/CHECK/)
    db.prepare('INSERT INTO apps(id, environment_id, host_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('a1', 'e1', 'h1', 'app', NOW, NOW)
    dep(db, 'app_id, ', ['a1'])
    db.prepare("INSERT INTO releases(id, environment_id, kind, status, triggered_by, created_at) VALUES ('r1','e1','release','ready','me@box',?)").run(NOW)
    db.prepare("INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES ('ev1','r1',1,?,'log','{}')").run(NOW)
    expect(() => db.exec("UPDATE run_events SET type = 'x'")).toThrow(/run_events is append-only/)

    db.prepare('DELETE FROM apps WHERE id = ?').run('a1')
    expect(db.prepare('SELECT app_id FROM deployments WHERE id = ?').get('d1')).toEqual({ app_id: null })

    db.prepare('DELETE FROM environments WHERE id = ?').run('e1')
    for (const t of ['apps', 'deployments', 'releases']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 })
    }
  })

  it('deleting a host cascades to its deployments', () => {
    const db = openDatabase(':memory:')
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
