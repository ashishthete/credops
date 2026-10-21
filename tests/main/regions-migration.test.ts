import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../src/main/db/connection'
import { AuditLog } from '../../src/main/audit/audit-log'
import { migrate, migrations } from '../../src/main/db/migrations'
import { REGIONS_REPORT_KEY, type RegionsUpgradeReport } from '../../src/shared/inventory'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-02-01T00:00:00.000Z'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A database at migration 11, before regions. */
function before(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrations.filter((m) => m.version < 12))
  return db
}

const product = (db: DatabaseSync, id: string, name: string): void => {
  db.prepare('INSERT INTO products(id, name, color, icon, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, name, '#112233', 'box', NOW, NOW)
}
const env = (db: DatabaseSync, id: string, name: string, products: string[] = [], at = NOW): void => {
  db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, name, '#aabbcc', at, at)
  for (const p of products) db.prepare('INSERT INTO product_environments(product_id, environment_id) VALUES (?,?)').run(p, id)
}
const host = (db: DatabaseSync, id: string, label: string): void => {
  db.prepare('INSERT INTO hosts(id, label, address, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, label, '10.0.0.1', NOW, NOW)
}
const report = (db: DatabaseSync): RegionsUpgradeReport | undefined => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(REGIONS_REPORT_KEY) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as RegionsUpgradeReport) : undefined
}
const upgradeEvents = (db: DatabaseSync): { outcome: string; target_id: string | null; target_label: string | null; details: string }[] =>
  db.prepare("SELECT outcome, target_id, target_label, details FROM audit_events WHERE action = 'inventory.regions_upgrade'").all() as never
const tableExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined

