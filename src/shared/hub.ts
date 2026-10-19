export const HUB_API_VERSION = 1
export const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001'
export const DEFAULT_ALL_GRANT_ID = '00000000-0000-4000-8000-000000000002'

export const SESSION_TTL_HOURS = 12
export const SIGN_IN_TIMEOUT_MS = 300_000
export const HUB_TIMEOUT_MS = 15_000
export const ACCESS_CACHE_MS = 30_000
export const MAX_GROUPS = 200
export const MAX_GRANTS_PER_GROUP = 500
export const GROUP_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u
export const MAX_GROUP_DESCRIPTION = 280
export const HUB_BODY_LIMIT = 1_048_576
export const MAX_BULK_MEMBERS = 500

export type HubRole = 'admin' | 'maintainer'
export type HubUserStatus = 'pending' | 'active' | 'disabled'

export interface HubMeta {
  hubId: string
  name: string
  apiVersion: 1
  entra: { authority: string; clientId: string; scopes: string[]; redirectUri: string }
}

export type HubErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'session_expired'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'last_group'
  | 'last_admin'
  | 'builtin_group'
  | 'unavailable'
  | 'internal'

export interface HubErrorBody {
  error: HubErrorCode
  message: string
}

export const HUB_AUDIT_ACTIONS = [
  'hub.start',
  'hub.stop',
  'session.create',
  'session.denied',
  'session.revoke',
  'user.update',
  'group.create',
  'group.update',
  'group.delete',
  'member.add',
  'member.remove',
  'grant.add',
  'grant.remove',
  'audit.verify',
] as const
export type HubAuditAction = (typeof HUB_AUDIT_ACTIONS)[number]

export interface HubActor {
  oid: string
  upn: string
  name: string
  role: HubRole | null
}

export type HubAuditOutcome = 'success' | 'failure' | 'denied' | 'info'

export interface HubAuditEvent {
  id: number
  ts: string
  actor: HubActor | null
  viaGroup: string | null
  action: HubAuditAction
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  outcome: HubAuditOutcome
  details: Record<string, unknown>
  prevHash: string
  hash: string
}

export interface HubAuditFilter {
  actions?: HubAuditAction[]
  actorOid?: string
  outcome?: HubAuditEvent['outcome']
  from?: string
  to?: string
  beforeId?: number
  limit?: number
}

export interface HubIdentity {
  oid: string
  upn: string
  name: string
}
