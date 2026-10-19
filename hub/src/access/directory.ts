import { DEFAULT_GROUP_ID, type HubIdentity, type HubRole, type HubUser, type HubUserStatus } from '../../../src/shared/hub'
import type { HubConfig } from '../config'
import type { HubDb } from '../db'

interface UserRow {
  oid: string
  upn: string
  name: string
  role: HubRole
  disabled: number
  created_at: string
  last_seen_at: string | null
}

export class Directory {
  constructor(
    private readonly db: HubDb,
    private readonly opts: { firstAdmin: HubConfig['firstAdmin']; now: () => Date },
  ) {}

  private groupIds(oid: string): string[] {
    return (
      this.db.prepare('SELECT group_id FROM group_members WHERE oid = ? ORDER BY group_id').all(oid) as {
        group_id: string
      }[]
    ).map((r) => r.group_id)
  }

  private toUser(r: UserRow): HubUser {
    const groupIds = this.groupIds(r.oid)
    const status: HubUserStatus = r.disabled ? 'disabled' : groupIds.length === 0 ? 'pending' : 'active'
    return {
      oid: r.oid,
      upn: r.upn,
      name: r.name,
      role: r.role,
      status,
      groupIds,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }
  }

  get(oid: string): HubUser | null {
    const r = this.db.prepare('SELECT * FROM users WHERE oid = ?').get(oid) as unknown as UserRow | undefined
    return r ? this.toUser(r) : null
  }

  list(): HubUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY upn COLLATE NOCASE').all() as unknown as UserRow[]
    return rows.map((r) => this.toUser(r))
  }

  status(oid: string): HubUserStatus {
    return this.get(oid)?.status ?? 'pending'
  }

  touch(oid: string): void {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE oid = ?').run(this.opts.now().toISOString(), oid)
  }

  upsertOnSignIn(id: HubIdentity & { tid: string }): { user: HubUser; created: boolean; bootstrapped: boolean } {
    const now = this.opts.now().toISOString()
    const fa = this.opts.firstAdmin
    const matchesFirstAdmin =
      (fa.oid !== undefined && fa.oid.toLowerCase() === id.oid.toLowerCase()) ||
      (fa.upn !== undefined && fa.upn.toLowerCase() === id.upn.toLowerCase())
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT * FROM users WHERE oid = ?').get(id.oid) as unknown as UserRow | undefined
      const adminExists =
        (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number })
          .n > 0
      const bootstrap = matchesFirstAdmin && !adminExists && !existing?.disabled
      if (existing) {
        this.db.prepare('UPDATE users SET upn = ?, name = ?, tid = ? WHERE oid = ?').run(id.upn, id.name, id.tid, id.oid)
        if (bootstrap) this.db.prepare("UPDATE users SET role = 'admin' WHERE oid = ?").run(id.oid)
      } else {
        this.db
          .prepare('INSERT INTO users(oid, tid, upn, name, role, disabled, created_at) VALUES (?,?,?,?,?,0,?)')
          .run(id.oid, id.tid, id.upn, id.name, bootstrap ? 'admin' : 'maintainer', now)
      }
      if (bootstrap) {
        this.db
          .prepare('INSERT OR IGNORE INTO group_members(group_id, oid, added_at, added_by) VALUES (?,?,?,?)')
          .run(DEFAULT_GROUP_ID, id.oid, now, 'bootstrap')
      }
      this.db.exec('COMMIT')
      return { user: this.get(id.oid) as HubUser, created: !existing, bootstrapped: bootstrap }
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw err
    }
  }
}
