// Imported by the renderer: keep runtime code to plain constants (no node or electron imports).
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'info'

/** Every audit action; `AuditAction` is derived from it, so the list is complete by construction. */
export const AUDIT_ACTIONS = [
  'app.start',
  'app.quit',
  'audit.verify',
  'audit.export',
  'vault.setup',
  'vault.unlock',
  'vault.lock',
  'vault.rekey',
  'vault.quickunlock',
  'vault.autolock',
  'vault.create',
  'vault.update',
  'vault.delete',
  'secret.create',
  'secret.update',
  'secret.delete',
  'secret.reveal',
  'secret.copy',
  'key.link',
  'key.import',
  'key.generate',
  'key.update',
  'key.delete',
  'identity.create',
  'identity.update',
  'identity.delete',
  'product.create',
  'product.update',
  'product.delete',
  'environment.create',
  'environment.update',
  'environment.delete',
  'environment.products',
  'environment.host',
  'host.create',
  'host.update',
  'host.delete',
  'host.vaults',
  'host.import',
  'ssh.open',
  'ssh.close',
  'shell.open',
  'shell.close',
  'knownhost.trust',
  'knownhost.remove',
  'knownhost.mismatch',
  'tunnel.create',
  'tunnel.update',
  'tunnel.delete',
  'tunnel.start',
  'tunnel.stop',
  'snippet.create',
  'snippet.update',
  'snippet.delete',
  'run.start',
  'run.finish',
  'container.start',
  'container.stop',
  'container.restart',
  'container.exec',
  'deploy.create',
  'deploy.update',
  'deploy.delete',
  'deploy.lock_break',
  'deploy.settings',
  'release.preflight',
  'release.start',
  'release.finish',
  'release.cancel',
  'release.rollback',
  'release.discard',
  'service.create',
  'service.update',
  'service.delete',
  'services.copy',
  'settings.update',
  'integration.update',
  'notify.send',
  'notify.test',
  'qa.dispatch',
  'qa.finished',
  'ai.release_notes',
  'ai.explain',
  'ai.command',
] as const // later phases extend
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

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
