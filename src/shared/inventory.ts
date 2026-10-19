// Imported by the renderer: keep this file to plain constants and types (no node or electron imports).
import type { IdentityAuth } from './vault'

export const HOST_ROLES = ['app', 'db', 'bastion', 'other'] as const
export type HostRole = (typeof HOST_ROLES)[number]
export const PRODUCT_ICONS = ['boxes', 'leaf', 'globe', 'database', 'layers', 'rocket', 'sparkles', 'building'] as const
export type ProductIcon = (typeof PRODUCT_ICONS)[number]
export const OS_ICONS = ['linux', 'windows', 'macos', 'other'] as const
export type OsIcon = (typeof OS_ICONS)[number]

export const MAX_NAME = 64 // product and environment names
export const MAX_ADDRESS = 253
/** Hostname, IPv4 or IPv6: no spaces and no leading `-`, so ssh can never read it as an option. */
export const HOST_ADDRESS = /^(?!-)[A-Za-z0-9_.:%-]+$/
export const DEFAULT_SSH_PORT = 22
export const MAX_TAGS = 16
export const MAX_TAG = 32
export const TAG = /^[\p{L}\p{N}_.:/-]+$/u
export const MAX_NOTES = 4000
export const MAX_DESCRIPTION = 1000
export const MAX_URL = 2048
export const REPO_URL = /^(https?:\/\/|ssh:\/\/|git@)\S+$/
export const MAX_JUMP_DEPTH = 8
export const MAX_SSH_CONFIG_BYTES = 1024 * 1024
export const MAX_LINKS = 64 // ids in any id list
export const MAX_IMPORT_ALIASES = 2000
export const MAX_ENV_VARS = 32 // per host
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_ENV_VALUE = 1024
export const MAX_KEEPALIVE_SEC = 3600

/** Control, format (bidi, zero-width) and line-separator characters. */
export const UNSAFE_SSH_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029\u0085]/u
/** A value safe to hand ssh as one argument: non-empty, no leading `-`, no control or format characters. */
export function isSafeSshToken(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !UNSAFE_SSH_CHAR.test(value)
}

export interface ProductInput {
  name: string
  color: string
  icon: ProductIcon
  description?: string
  repoUrl?: string | null
}
export type ProductPatch = Partial<ProductInput>
export interface ProductMeta {
  id: string
  name: string
  color: string
  icon: ProductIcon
  description: string
  repoUrl: string | null
  environmentIds: string[]
  createdAt: string
  updatedAt: string
}

export interface Membership {
  environmentId: string
  role: HostRole
}
export interface EnvironmentInput {
  name: string
  color: string
  protected?: boolean
  defaultIdentityId?: string | null
  defaultPort?: number | null
  defaultJumpHostId?: string | null
  productIds?: string[]
}
export type EnvironmentPatch = Partial<Omit<EnvironmentInput, 'productIds'>>
export interface EnvironmentMeta {
  id: string
  name: string
  color: string
  protected: boolean
  defaultIdentityId: string | null
  defaultPort: number | null
  defaultJumpHostId: string | null
  productIds: string[]
  hosts: { hostId: string; role: HostRole }[]
  createdAt: string
  updatedAt: string
}

export interface HostInput {
  label: string
  address: string
  port?: number | null
  identityId?: string | null
  jumpHostId?: string | null
  tags?: string[]
  osIcon?: OsIcon
  notes?: string
  /** Seconds between keepalives; null = default, 0 = off. */
  keepaliveSec?: number | null
  envVars?: Record<string, string>
  vaultIds?: string[]
  environments?: Membership[]
}
export type HostPatch = Partial<Omit<HostInput, 'vaultIds' | 'environments'>>
export interface HostMeta {
  id: string
  label: string
  address: string
  port: number | null
  identityId: string | null
  jumpHostId: string | null
  tags: string[]
  osIcon: OsIcon
  notes: string
  keepaliveSec: number | null
  envVars: Record<string, string>
  vaultIds: string[]
  environments: Membership[]
  createdAt: string
  updatedAt: string
}

export type ValueSource = 'host' | 'environment' | 'global'
export type IdentityRef =
  | { source: 'host' | 'environment'; identityId: string; label: string; username: string; auth: IdentityAuth; vaultId: string }
  | { source: 'global'; username: string; auth: 'default' } // agent, then ~/.ssh/id_ed25519, then id_rsa
export interface ResolvedHop {
  hostId: string
  label: string
  address: string
  port: number
  identity: IdentityRef
}
export interface InheritConflict {
  field: 'identity' | 'port' | 'jumpHost'
  /** All of the host's environments whose defaults were compared (sorted), not only those that disagree. */
  environmentIds: string[]
}
export interface ResolvedHost {
  hostId: string
  environmentId: string | null
  address: string
  port: { value: number; source: ValueSource }
  identity: IdentityRef
  jump: { hostId: string | null; source: ValueSource | null }
  /** First hop to dial first; excludes the target. */
  chain: ResolvedHop[]
  conflicts: InheritConflict[]
}

export interface SshForward {
  type: 'L' | 'R' | 'D'
  spec: string
}
export interface SshConfigEntry {
  alias: string
  hostName: string
  port: number | null
  user: string | null
  identityFile: string | null
  proxyJump: string | null
  forwards: SshForward[]
  warnings: string[]
}
export interface SshImportCandidate extends SshConfigEntry {
  existingHostId: string | null
  valid: boolean
  jumpResolvable: boolean
}
export interface SshImportPreview {
  path: string
  found: boolean
  candidates: SshImportCandidate[]
  warnings: string[]
}
export interface SshImportRequest {
  vaultId: string
  aliases: string[]
  environmentId?: string
  role?: HostRole
  /** Also create tunnels for the hosts' forwards. Default true. */
  forwards?: boolean
}
export interface SshImportResult {
  created: HostMeta[]
  skipped: { alias: string; reason: 'exists' | 'not-found' | 'invalid' }[]
  keysLinked: number
  identitiesCreated: number
  tunnelsCreated: number
  warnings: string[]
}
