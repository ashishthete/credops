import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/connection'
import { currentVersion } from '../../src/main/db/migrations'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { KeyStore } from '../../src/main/vault/key-store'
import { makeVault } from './vault-helpers'

const NOW = '2026-01-01T00:00:00.000Z'

describe('inventory schema', () => {
  it('migrates to 3', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBe(3)
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
})
