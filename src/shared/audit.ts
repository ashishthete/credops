// Type-only: imported by the renderer, so no runtime code here.
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'info'
export type AuditAction = 'app.start' | 'app.quit' | 'audit.verify' | 'audit.export' // later phases extend

export interface AuditInput {
  action: AuditAction
  outcome: AuditOutcome
  targetType?: string
  targetId?: string
  targetLabel?: string
  details?: Record<string, unknown>
}

export interface AuditEvent
  extends Required<Omit<AuditInput, 'details' | 'targetType' | 'targetId' | 'targetLabel'>> {
  id: number
  ts: string
  actorOsUser: string
  actorMachine: string
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  details: Record<string, unknown>
  prevHash: string
  hash: string
}

export interface AuditFilter {
  actions?: AuditAction[]
  outcome?: AuditOutcome
  actor?: string
  targetType?: string
  /** ISO timestamp, inclusive. */
  from?: string
  /** ISO timestamp, inclusive. */
  to?: string
  /** Case-insensitive substring over action, target and actor fields. */
  text?: string
  /** Default 200, clamped to [1, 1000]. */
  limit?: number
  /** Only events with id below this value (paging cursor). */
  beforeId?: number
}

export type ChainVerification =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAtId: number; reason: 'hash-mismatch' | 'prev-link-mismatch' }
