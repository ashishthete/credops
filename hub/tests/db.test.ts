import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ALL_GRANT_ID, DEFAULT_GROUP_ID } from '../../src/shared/hub'
import { HUB_MIGRATIONS, openHubDb } from '../src/db'
import { migrate } from '../../src/main/db/migrations'

describe('hub db', () => {
  it('migration 1 seeds Default and its all-grant', () => {
    const db = openHubDb(':memory:')
    const g = db.prepare('SELECT name, builtin FROM groups WHERE id = ?').get(DEFAULT_GROUP_ID)
    expect(g).toMatchObject({ name: 'Default', builtin: 1 })
    const gr = db.prepare('SELECT group_id, scope FROM grants WHERE id = ?').get(DEFAULT_ALL_GRANT_ID)
    expect(gr).toMatchObject({ group_id: DEFAULT_GROUP_ID, scope: 'all' })
    const id = db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }
    expect(id.value).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('default group and its grant survive a raw delete', () => {
    const db = openHubDb(':memory:')
    expect(() => db.exec(`DELETE FROM grants WHERE id = '${DEFAULT_ALL_GRANT_ID}'`)).toThrow(/builtin group/)
    expect(() => db.exec(`DELETE FROM groups WHERE id = '${DEFAULT_GROUP_ID}'`)).toThrow(/builtin group/)
  })

  it('audit rows cannot be updated or deleted', () => {
    const db = openHubDb(':memory:')
    db.exec(`INSERT INTO audit(ts, action, outcome, details, prev_hash, hash) VALUES ('t','a','success','{}','p','h')`)
    expect(() => db.exec(`UPDATE audit SET action = 'x'`)).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM audit')).toThrow(/append-only/)
  })

  it('grants_unique blocks a duplicate all-grant', () => {
    const db = openHubDb(':memory:')
    expect(() =>
      db.exec(`INSERT INTO grants VALUES ('dup','${DEFAULT_GROUP_ID}','all',NULL,NULL,'t')`),
    ).toThrow(/UNIQUE/)
  })

  it('migrating twice is a no-op', () => {
    const db = openHubDb(':memory:')
    expect(migrate(db, HUB_MIGRATIONS)).toEqual({ from: 6, to: 6 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n).toBe(1)
  })

  it('upgrades a v4 hub with apps to v5: deployments survive and no foreign key breaks', () => {
    const v4 = new DatabaseSync(':memory:')
    v4.exec('PRAGMA foreign_keys = ON')
    expect(migrate(v4, HUB_MIGRATIONS.filter((m) => m.version <= 4))).toMatchObject({ to: 4 })
    const cols = (v4.prepare('PRAGMA table_info(deployments)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('app_id')
    v4.exec(`INSERT INTO environments VALUES ('e1','prod',0,0,0,NULL,'{}','h','u','t')`)
    v4.exec(`INSERT INTO hosts VALUES ('h1','e1','l','a',22,'u','[]','[]','auto')`)
    v4.exec(`INSERT INTO apps VALUES ('a1','e1','shop','{}')`)
    v4.exec(`INSERT INTO deployments VALUES ('d1','e1','h1','a1','web',0,'{}')`)
    migrate(v4, HUB_MIGRATIONS)
    expect(v4.prepare('SELECT name FROM deployments WHERE id = ?').get('d1')).toEqual({ name: 'web' })
    expect(v4.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect((v4.prepare('PRAGMA table_info(deployments)').all() as { name: string }[]).map((c) => c.name)).not.toContain('app_id')
  })
})
