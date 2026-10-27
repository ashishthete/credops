import { inTransaction } from '../../../src/main/db/tx'
import {
  DEFAULT_GROUP_ID,
  GROUP_NAME,
  MAX_BULK_MEMBERS,
  MAX_GRANTS_PER_GROUP,
  MAX_GROUPS,
  MAX_GROUP_DESCRIPTION,
  type GrantScope,
  type HubActor,
  type HubGrant,
  type HubGroup,
  type HubIdentity,
  type HubRole,
  type HubUser,
  type HubUserStatus,
} from '../../../src/shared/hub'
import type { HubAudit } from '../audit'
import type { SessionStore } from '../auth/sessions'
import { HubHttpError } from '../errors'
import type { HubConfig } from '../config'
import { PUBLISHED, type HubDb } from '../db'

interface UserRow {
  oid: string
  upn: string
  name: string
  role: HubRole
  disabled: number
  created_at: string
  last_seen_at: string | null
}

interface GrantRow {
  id: string
  group_id: string
  scope: 'all' | 'environment' | 'deployment'
  environment_id: string | null
  deployment_id: string | null
  created_at: string
}

function toGrant(r: GrantRow): HubGrant {
  const scope: GrantScope =
    r.scope === 'all'
      ? { kind: 'all' }
      : r.scope === 'environment'
        ? { kind: 'environment', environmentId: r.environment_id as string }
        : { kind: 'deployment', environmentId: r.environment_id as string, deploymentId: r.deployment_id as string }
  return { id: r.id, groupId: r.group_id, scope, createdAt: r.created_at }
}

export class Directory {
  private readonly accessListeners = new Set<() => void>()

  constructor(
    private readonly db: HubDb,
    private readonly opts: {
      firstAdmin: HubConfig['firstAdmin']
      now: () => Date
      ids: () => string
      audit: HubAudit
      sessions: SessionStore
    },
  ) {}

  /** Told after a committed change to who is in which group, what a group may reach, or a person's role or status. */
  onAccessChange(fn: () => void): () => void {
    this.accessListeners.add(fn)
    return () => void this.accessListeners.delete(fn)
  }

  private accessChanged(): void {
    for (const fn of this.accessListeners) {
      try {
        fn()
      } catch {
        // Listeners are advisory; the change is already committed.
      }
    }
  }

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

  status(oid: string): HubUserStatus | null {
    return this.get(oid)?.status ?? null
  }

  touch(oid: string): void {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE oid = ?').run(this.opts.now().toISOString(), oid)
  }

