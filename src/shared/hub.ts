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

export interface HubUser extends HubIdentity {
  role: HubRole
  status: HubUserStatus
  groupIds: string[]
  createdAt: string
  lastSeenAt: string | null
}

/** The only payload that carries a Hub session token. */
export interface HubSession {
  token: string
  expiresAt: string
  user: HubUser
}

export type GrantScope =
  | { kind: 'all' }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'deployment'; environmentId: string; deploymentId: string }

export interface HubGrant {
  id: string
  groupId: string
  scope: GrantScope
  createdAt: string
}

export interface HubGroup {
  id: string
  name: string
  description: string
  builtin: boolean
  memberOids: string[]
  grants: HubGrant[]
  createdAt: string
  updatedAt: string
}

// Phase 8's DeployAction names, plus Hub-only 'env.lock' (10b manual freeze) and 'admin'
export type HubAction =
  | 'deploy.view'
  | 'deploy.edit'
  | 'release.start'
  | 'release.rollback'
  | 'release.cancel'
  | 'lock.break'
  | 'env.lock'
  | 'admin'

export interface AccessTarget {
  environmentId: string
  deploymentIds?: string[]
}

export type HubDenyCode = 'pending' | 'disabled' | 'no_grant' | 'admin_only'

export type HubDecision =
  | {
      allowed: true
      via: { role: HubRole; groupId: string | null; groupName: string | null }
      /** Set when the union of several grants covers the target; one entry per deployment. */
      vias?: { deploymentId: string; groupId: string; groupName: string }[]
    }
  | { allowed: false; code: HubDenyCode; reason: string }

/** The only Hub state the renderer sees. It never carries a token. */
export type HubStatus =
  | { linked: false }
  | {
      linked: true
      url: string
      hubId: string
      hubName: string
      signedIn: boolean
      signingIn: boolean
      online: boolean
      user: HubUser | null
      sessionExpiresAt: string | null
    }