describe('migration 12 (regions)', () => {
  it('puts every host in a new Default region and gives each environment one product', () => {
    const db = before()
    host(db, 'h1', 'web-1')
    host(db, 'h2', 'db-1')
    product(db, 'p-globe', 'Globe')
    product(db, 'p-leaf', 'leaf')
    product(db, 'p-solo', 'Solo')
    env(db, 'e-multi', 'prod', ['p-globe', 'p-leaf'])
    env(db, 'e-one', 'staging', ['p-solo'])
    env(db, 'e-none-1', 'scratch', [], NOW)
    env(db, 'e-none-2', 'Scratch', [], LATER)
    env(db, 'e-none-3', 'lab', [])
    product(db, 'p-taken', 'Unassigned')
    migrate(db)

    const regions = db.prepare('SELECT * FROM regions').all() as { id: string; code: string; provider: string; display_name: string }[]
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ code: 'default', provider: '', display_name: 'Default' })
    expect(regions[0]!.id).toMatch(UUID)
    expect(db.prepare('SELECT DISTINCT region_id AS r FROM hosts').all()).toEqual([{ r: regions[0]!.id }])

    const unassigned = db.prepare("SELECT * FROM products WHERE name = 'Unassigned 2'").get() as { id: string; icon: string; color: string }
    expect(unassigned).toMatchObject({ icon: 'boxes', color: '#8a91a3' })
    expect(unassigned.id).toMatch(UUID)
    const envs = Object.fromEntries(
      (db.prepare('SELECT id, name, product_id FROM environments').all() as { id: string; name: string; product_id: string }[]).map((e) => [e.id, e]),
    )
    expect(envs['e-multi']).toMatchObject({ name: 'prod', product_id: 'p-globe' })
    expect(envs['e-one']).toMatchObject({ name: 'staging', product_id: 'p-solo' })
    expect(envs['e-none-1']).toMatchObject({ name: 'scratch', product_id: unassigned.id })
    expect(envs['e-none-2']).toMatchObject({ name: 'Scratch (2)', product_id: unassigned.id })
    expect(envs['e-none-3']).toMatchObject({ name: 'lab', product_id: unassigned.id })
    expect(tableExists(db, 'product_environments')).toBe(false)

    expect(report(db)).toEqual({
      region: { id: regions[0]!.id, code: 'default', displayName: 'Default', hostCount: 2 },
      productLinks: [
        { environmentId: 'e-multi', environmentName: 'prod', kept: { id: 'p-globe', name: 'Globe' }, removed: [{ id: 'p-leaf', name: 'leaf' }] },
      ],
      unassigned: {
        product: { id: unassigned.id, name: 'Unassigned 2' },
        environments: [
          { id: 'e-none-1', name: 'scratch' },
          { id: 'e-none-3', name: 'lab' },
          { id: 'e-none-2', name: 'Scratch (2)' },
        ],
      },
      renamed: [{ environmentId: 'e-none-2', from: 'Scratch', to: 'Scratch (2)' }],
    })

    // The audit event commits with the migration: ids and counts only, no names.
    const events = upgradeEvents(db)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ outcome: 'info', target_id: regions[0]!.id, target_label: 'default' })
    expect(JSON.parse(events[0]!.details)).toEqual({
      hostsMoved: 2,
      productLinksRemoved: [{ environmentId: 'e-multi', kept: 'p-globe', removed: ['p-leaf'] }],
      unassigned: { productId: unassigned.id, environments: 3 },
      renamed: ['e-none-2'],
    })
    expect(events[0]!.details).not.toMatch(/Scratch|Globe|Unassigned/)
    expect(new AuditLog(db).verifyChain().ok).toBe(true)
  })

  it('keeps a renamed environment unique when the suffixed name is already taken', () => {
    const db = before()
    env(db, 'e1', 'lab', [], NOW)
    env(db, 'e2', 'lab (2)', [], NOW)
    env(db, 'e3', 'LAB', [], LATER)
    migrate(db)
    const names = (db.prepare('SELECT name FROM environments ORDER BY name').all() as { name: string }[]).map((r) => r.name.toLowerCase())
    expect(new Set(names).size).toBe(3)
    expect(report(db)!.renamed).toEqual([{ environmentId: 'e3', from: 'LAB', to: expect.stringMatching(/^LAB \(2\) e3/) }])
  })

  it('makes no region and writes no report on a fresh database', () => {
    const db = openDatabase(':memory:')
    expect(db.prepare('SELECT COUNT(*) AS n FROM regions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM products').get()).toEqual({ n: 0 })
    expect(report(db)).toBeUndefined()
    expect(upgradeEvents(db)).toEqual([])
  })

  it('reports only what changed: hosts with single-product environments report the region and nothing else', () => {
    const db = before()
    host(db, 'h1', 'web-1')
    product(db, 'p1', 'Shop')
    env(db, 'e1', 'prod', ['p1'])
    migrate(db)
    expect(report(db)).toMatchObject({ productLinks: [], unassigned: null, renamed: [], region: { hostCount: 1 } })
    expect(db.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 1 })
  })

  it('reports product changes without a region when no hosts exist', () => {
    const db = before()
    env(db, 'e1', 'prod')
    migrate(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM regions').get()).toEqual({ n: 0 })
    expect(report(db)).toMatchObject({ region: null, unassigned: { product: { name: 'Unassigned' } } })
  })

  it('writes no report when nothing moved', () => {
    const db = before()
    product(db, 'p1', 'Shop')
    env(db, 'e1', 'prod', ['p1'])
    migrate(db)
    expect(report(db)).toBeUndefined()
    expect(upgradeEvents(db)).toEqual([])
  })

  it('rejects a NULL region on hosts and a NULL product on environments', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO regions(id, code, display_name, created_at, updated_at) VALUES ('r1','eu-west-1','EU',?,?)").run(NOW, NOW)
    db.prepare('INSERT INTO products(id, name, color, icon, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('p1', 'Shop', '#112233', 'box', NOW, NOW)
    expect(() => db.prepare('INSERT INTO hosts(id, label, address, created_at, updated_at) VALUES (?,?,?,?,?)').run('h1', 'a', 'x', NOW, NOW)).toThrow(
      /host needs a region/,
    )
    db.prepare('INSERT INTO hosts(id, label, address, region_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('h1', 'a', 'x', 'r1', NOW, NOW)
    expect(() => db.prepare('UPDATE hosts SET region_id = NULL').run()).toThrow(/host needs a region/)
    expect(() => db.prepare('UPDATE hosts SET region_id = ?').run('nope')).toThrow(/FOREIGN KEY/)

    expect(() =>
      db.prepare('INSERT INTO environments(id, name, color, created_at, updated_at) VALUES (?,?,?,?,?)').run('e1', 'prod', '#aabbcc', NOW, NOW),
    ).toThrow(/environment needs a product/)
    db.prepare('INSERT INTO environments(id, name, color, product_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('e1', 'prod', '#aabbcc', 'p1', NOW, NOW)
    expect(() => db.prepare('UPDATE environments SET product_id = NULL').run()).toThrow(/environment needs a product/)
    expect(() =>
      db.prepare('INSERT INTO environments(id, name, color, product_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('e2', 'PROD', '#aabbcc', 'p1', NOW, NOW),
    ).toThrow(/UNIQUE/)
    expect(() => db.prepare('DELETE FROM regions').run()).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare('DELETE FROM products').run()).toThrow(/FOREIGN KEY/)
  })

  it('checks region codes', () => {
    const db = openDatabase(':memory:')
    const add = (id: string, code: string): void => {
      db.prepare('INSERT INTO regions(id, code, display_name, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, code, code, NOW, NOW)
    }
    add('r1', 'eu-west-1')
    expect(() => add('r2', 'EU-WEST-1')).toThrow()
    for (const bad of ['', '-eu', 'eu_west', 'Eu', 'x'.repeat(64)]) expect(() => add(`r-${bad}`, bad)).toThrow()
    add('r3', 'a'.repeat(63))
  })
})
