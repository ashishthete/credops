import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, migrations, stripSavedRepoCredentials } from '../../src/main/db/migrations'

const SECRET = 'ghp_SuperSecretToken123'

function seeded(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db, migrations.filter((m) => m.version <= 10))
  db.exec("INSERT INTO environments(id,name,color,created_at,updated_at) VALUES ('e','e','#000','t','t')")
  db.exec("INSERT INTO hosts(id,label,address,created_at,updated_at) VALUES ('h','h','1.2.3.4','t','t')")
  const p = db.prepare("INSERT INTO products(id,name,color,icon,repo_url,created_at,updated_at) VALUES (?,?,'#000','i',?,'t','t')")
  p.run('p1', 'cred', `https://user:${SECRET}@github.com/acme/app.git`)
  p.run('p2', 'tok', `https://${SECRET}@github.com/acme/tok.git?x=1#f`)
  p.run('p3', 'clean', 'https://github.com/acme/clean.git')
  p.run('p4', 'null', null)
  p.run('p5', 'ssh', 'git@github.com:acme/ssh.git')
  const d = db.prepare("INSERT INTO deployments(id,name,environment_id,host_id,repo_url,repo_path,default_branch,deploy_tag,created_at,updated_at) VALUES (?,?,'e','h',?,'/srv','main','t','t','t')")
  d.run('d1', 'cred', `https://oauth2:${SECRET}@gitlab.com/acme/api.git`)
  d.run('d2', 'clean', 'https://gitlab.com/acme/clean.git')
  d.run('d3', 'null', null)
  return db
}

const repoUrls = (db: DatabaseSync, t: string): unknown[] =>
  (db.prepare(`SELECT id, repo_url FROM ${t} ORDER BY id`).all() as { id: string; repo_url: string | null }[]).map((r) => r.repo_url)

describe('migration 11: strip saved repo credentials', () => {
  it('removes userinfo, keeps the rest, audits the count only', () => {
    const db = seeded()
    migrate(db, migrations.filter((m) => m.version <= 11))
    expect(repoUrls(db, 'products')).toEqual([
      'https://github.com/acme/app.git',
      'https://github.com/acme/tok.git?x=1#f',
      'https://github.com/acme/clean.git',
      null,
      'git@github.com:acme/ssh.git',
    ])
    expect(repoUrls(db, 'deployments')).toEqual(['https://gitlab.com/acme/api.git', 'https://gitlab.com/acme/clean.git', null])
    const ev = db.prepare('SELECT * FROM audit_events').all() as { action: string; details: string }[]
    expect(ev).toHaveLength(1)
    expect(ev[0].action).toBe('repo.credentials_stripped')
    expect(JSON.parse(ev[0].details)).toEqual({ count: 3 })
    expect(JSON.stringify(ev)).not.toMatch(/github|gitlab|ghp_|oauth2/)
  })

  it('is idempotent', () => {
    const db = seeded()
    migrate(db, migrations.filter((m) => m.version <= 11))
    const before = [repoUrls(db, 'products'), repoUrls(db, 'deployments')]
    expect(stripSavedRepoCredentials(db)).toBe(0)
    migrate(db, migrations.filter((m) => m.version <= 11))
    expect([repoUrls(db, 'products'), repoUrls(db, 'deployments')]).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 1 })
  })

  it('writes no audit event when nothing had credentials', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 })
  })
})
