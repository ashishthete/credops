// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import { COMPOSE_SERVICE, GIT_REF, type HealthFrom } from './deploy'
import type { HostRole } from './inventory'

export { COMPOSE_SERVICE }

// ---- Limits ----
export const MAX_SERVICES = 512

// ---- Types ----
export type ServiceKind = 'service' | 'db'
export type DbEngine = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'other'

/** The port a db service gets when none is given; `other` has no default. */
export const DB_DEFAULT_PORT: Record<DbEngine, number | null> = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379, other: null }

interface ServiceBase {
  id: string
  environmentId: string
  name: string
  position: number
  description: string
  createdAt: string
  updatedAt: string
}

/** Runs from a checkout's compose file. Its host is the checkout's host; it is never stored. */
export interface AppServiceMeta extends ServiceBase {
  kind: 'service'
  deploymentId: string | null
  composeService: string
  url: string | null
  urlCheckFrom: HealthFrom
  lastDeployedCommit: string | null
  lastReleaseId: string | null
}

/** Reached through a tunnel from a via-host; `dbAddress` is as seen from that host. */
export interface DbServiceMeta extends ServiceBase {
  kind: 'db'
  dbEngine: DbEngine
  dbAddress: string
  dbPort: number
  viaHostId: string | null
  localPort: number | null
  tunnelId: string | null
}

export type ServiceMeta = AppServiceMeta | DbServiceMeta

export type ServiceInput =
  | {
      kind: 'service'
      environmentId: string
      name: string
      description?: string
      deploymentId: string | null
      composeService?: string
      url?: string | null
      urlCheckFrom?: HealthFrom
    }
  | {
      kind: 'db'
      environmentId: string
      name: string
      description?: string
      dbEngine: DbEngine
      dbAddress: string
      dbPort?: number
      viaHostId?: string | null
      localPort?: number | null
    }

/** The kind and environment never change. */
export type ServicePatch =
  | Partial<Omit<Extract<ServiceInput, { kind: 'service' }>, 'kind' | 'environmentId'>>
  | Partial<Omit<Extract<ServiceInput, { kind: 'db' }>, 'kind' | 'environmentId'>>

export interface ServiceUpdateResult {
  service: ServiceMeta
  tunnelRestartNeeded: boolean
}

// ---- Pure helpers ----

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The default via-host: the `app` host with the most checkouts, ties to the lower label; null with no app host. */
export function pickAppHost(hosts: { hostId: string; role: HostRole; label: string }[], checkoutHostIds: string[]): string | null {
  const count = new Map<string, number>()
  for (const id of checkoutHostIds) count.set(id, (count.get(id) ?? 0) + 1)
  const apps = hosts
    .filter((h) => h.role === 'app')
    .sort((a, b) => (count.get(b.hostId) ?? 0) - (count.get(a.hostId) ?? 0) || a.label.localeCompare(b.label))
  return apps[0]?.hostId ?? null
}

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
  const out = tag.replace(re, targetEnv.toLowerCase())
  return GIT_REF.test(out) ? out : null
}

/** Every `${secret:…}` reference becomes ''. */
export function stripSecretRefs(template: string): string {
  return template.replace(/\$\{secret:[^}]*\}/g, '')
}
