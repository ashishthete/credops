import { FREEZE_DEFAULT_HOURS, FREEZE_MAX_HOURS, type HubEnvLock } from '../../src/shared/hub'
import { inTransaction } from '../../src/main/db/tx'
import { HubHttpError } from './errors'
import type { HubDb } from './db'

interface Row {
  environment_id: string
  kind: 'release' | 'manual'
  release_id: string | null
  holder_oid: string
  holder_name: string
  reason: string | null
  created_at: string
  expires_at: string | null
}

export interface LockHolder {
  oid: string
  name: string
}

const toLock = (r: Row): HubEnvLock => ({
  environmentId: r.environment_id,
  kind: r.kind,
  releaseId: r.release_id,
  holder: { oid: r.holder_oid, name: r.holder_name },
  reason: r.reason,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

const blocked = (r: Row): HubHttpError =>
  new HubHttpError(409, 'env_locked', `Locked by ${r.holder_name} since ${r.created_at}${r.reason ? `: ${r.reason}` : r.kind === 'release' ? ': a release is running' : ''}`)

/**
 * One lock row per environment: a release lock (held until the release ends) or a manual freeze (with an expiry).
 * Taking a lock is one `BEGIN IMMEDIATE` transaction, so concurrent starts, even on separate connections, have one winner.
 */
export class EnvLocks {
  private readonly listeners = new Set<(environmentId: string) => void>()

  constructor(
    private readonly db: HubDb,
    private readonly opts: { now: () => Date },
  ) {}

  onChange(fn: (environmentId: string) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(environmentId: string): void {
    for (const fn of this.listeners) fn(environmentId)
  }

  private expired(r: Row): boolean {
    return r.kind === 'manual' && (r.expires_at as string) <= this.opts.now().toISOString()
  }

  /** A row that is not an expired freeze. */
  private live(environmentId: string): Row | undefined {
    const r = this.db.prepare('SELECT * FROM env_locks WHERE environment_id = ?').get(environmentId) as Row | undefined
    return r && !this.expired(r) ? r : undefined
  }

  get(environmentId: string): HubEnvLock | null {
    const r = this.live(environmentId)
    return r ? toLock(r) : null
  }

  list(): HubEnvLock[] {
    return (this.db.prepare('SELECT * FROM env_locks ORDER BY created_at, environment_id').all() as unknown as Row[]).filter((r) => !this.expired(r)).map(toLock)
  }

  private assertEnv(environmentId: string): { name: string; protected: boolean } {
    const e = this.db.prepare('SELECT name, protected FROM environments WHERE id = ?').get(environmentId) as { name: string; protected: number } | undefined
    if (!e) throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
    return { name: e.name, protected: e.protected === 1 }
  }

  private insert(r: Row): void {
    this.db
      .prepare('INSERT INTO env_locks(environment_id, kind, release_id, holder_oid, holder_name, reason, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(r.environment_id, r.kind, r.release_id, r.holder_oid, r.holder_name, r.reason, r.created_at, r.expires_at)
  }

  /** Takes the release lock. The holder's own freeze is upgraded; anything else live is a 409. */
  acquireRelease(environmentId: string, releaseId: string, holder: LockHolder): HubEnvLock {
    const row = inTransaction(this.db, (): Row => {
      this.assertEnv(environmentId)
      const existing = this.db.prepare('SELECT * FROM env_locks WHERE environment_id = ?').get(environmentId) as Row | undefined
      if (existing && !this.expired(existing) && !(existing.kind === 'manual' && existing.holder_oid === holder.oid)) throw blocked(existing)
      if (existing) this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(environmentId)
      const r: Row = {
        environment_id: environmentId,
        kind: 'release',
        release_id: releaseId,
        holder_oid: holder.oid,
        holder_name: holder.name,
        reason: null,
        created_at: this.opts.now().toISOString(),
        expires_at: null,
      }
      this.insert(r)
      return r
    })
    this.emit(environmentId)
    return toLock(row)
  }

  releaseFor(releaseId: string): void {
    const rows = this.db.prepare("SELECT environment_id FROM env_locks WHERE kind = 'release' AND release_id = ?").all(releaseId) as { environment_id: string }[]
    if (rows.length === 0) return
    this.db.prepare("DELETE FROM env_locks WHERE kind = 'release' AND release_id = ?").run(releaseId)
    for (const r of rows) this.emit(r.environment_id)
  }

  /** A manual freeze for `hours` (1 to FREEZE_MAX_HOURS). The holder may refresh their own. */
  freeze(environmentId: string, holder: LockHolder, input: { reason: string; hours?: number }): HubEnvLock {
    const hours = Math.min(FREEZE_MAX_HOURS, Math.max(1, input.hours ?? FREEZE_DEFAULT_HOURS))
    const row = inTransaction(this.db, (): Row => {
      this.assertEnv(environmentId)
      const existing = this.db.prepare('SELECT * FROM env_locks WHERE environment_id = ?').get(environmentId) as Row | undefined
      if (existing && !this.expired(existing) && !(existing.kind === 'manual' && existing.holder_oid === holder.oid)) throw blocked(existing)
      if (existing) this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(environmentId)
      const now = this.opts.now()
      const r: Row = {
        environment_id: environmentId,
        kind: 'manual',
        release_id: null,
        holder_oid: holder.oid,
        holder_name: holder.name,
        reason: input.reason,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + hours * 3_600_000).toISOString(),
      }
      this.insert(r)
      return r
    })
    this.emit(environmentId)
    return toLock(row)
  }

  /**
   * Lifts a freeze. Its holder may always; an admin may, and on a protected environment must type its exact name;
   * `broke` says it was someone else's. Anyone else gets 403.
   */
  unfreeze(environmentId: string, user: { oid: string; role: string }, confirm?: { typedName?: string }): { lock: HubEnvLock; broke: boolean } {
    const out = inTransaction(this.db, () => {
      const env = this.assertEnv(environmentId)
      const r = this.live(environmentId)
      if (!r) throw new HubHttpError(404, 'not_found', 'There is no freeze on this environment')
      if (r.kind === 'release') throw new HubHttpError(409, 'conflict', `A release is running on ${env.name}`)
      const own = r.holder_oid === user.oid
      if (!own) {
        if (user.role !== 'admin') throw new HubHttpError(403, 'forbidden', `Only ${r.holder_name} or a Hub admin can lift this freeze`)
        if (env.protected && confirm?.typedName !== env.name) throw new HubHttpError(400, 'confirm_required', `Type the environment name (${env.name}) to confirm`)
      }
      this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(environmentId)
      return { lock: toLock(r), broke: !own }
    })
    this.emit(environmentId)
    return out
  }

  /** Deletes expired freezes; returns how many. Run every minute. */
  sweepExpired(): number {
    const rows = (this.db.prepare("SELECT * FROM env_locks WHERE kind = 'manual'").all() as unknown as Row[]).filter((r) => this.expired(r))
    for (const r of rows) this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(r.environment_id)
    for (const r of rows) this.emit(r.environment_id)
    return rows.length
  }

  /** At boot no release is running any more: drop their locks (and any expired freeze). Live freezes stay. */
  clearReleaseLocks(): number {
    const rows = this.db.prepare("SELECT environment_id FROM env_locks WHERE kind = 'release'").all() as { environment_id: string }[]
    this.db.prepare("DELETE FROM env_locks WHERE kind = 'release'").run()
    this.sweepExpired()
    for (const r of rows) this.emit(r.environment_id)
    return rows.length
  }
}
