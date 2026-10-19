import { createHash, randomBytes } from 'node:crypto'
import type { HubDb } from '../db'

export const SESSION_TOKEN_RE = /^ohs_[A-Za-z0-9_-]{43}$/

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export type SessionRevoked = { tokenHash: string } | { oid: string }

export class SessionStore {
  private readonly listeners = new Set<(r: SessionRevoked) => void>()

  constructor(
    private readonly db: HubDb,
    private readonly opts: { now: () => Date; ttlHours: number },
  ) {}

  create(oid: string): { token: string; expiresAt: string } {
    const token = `ohs_${randomBytes(32).toString('base64url')}`
    const now = this.opts.now()
    const expiresAt = new Date(now.getTime() + this.opts.ttlHours * 3600_000).toISOString()
    // Sweep abandoned sessions; expired rows are otherwise removed only when presented.
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString())
    this.db
      .prepare('INSERT INTO sessions(token_hash, oid, created_at, expires_at) VALUES (?,?,?,?)')
      .run(hashToken(token), oid, now.toISOString(), expiresAt)
    return { token, expiresAt }
  }

  resolve(token: string): { oid: string; expiresAt: string } | null {
    const h = hashToken(token)
    const row = this.db.prepare('SELECT oid, expires_at FROM sessions WHERE token_hash = ?').get(h) as
      | { oid: string; expires_at: string }
      | undefined
    if (!row) return null
    if (Date.parse(row.expires_at) <= this.opts.now().getTime()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h)
      return null
    }
    return { oid: row.oid, expiresAt: row.expires_at }
  }

  /** Told after a session (or all of a person's sessions) is revoked, so live streams can end. */
  onRevoke(fn: (r: SessionRevoked) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(r: SessionRevoked): void {
    for (const fn of this.listeners) {
      try {
        fn(r)
      } catch {
        // Listeners are advisory.
      }
    }
  }

  revoke(token: string): void {
    const tokenHash = hashToken(token)
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    this.emit({ tokenHash })
  }

  /** `announce: false` lets a caller inside a transaction tell listeners itself, after COMMIT, with `announceRevoked`. */
  revokeAll(oid: string, opts: { announce?: boolean } = {}): void {
    this.db.prepare('DELETE FROM sessions WHERE oid = ?').run(oid)
    if (opts.announce !== false) this.emit({ oid })
  }

  announceRevoked(oid: string): void {
    this.emit({ oid })
  }

  /** The Hub never keeps a token, so there is nothing to redact by value. */
  knownValues(): string[] {
    return []
  }
}
