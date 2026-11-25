import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, migrations } from '../../src/main/db/migrations'

const NOW = '2026-01-01T00:00:00.000Z'

/** A database at migration 16, before services needed a host. */
function before(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrations.filter((m) => m.version < 17))
  db.prepare("INSERT INTO regions(id, code, display_name, created_at, updated_at) VALUES ('r','default','Default',?,?)").run(NOW, NOW)
  db.prepare("INSERT INTO products(id, name, color, icon, created_at, updated_at) VALUES ('p','P','#112233','box',?,?)").run(NOW, NOW)
  return db
}
const env = (db: DatabaseSync, id: string): void => {
  db.prepare("INSERT INTO environments(id, name, color, product_id, created_at, updated_at) VALUES (?,?,'#aabbcc','p',?,?)").run(id, id, NOW, NOW)
}
const host = (db: DatabaseSync, id: string, label: string, address = '10.0.0.1'): void => {
  db.prepare("INSERT INTO hosts(id, label, address, region_id, created_at, updated_at) VALUES (?,?,?,'r',?,?)").run(id, label, address, NOW, NOW)
}
const member = (db: DatabaseSync, e: string, h: string, role: string): void => {
  db.prepare('INSERT INTO environment_hosts(environment_id, host_id, role) VALUES (?,?,?)').run(e, h, role)
}
const checkout = (db: DatabaseSync, id: string, e: string, h: string): void => {
  db.prepare("INSERT INTO deployments(id, name, environment_id, host_id, repo_path, default_branch, deploy_tag, created_at, updated_at) VALUES (?,?,?,?,'/srv','main','t',?,?)").run(id, id, e, h, NOW, NOW)
}
const app = (db: DatabaseSync, id: string, e: string, deployment: string | null): void => {
  db.prepare("INSERT INTO services(id, environment_id, name, kind, deployment_id, compose_service, url_check_from, created_at, updated_at) VALUES (?,?,?,'service',?,'web','mac',?,?)").run(id, e, id, deployment, NOW, NOW)
}
const dbService = (db: DatabaseSync, id: string, e: string, address: string, via: string | null): void => {
  db.prepare("INSERT INTO services(id, environment_id, name, kind, db_engine, db_address, db_port, via_host_id, created_at, updated_at) VALUES (?,?,?,'db','postgres',?,5432,?,?,?)").run(id, e, id, address, via, NOW, NOW)
}
const services = (db: DatabaseSync): { id: string; name: string; kind: string; host_id: string; environment_id: string; db_address: string | null }[] =>
  db.prepare('SELECT id, name, kind, host_id, environment_id, db_address FROM services ORDER BY environment_id, name').all() as never
const memberships = (db: DatabaseSync): unknown[] =>
  db.prepare('SELECT environment_id, host_id, role FROM environment_hosts ORDER BY environment_id, host_id').all().map((r) => ({ ...r }))

describe('migration 17 (services on hosts)', () => {
  it('an app service runs on its checkout host', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'a'); host(db, 'h2', 'b')
    member(db, 'e', 'h1', 'app'); member(db, 'e', 'h2', 'app')
    checkout(db, 'd', 'e', 'h2'); app(db, 'web', 'e', 'd')
    migrate(db)
    expect(services(db).find((s) => s.id === 'web')!.host_id).toBe('h2')
  })

  it('an app service without a checkout runs on the busiest app host, then any member', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'a'); host(db, 'h2', 'b')
    member(db, 'e', 'h1', 'db'); member(db, 'e', 'h2', 'app')
    app(db, 'web', 'e', null)
    env(db, 'f'); member(db, 'f', 'h1', 'bastion'); app(db, 'api', 'f', null)
    migrate(db)
    expect(services(db).find((s) => s.id === 'web')!.host_id).toBe('h2')
    expect(services(db).find((s) => s.id === 'api')!.host_id).toBe('h1')
  })

  it('a db with no via host lands on the member whose address it named, now at 127.0.0.1', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'demo-prod-db', '203.0.113.68'); host(db, 'h2', 'prod')
    member(db, 'e', 'h1', 'db'); member(db, 'e', 'h2', 'app')
    dbService(db, 'demo-prod', 'e', '203.0.113.68', null)
    migrate(db)
    expect(services(db).filter((s) => s.host_id === 'h1')).toEqual([
      { id: 'demo-prod', name: 'demo-prod', kind: 'db', host_id: 'h1', environment_id: 'e', db_address: '127.0.0.1' },
    ])
  })

  it('a db keeps its via host and address', () => {
    const db = before()
    env(db, 'e'); host(db, 'b', 'bastion'); member(db, 'e', 'b', 'bastion')
    dbService(db, 'rds', 'e', 'rds.aws', 'b')
    migrate(db)
    expect(services(db)).toEqual([{ id: 'rds', name: 'rds', kind: 'db', host_id: 'b', environment_id: 'e', db_address: 'rds.aws' }])
  })

  it('a bare membership becomes a service named after the host, typed by its role, with the same memberships', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'web'); host(db, 'h2', 'db1'); host(db, 'h3', 'jump'); host(db, 'h4', 'misc')
    member(db, 'e', 'h1', 'app'); member(db, 'e', 'h2', 'db'); member(db, 'e', 'h3', 'bastion'); member(db, 'e', 'h4', 'other')
    app(db, 'web', 'e', null) // takes h1 and the name "web"
    const was = memberships(db).map((m) => ({ ...(m as object), role: (m as { role: string }).role === 'other' ? 'app' : (m as { role: string }).role }))
    migrate(db)
    expect(services(db).map((s) => [s.name, s.kind, s.host_id])).toEqual([
      ['db1', 'db', 'h2'], ['jump', 'bastion', 'h3'], ['misc', 'service', 'h4'], ['web', 'service', 'h1'],
    ])
    expect(memberships(db)).toEqual(was)
  })

  it('a placeholder name already used gets a number', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'web'); host(db, 'h2', 'other')
    member(db, 'e', 'h1', 'app'); member(db, 'e', 'h2', 'app')
    app(db, "web", "e", null) // lands on h2: app hosts tie, and "other" sorts first
    migrate(db)
    expect(services(db).map((s) => s.name).sort()).toEqual(['web', 'web 2'])
  })

  it('a service in an environment with no hosts is audited and dropped', () => {
    const db = before()
    env(db, 'e'); app(db, 'lost', 'e', null)
    migrate(db)
    expect(services(db)).toEqual([])
    expect(db.prepare("SELECT target_id FROM audit_events WHERE action = 'service.dropped_without_host'").all().map((r) => ({ ...r }))).toEqual([{ target_id: 'lost' }])
  })

  it('membership is derived: deleting a host deletes its services and its membership', () => {
    const db = before()
    env(db, 'e'); host(db, 'h1', 'web'); member(db, 'e', 'h1', 'app')
    migrate(db)
    db.prepare("DELETE FROM hosts WHERE id = 'h1'").run()
    expect(services(db)).toEqual([])
    expect(memberships(db)).toEqual([])
  })
})