  upsertOnSignIn(id: HubIdentity & { tid: string }): { user: HubUser; created: boolean; bootstrapped: boolean; recovery: boolean; previousRole: HubRole | null } {
    const now = this.opts.now().toISOString()
    const fa = this.opts.firstAdmin
    // An object id never changes hands; a UPN can be renamed or reassigned. With an oid configured, only it counts.
    const matchesFirstAdmin =
      fa.oid !== undefined
        ? fa.oid.toLowerCase() === id.oid.toLowerCase()
        : fa.upn !== undefined && fa.upn.toLowerCase() === id.upn.toLowerCase()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT * FROM users WHERE oid = ?').get(id.oid) as unknown as UserRow | undefined
      const adminExists =
        (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number })
          .n > 0
      const bootstrap = matchesFirstAdmin && !adminExists && !existing?.disabled
      // A bootstrap after the Hub has had an admin before is a recovery, audited as such.
      const hadAdmin =
        (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n > 0 ||
        this.db
          .prepare("SELECT 1 AS x FROM audit WHERE action = 'session.create' AND details LIKE '%\"bootstrapped\":true%' LIMIT 1")
          .get() !== undefined
      const recovery = bootstrap && hadAdmin
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
      return { user: this.get(id.oid) as HubUser, created: !existing, bootstrapped: bootstrap, recovery, previousRole: existing?.role ?? null }
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---- groups ----

  private groupRow(id: string): { id: string; name: string; description: string; builtin: number; created_at: string; updated_at: string } {
    const r = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as
      | { id: string; name: string; description: string; builtin: number; created_at: string; updated_at: string }
      | undefined
    if (!r) throw new HubHttpError(404, 'not_found', 'Group not found')
    return r
  }

  private toGroup(r: { id: string; name: string; description: string; builtin: number; created_at: string; updated_at: string }): HubGroup {
    const members = this.db.prepare('SELECT oid FROM group_members WHERE group_id = ? ORDER BY added_at, oid').all(r.id) as { oid: string }[]
    const grants = this.db.prepare('SELECT * FROM grants WHERE group_id = ? ORDER BY created_at, id').all(r.id) as unknown as GrantRow[]
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      builtin: r.builtin === 1,
      memberOids: members.map((m) => m.oid),
      grants: grants.map(toGrant),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  getGroup(id: string): HubGroup {
    return this.toGroup(this.groupRow(id))
  }

  /** Three queries however many groups there are. */
  listGroups(): HubGroup[] {
    const rows = this.db.prepare('SELECT * FROM groups ORDER BY created_at, name').all() as unknown as Parameters<Directory['toGroup']>[0][]
    const members = new Map<string, string[]>()
    for (const m of this.db.prepare('SELECT group_id, oid FROM group_members ORDER BY added_at, oid').all() as { group_id: string; oid: string }[]) {
      const l = members.get(m.group_id)
      if (l) l.push(m.oid)
      else members.set(m.group_id, [m.oid])
    }
    const grants = new Map<string, HubGrant[]>()
    for (const g of this.db.prepare('SELECT * FROM grants ORDER BY created_at, id').all() as unknown as GrantRow[]) {
      const l = grants.get(g.group_id)
      if (l) l.push(toGrant(g))
      else grants.set(g.group_id, [toGrant(g)])
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      builtin: r.builtin === 1,
      memberOids: members.get(r.id) ?? [],
      grants: grants.get(r.id) ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }

  private validateGroup(name: string | undefined, description: string | undefined): void {
    if (name !== undefined && !GROUP_NAME.test(name)) throw new HubHttpError(400, 'bad_request', 'Invalid group name')
    if (description !== undefined && description.length > MAX_GROUP_DESCRIPTION) {
      throw new HubHttpError(400, 'bad_request', 'Group description is too long')
    }
  }

  private audit(
    actor: HubActor,
    action: Parameters<HubAudit['append']>[0]['action'],
    g: { id: string; name: string } | null,
    details: Record<string, unknown>,
    user?: { id: string; name: string },
  ): void {
    this.opts.audit.append({
      action,
      outcome: 'success',
      actor,
      viaGroup: null,
      targetType: g ? 'group' : 'user',
      targetId: g?.id ?? user?.id ?? null,
      targetLabel: g?.name ?? user?.name ?? null,
      details,
    })
  }

  createGroup(actor: HubActor, input: { name: string; description?: string }): HubGroup {
    this.validateGroup(input.name, input.description)
    return inTransaction(this.db, () => {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n
      if (count >= MAX_GROUPS) throw new HubHttpError(409, 'conflict', 'Too many groups')
      const id = this.opts.ids()
      const now = this.opts.now().toISOString()
      try {
        this.db
          .prepare('INSERT INTO groups(id, name, description, builtin, created_at, updated_at) VALUES (?,?,?,0,?,?)')
          .run(id, input.name, input.description ?? '', now, now)
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) throw new HubHttpError(409, 'conflict', 'A group with that name already exists')
        throw err
      }
      this.audit(actor, 'group.create', { id, name: input.name }, { name: input.name })
      return this.getGroup(id)
    })
  }

  updateGroup(actor: HubActor, id: string, patch: { name?: string; description?: string }): HubGroup {
    this.validateGroup(patch.name, patch.description)
    return inTransaction(this.db, () => {
      const g = this.groupRow(id)
      if (g.builtin === 1 && patch.name !== undefined && patch.name !== g.name) {
        throw new HubHttpError(409, 'builtin_group', 'The Default group cannot be renamed')
      }
      try {
        this.db
          .prepare('UPDATE groups SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .run(patch.name ?? g.name, patch.description ?? g.description, this.opts.now().toISOString(), id)
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) throw new HubHttpError(409, 'conflict', 'A group with that name already exists')
        throw err
      }
      this.audit(actor, 'group.update', { id, name: patch.name ?? g.name }, { from: g.name, name: patch.name ?? g.name, descriptionChanged: patch.description !== undefined })
      return this.getGroup(id)
    })
  }

  deleteGroup(actor: HubActor, id: string): void {
    inTransaction(this.db, () => {
      const g = this.groupRow(id)
      if (g.builtin === 1) throw new HubHttpError(409, 'builtin_group', 'The Default group cannot be deleted')
      const stranded = this.db
        .prepare(
          `SELECT u.upn FROM group_members gm JOIN users u ON u.oid = gm.oid
           WHERE gm.group_id = ? AND (SELECT COUNT(*) FROM group_members x WHERE x.oid = gm.oid) = 1 ORDER BY u.upn`,
        )
        .all(id) as { upn: string }[]
      if (stranded.length > 0) {
        const names = stranded.slice(0, 3).map((r) => r.upn).join(', ')
        throw new HubHttpError(409, 'last_group', `This is the only group for ${names}${stranded.length > 3 ? ' and others' : ''}`)
      }
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
      this.audit(actor, 'group.delete', { id, name: g.name }, { name: g.name })
    })
    this.accessChanged()
  }

  addMembers(actor: HubActor, groupId: string, oids: string[]): HubGroup {
    const unique = [...new Set(oids)]
    if (unique.length > MAX_BULK_MEMBERS) throw new HubHttpError(400, 'bad_request', 'Too many members in one call')
    const out = inTransaction(this.db, () => {
      const g = this.groupRow(groupId)
      const missing = unique.filter((oid) => !this.db.prepare('SELECT 1 FROM users WHERE oid = ?').get(oid))
      if (missing.length > 0) throw new HubHttpError(404, 'not_found', 'User not found')
      const now = this.opts.now().toISOString()
      const ins = this.db.prepare('INSERT OR IGNORE INTO group_members(group_id, oid, added_at, added_by) VALUES (?,?,?,?)')
      let added = 0
      for (const oid of unique) added += Number(ins.run(groupId, oid, now, actor.oid).changes)
      this.audit(actor, 'member.add', { id: groupId, name: g.name }, { oids: unique, added })
      return this.getGroup(groupId)
    })
    this.accessChanged()
    return out
  }

  removeMember(actor: HubActor, groupId: string, oid: string): void {
    inTransaction(this.db, () => {
      const g = this.groupRow(groupId)
      if (!this.db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND oid = ?').get(groupId, oid)) {
        throw new HubHttpError(404, 'not_found', 'Member not found')
      }
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE oid = ?').get(oid) as { n: number }).n
      if (n <= 1) throw new HubHttpError(409, 'last_group', 'A person must stay in at least one group')
      this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND oid = ?').run(groupId, oid)
      this.audit(actor, 'member.remove', { id: groupId, name: g.name }, { oid })
    })
    this.accessChanged()
  }

  addGrant(actor: HubActor, groupId: string, scope: GrantScope): HubGrant {
    const out = inTransaction(this.db, () => {
      const g = this.groupRow(groupId)
      if (g.builtin === 1) throw new HubHttpError(409, 'builtin_group', 'The Default group cannot be changed')
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM grants WHERE group_id = ?').get(groupId) as { n: number }).n
      if (count >= MAX_GRANTS_PER_GROUP) throw new HubHttpError(409, 'conflict', 'Too many grants in this group')
      if (scope.kind !== 'all') {
        if (!this.db.prepare(`SELECT 1 FROM environments WHERE id = ? AND ${PUBLISHED}`).get(scope.environmentId)) {
          throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
        }
        if (
          scope.kind === 'deployment' &&
          !this.db.prepare('SELECT 1 FROM deployments WHERE id = ? AND environment_id = ?').get(scope.deploymentId, scope.environmentId)
        ) {
          throw new HubHttpError(404, 'not_found', 'That deployment is not published to this Hub')
        }
      }
      const id = this.opts.ids()
      const now = this.opts.now().toISOString()
      try {
        this.db
          .prepare('INSERT INTO grants(id, group_id, scope, environment_id, deployment_id, created_at) VALUES (?,?,?,?,?,?)')
          .run(
            id,
            groupId,
            scope.kind,
            scope.kind === 'all' ? null : scope.environmentId,
            scope.kind === 'deployment' ? scope.deploymentId : null,
            now,
          )
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) throw new HubHttpError(409, 'conflict', 'That grant already exists')
        throw err
      }
      this.audit(actor, 'grant.add', { id: groupId, name: g.name }, { grantId: id, scope })
      return { id, groupId, scope, createdAt: now }
    })
    this.accessChanged()
    return out
  }

  removeGrant(actor: HubActor, grantId: string): void {
    inTransaction(this.db, () => {
      const r = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId) as unknown as GrantRow | undefined
      if (!r) throw new HubHttpError(404, 'not_found', 'Grant not found')
      const g = this.groupRow(r.group_id)
      // The grants_builtin_keep trigger also refuses this; fail with a clean 409 first.
      if (g.builtin === 1) throw new HubHttpError(409, 'builtin_group', 'The Default group cannot be changed')
      this.db.prepare('DELETE FROM grants WHERE id = ?').run(grantId)
      this.audit(actor, 'grant.remove', { id: g.id, name: g.name }, { grantId, scope: toGrant(r).scope })
    })
    this.accessChanged()
  }

