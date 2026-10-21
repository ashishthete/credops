import type { DeploymentMeta, ReleaseSummary, RunEvent, UseSudo } from './deploy'

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
export const MAX_SECRET_BYTES = 65_536
export const MAX_MANIFEST_BYTES = 1_048_576
export const FREEZE_DEFAULT_HOURS = 4
export const FREEZE_MAX_HOURS = 24
export const LIVE_HEARTBEAT_MS = 15_000
export const LIVE_MAX_STREAMS_PER_USER = 4
export const MAX_FREEZE_REASON = 280

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
  | 'env_locked'
  | 'confirm_required'
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
  'env.publish',
  'env.unpublish',
  'secret.set',
  'secret.delete',
  'deploykey.create',
  'lock.freeze',
  'lock.unfreeze',
  'lock.break',
  'release.preflight',
  'release.start',
  'release.finish',
  'release.cancel',
  'release.rollback',
  'release.discard',
  'deploy.lock_break',
  'notify.sent',
  'notify.failed',
  'ai.release_notes',
  'qa.dispatch',
  'qa.finished',
  'access.denied',
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

// ---- Environment registry (10b) ----

export interface HubHop {
  hostId: string | null
  label: string
  address: string
  port: number
  username: string
}

/** The Phase 9 integration settings a Hub run needs; the Teams webhook is a Hub secret with a fixed name, not a reference. */
export interface HubIntegrations {
  notifyEvents: string[]
  emailTo: string[]
  emailCc: string[]
  qaOnDeploy: boolean
  qa: unknown | null
  qaWait: boolean
}

export const EMPTY_HUB_INTEGRATIONS: HubIntegrations = {
  notifyEvents: [],
  emailTo: [],
  emailCc: [],
  qaOnDeploy: false,
  qa: null,
  qaWait: false,
}

/** A service or db of the environment, by reference to the manifest's checkouts and hosts. */
export interface HubManifestService {
  id: string
  name: string
  kind: 'service' | 'db'
  /** Compose service name; null for a db. */
  composeService: string | null
  /** The checkout a `service` runs from; null for a db or a service without one. */
  deploymentId: string | null
  /** The checkout's host for a `service` with a checkout; null otherwise. */
  hostId: string | null
  /** The host a db is reached through; null for a service. */
  viaHostId: string | null
}

/** What an admin publishes: addresses, jump chains and pinned public host keys. Never a secret value. */
export interface HubEnvManifest {
  environment: {
    id: string
    name: string
    protected: boolean
    versioned: boolean
    autoRollback: boolean
    currentVersion: string | null
  }
  hosts: {
    id: string
    label: string
    address: string
    port: number
    username: string
    useSudo: UseSudo
    /** Jump chain, target last. */
    hops: HubHop[]
    /** OpenSSH known_hosts lines, public keys only. */
    knownHosts: string[]
  }[]
  /** Services of the environment: a `service` runs from a checkout, a `db` is reached through a via-host. Ids are the publisher's local UUIDs. */
  services: HubManifestService[]
  deployments: Omit<DeploymentMeta, 'vaultIds' | 'createdAt' | 'updatedAt'>[]
  integrations: HubIntegrations
  requiredSecrets: { secretId: string; name: string; usedBy: string[] }[]
}

/** What any signed-in person with a view grant sees: no addresses, hops or host keys. */
export interface HubEnvLock {
  environmentId: string
  kind: 'release' | 'manual'
  releaseId: string | null
  holder: { oid: string; name: string }
  reason: string | null
  createdAt: string
  expiresAt: string | null
}

export interface HubCatalogEnv {
  environment: HubEnvManifest['environment']
  hosts: { id: string; label: string }[]
  services: HubEnvManifest['services']
  deployments: HubEnvManifest['deployments']
  missingSecrets: number
  deployKey: { fingerprint: string } | null
  lock: HubEnvLock | null
  publishedAt: string
  publishedBy: string
}

export const HUB_SECRET_KINDS = ['env', 'become', 'teams_webhook', 'sendgrid_api_key', 'github_token', 'anthropic_api_key'] as const
export type HubSecretKind = (typeof HUB_SECRET_KINDS)[number]
/** Kinds with a fixed name and no vault id; the rest are the publisher's vault secrets. */
export const HUB_INTEGRATION_KINDS: readonly HubSecretKind[] = ['teams_webhook', 'sendgrid_api_key', 'github_token', 'anthropic_api_key']
export const MAX_SECRET_NAME = 200

/** What the Hub says about a stored secret: never a value, not even its length. */
export interface HubSecretMeta {
  id: string
  environmentId: string | null
  name: string
  kind: HubSecretKind
  updatedBy: string
  updatedAt: string
}
export interface HubSecretList {
  secrets: HubSecretMeta[]
  /** Required by the published environment but not yet set, by environment id. */
  missing: Record<string, { secretId: string; name: string }[]>
}
export interface HubDeployKey {
  publicKey: string
  fingerprint: string
}

export interface HubPublishResult {
  manifestHash: string
  missingSecrets: string[]
}

/** One server-sent event on GET /api/v1/live. `deploy.events` and `lock.updated` reach only people who can view the environment. */
export type HubLiveMessage =
  | { type: 'deploy.events'; environmentId: string; events: RunEvent[] }
  | { type: 'release.state'; summary: ReleaseSummary }
  | { type: 'lock.updated'; environmentId: string; lock: HubEnvLock | null }
  | { type: 'catalog.updated' }
  | { type: 'access.changed' }

/** A release that sits in 'ready' this long without starting loses its environment lock and is discarded. */
export const READY_RELEASE_TTL_MS = 60 * 60 * 1000
