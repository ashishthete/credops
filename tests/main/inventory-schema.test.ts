import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion, migrations } from '../../src/main/db/migrations'
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
