import { createHash, randomBytes } from 'node:crypto'
import type { HubDb } from '../db'

export const SESSION_TOKEN_RE = /^ohs_[A-Za-z0-9_-]{43}$/

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export class SessionStore {
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

  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  }

  revokeAll(oid: string): void {
    this.db.prepare('DELETE FROM sessions WHERE oid = ?').run(oid)
  }

  /** The Hub never keeps a token, so there is nothing to redact by value. */
  knownValues(): string[] {
    return []
  }
}