  updateUser(actor: HubActor, oid: string, patch: { role?: HubRole; disabled?: boolean }): HubUser {
    let changed = false
    let disabledNow = false
    const out = inTransaction(this.db, () => {
      const u = this.db.prepare('SELECT * FROM users WHERE oid = ?').get(oid) as unknown as UserRow | undefined
      if (!u) throw new HubHttpError(404, 'not_found', 'User not found')
      const role = patch.role ?? u.role
      const disabled = patch.disabled === undefined ? u.disabled === 1 : patch.disabled
      if (role === u.role && disabled === (u.disabled === 1)) return this.get(oid) as HubUser
      const losesAdmin = u.role === 'admin' && u.disabled === 0 && (role !== 'admin' || disabled)
      if (losesAdmin) {
        const n = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n
        if (n <= 1) throw new HubHttpError(409, 'last_admin', 'There must be at least one enabled admin')
      }
      this.db.prepare('UPDATE users SET role = ?, disabled = ? WHERE oid = ?').run(role, disabled ? 1 : 0, oid)
      // The rows go with the transaction; live streams are told only once it has committed.
      if (disabled) this.opts.sessions.revokeAll(oid, { announce: false })
      changed = true
      disabledNow = disabled
      this.audit(
        actor,
        'user.update',
        null,
        { oid, upn: u.upn, role, disabled, fromRole: u.role, fromDisabled: u.disabled === 1 },
        { id: oid, name: u.upn },
      )
      return this.get(oid) as HubUser
    })
    if (disabledNow) this.opts.sessions.announceRevoked(oid)
    if (changed) this.accessChanged()
    return out
  }
}
