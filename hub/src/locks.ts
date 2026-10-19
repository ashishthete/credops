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
  frozen_reason: string | null
  frozen_created_at: string | null
  frozen_expires_at: string | null
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
    // The change is already committed: a listener that throws must not make the caller think it failed.
    for (const fn of this.listeners) {
      try {
        fn(environmentId)
      } catch {
        // Listeners are advisory.
      }
    }
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
      .prepare(
        'INSERT INTO env_locks(environment_id, kind, release_id, holder_oid, holder_name, reason, created_at, expires_at, frozen_reason, frozen_created_at, frozen_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(r.environment_id, r.kind, r.release_id, r.holder_oid, r.holder_name, r.reason, r.created_at, r.expires_at, r.frozen_reason, r.frozen_created_at, r.frozen_expires_at)
  }

  /**
   * Takes the release lock. A live release or someone else's freeze is a 409 and is left in place. The freeze
   * holder's own release takes the freeze over: it is set aside in the row and comes back, with its original reason
   * and expiry, when the release lock ends (unless it has expired by then).
   */
  acquireRelease(environmentId: string, releaseId: string, holder: LockHolder): HubEnvLock {
    const row = inTransaction(this.db, (): Row => {
      this.assertEnv(environmentId)
      const existing = this.db.prepare('SELECT * FROM env_locks WHERE environment_id = ?').get(environmentId) as Row | undefined
      const own = existing !== undefined && existing.kind === 'manual' && existing.holder_oid === holder.oid
      if (existing && !this.expired(existing) && !own) throw blocked(existing)
      if (existing) this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(environmentId)
      const keep = existing !== undefined && own && !this.expired(existing)
      const r: Row = {
        environment_id: environmentId,
        kind: 'release',
        release_id: releaseId,
        holder_oid: holder.oid,
        holder_name: holder.name,
        reason: null,
        created_at: this.opts.now().toISOString(),
        expires_at: null,
        frozen_reason: keep ? existing.reason : null,
        frozen_created_at: keep ? existing.created_at : null,
        frozen_expires_at: keep ? existing.expires_at : null,
      }
      this.insert(r)
      return r
    })
    this.emit(environmentId)
    return toLock(row)
  }

  /** Ends a release lock; the holder's set-aside freeze comes back if it has not expired. */
  releaseFor(releaseId: string): void {
    const ids = inTransaction(this.db, () => this.endReleases("kind = 'release' AND release_id = ?", [releaseId]))
    for (const id of ids) this.emit(id)
  }

  /** Inside a transaction: removes the matching release rows and puts back each unexpired set-aside freeze. */
  private endReleases(where: string, args: string[]): string[] {
    const rows = this.db.prepare(`SELECT * FROM env_locks WHERE ${where}`).all(...args) as unknown as Row[]
    const now = this.opts.now().toISOString()
    for (const r of rows) {
      this.db.prepare('DELETE FROM env_locks WHERE environment_id = ?').run(r.environment_id)
      if (r.frozen_expires_at !== null && r.frozen_expires_at > now) {
        this.insert({
          environment_id: r.environment_id,
          kind: 'manual',
          release_id: null,
          holder_oid: r.holder_oid,
          holder_name: r.holder_name,
          reason: r.frozen_reason,
          created_at: r.frozen_created_at as string,
          expires_at: r.frozen_expires_at,
          frozen_reason: null,
          frozen_created_at: null,
          frozen_expires_at: null,
        })
      }
    }
    return rows.map((r) => r.environment_id)
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
        frozen_reason: null,
        frozen_created_at: null,
        frozen_expires_at: null,
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

  /** Deletes expired freezes in one statement, so a freeze renewed meanwhile is never swept; returns how many. */
  sweepExpired(): number {
    const rows = this.db.prepare("DELETE FROM env_locks WHERE kind = 'manual' AND expires_at <= ? RETURNING environment_id").all(this.opts.now().toISOString()) as {
      environment_id: string
    }[]
    for (const r of rows) this.emit(r.environment_id)
    return rows.length
  }

  /** At boot no release is running any more: drop their locks (set-aside freezes come back) and any expired freeze. Live freezes stay. */
  clearReleaseLocks(): number {
    const ids = inTransaction(this.db, () => this.endReleases("kind = 'release'", []))
    this.sweepExpired()
    for (const id of ids) this.emit(id)
    return ids.length
  }
}
