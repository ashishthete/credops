// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import { COMPOSE_SERVICE, GIT_REF, type HealthFrom } from './deploy'
import type { HostRole } from './inventory'

export { COMPOSE_SERVICE }

// ---- Limits ----
export const MAX_SERVICES = 512

/**
 * The folder a service lives in on its host: absolute, or under the home folder (`~/app`). Plain path characters only
 * (no spaces), so it is safe as one shell word. Empty means none.
 */
export const SERVICE_PATH = /^(?!.*\.\.)(?!.*\/\/)(?:~|~?\/[A-Za-z0-9._@+/-]{0,255})$/
export const MAX_SERVICE_PATH = 258
export const SERVICE_PATH_MESSAGE = 'folder must start with / or ~/ and use only letters, digits and . _ @ + - /'

// ---- Types ----
export type ServiceKind = 'service' | 'db' | 'bastion'

/** What the UI calls each kind: an app is stored as kind `service`. */
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = { service: 'App', db: 'Database', bastion: 'Bastion' }
export type DbEngine = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'other'

/** The port a db service gets when none is given; `other` has no default. */
export const DB_DEFAULT_PORT: Record<DbEngine, number | null> = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379, other: null }

interface ServiceBase {
  id: string
  environmentId: string
  /** The host it runs on; with a checkout, the checkout's host. A host is in an environment exactly when it runs a service there. */
  hostId: string
  name: string
  position: number
  description: string
  /** The folder it lives in on the host, '' for none; a terminal opened from the service starts there. */
  path: string
  createdAt: string
  updatedAt: string
}

/** An app on a host; with a checkout it runs from the checkout's compose file. */
export interface AppServiceMeta extends ServiceBase {
  kind: 'service'
  deploymentId: string | null
  /** '' for an app without a checkout. */
  composeService: string
  url: string | null
  urlCheckFrom: HealthFrom
  lastDeployedCommit: string | null
  lastReleaseId: string | null
  /** A release leaves this service alone when none of its commits touch the checkout since its last deploy. */
  skipUnchanged: boolean
}

/** Reached through a tunnel from its host; `dbAddress` is as seen from that host (127.0.0.1 when it runs there). */
export interface DbServiceMeta extends ServiceBase {
  kind: 'db'
  dbEngine: DbEngine
  dbAddress: string
  dbPort: number
  localPort: number | null
  tunnelId: string | null
}

/** A jump host the environment's other hosts are reached through. */
export interface BastionServiceMeta extends ServiceBase {
  kind: 'bastion'
}

export type ServiceMeta = AppServiceMeta | DbServiceMeta | BastionServiceMeta

export type ServiceInput =
  | {
      kind: 'service'
      environmentId: string
      /** Defaults to the checkout's host; required without a checkout. */
      hostId?: string
      name: string
      description?: string
      path?: string
      deploymentId: string | null
      composeService?: string
      url?: string | null
      urlCheckFrom?: HealthFrom
      skipUnchanged?: boolean
    }
  | {
      kind: 'db'
      environmentId: string
      hostId: string
      name: string
      description?: string
      path?: string
      dbEngine: DbEngine
      dbAddress: string
      dbPort?: number
      localPort?: number | null
    }
  | {
      kind: 'bastion'
      environmentId: string
      hostId: string
      name: string
      description?: string
      path?: string
    }

/**
 * The environment never changes here (a service is moved instead). Another `kind` turns the service into that kind;
 * the patch then carries the new kind's fields.
 */
export type ServicePatch = { kind?: ServiceKind } & (
  | Partial<Omit<Extract<ServiceInput, { kind: 'service' }>, 'kind' | 'environmentId'>>
  | Partial<Omit<Extract<ServiceInput, { kind: 'db' }>, 'kind' | 'environmentId'>>
  | Partial<Omit<Extract<ServiceInput, { kind: 'bastion' }>, 'kind' | 'environmentId'>>
)

export interface ServiceUpdateResult {
  service: ServiceMeta
  tunnelRestartNeeded: boolean
}

/** Copy to another environment. The renderer fills one row per source checkout and one per db service. */
export interface CopyServicesRequest {
  sourceEnvironmentId: string
  targetEnvironmentId: string
  /** One per source checkout that has services or is picked; these four fields differ per environment. */
  checkouts: { deploymentId: string; branch: string; repoPath: string; hostId: string; deployTag: string }[]
  /** One per source db service, with the host it runs on in the target and its address as seen from there. */
  dbs: { serviceId: string; dbAddress: string; dbPort: number; hostId: string }[]
}

export interface CopyServicesResult {
  created: { services: number; checkouts: number }
  /** Name conflicts are skipped, never renamed or overwritten. */
  skipped: { kind: 'service' | 'checkout'; name: string; reason: string }[]
  /** Hosts that joined the target environment by running a copied service. */
  addedHosts: number
}

// ---- Pure helpers ----

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The default app host: the `app` host with the most checkouts, ties to the lower label; null with no app host. */
export function pickAppHost(hosts: { hostId: string; role: HostRole; label: string }[], checkoutHostIds: string[]): string | null {
  const count = new Map<string, number>()
  for (const id of checkoutHostIds) count.set(id, (count.get(id) ?? 0) + 1)
  const apps = hosts
    .filter((h) => h.role === 'app')
    .sort((a, b) => (count.get(b.hostId) ?? 0) - (count.get(a.hostId) ?? 0) || a.label.localeCompare(b.label))
  return apps[0]?.hostId ?? null
}

/** An environment's members with their labels, for `pickAppHost`; members missing from `hosts` are left out. */
export function envHosts(members: { hostId: string; role: HostRole }[], hosts: { id: string; label: string }[]): { hostId: string; role: HostRole; label: string }[] {
  const label = new Map(hosts.map((h) => [h.id, h.label]))
  return members.flatMap((m) => (label.has(m.hostId) ? [{ hostId: m.hostId, role: m.role, label: label.get(m.hostId)! }] : []))
}

/** `pickAppHost` over an environment's members. */
export const envAppHost = (members: { hostId: string; role: HostRole }[], hosts: { id: string; label: string }[], checkoutHostIds: string[]): string | null =>
  pickAppHost(envHosts(members, hosts), checkoutHostIds)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Swaps each case-insensitive `sourceEnv` delimited by the start, the end, `_`, `-` or `.` for the lowercased
 * `targetEnv`. Null when nothing matched or the result isn't a valid git ref.
 */
export function deriveTag(tag: string, sourceEnv: string, targetEnv: string): string | null {
  if (sourceEnv === '') return null
  const re = new RegExp(`(?<=^|[_.-])${escapeRe(sourceEnv)}(?=$|[_.-])`, 'gi')
  if (!re.test(tag)) return null
  re.lastIndex = 0
  const target = targetEnv.toLowerCase()
  // A replacer function, so `$&` or `$1` in an environment name is inserted literally, not as a pattern.
  const out = tag.replace(re, () => target)
  return GIT_REF.test(out) ? out : null
}

/** Every `${secret:…}` reference becomes ''. */
export function stripSecretRefs(template: string): string {
  return template.replace(/\$\{secret:[^}]*\}/g, '')
}
