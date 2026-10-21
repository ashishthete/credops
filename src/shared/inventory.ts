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
/**
 * The authority can't start with a slash or backslash (WHATWG skips them); the scp form needs a host (an ssh-config
 * alias with `_` or a bracketed IPv6 address included) and a path that isn't `//…`; no control or format characters.
 */
export const REPO_URL =
  /^(?!.*[\p{Cc}\p{Cf}])(?:(?:https?|ssh):\/\/[^\/\\\s]\S*|git@(?:[a-z0-9_][a-z0-9_.-]*|\[[0-9a-f:.]+\]):(?![\/\\]{2})\S+)$/iu

/** http(s) values must also parse as WHATWG URLs, so the credential check below can't silently drop out. */
export function isParsableRepoUrl(url: string): boolean {
  if (!/^https?:/i.test(url)) return true
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/** Shown wherever a repo URL with a username or password is refused; it never carries the URL. */
export const REPO_URL_CREDENTIALS_MSG = 'Repository URL must not contain a username or password. Use a deploy key or an SSH identity instead.'
/** Shown beside a stored repo URL that still carries credentials (rows saved before the rule). */
export const REPO_URL_LEGACY_WARNING = 'Contains a username or password; replace with a deploy key'

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Scheme, userinfo and the rest of an http(s) or ssh:// URL that has userinfo; the userinfo ends at the authority's last @. */
function splitUserinfo(url: string): { scheme: string; userinfo: string; rest: string } | null {
  const m = /^(https?:|ssh:)[/\\]*([^/\\?#]*)/i.exec(url)
  const at = m ? m[2].lastIndexOf('@') : -1
  if (!m || at < 0) return null
  return { scheme: m[1], userinfo: m[2].slice(0, at), rest: url.slice(m[0].length - m[2].length + at + 1) }
}

/** Userinfo in a value the pattern no longer accepts (a legacy row such as `git@https://tok:pw@host/a`). */
const LEGACY_USERINFO = /([a-z][a-z0-9+.-]*:)[/\\]*[^/\\?#\s]*@/i

/** Credentials in a repo URL: any http(s) userinfo, or a password after an ssh user. `git@host:path` and `ssh://git@` carry none. */
export function hasRepoCredentials(url: string): boolean {
  const u = splitUserinfo(url)
  if (u !== null && (/^https?/i.test(u.scheme) || safeDecode(u.userinfo).includes(':'))) return true
  if (/^https?:/i.test(url)) {
    try {
      const w = new URL(url)
      return w.username !== '' || w.password !== ''
    } catch {
      return false
    }
  }
  return u === null && !REPO_URL.test(url) && LEGACY_USERINFO.test(url)
}

/** The repo URL without its credentials: http(s) userinfo goes whole, an ssh URL keeps its user. */
export function stripRepoCredentials(url: string): string {
  const u = splitUserinfo(url)
  if (!u) return hasRepoCredentials(url) ? url.replace(LEGACY_USERINFO, '$1//') : url
  if (!hasRepoCredentials(url)) return url
  const user = /^ssh/i.test(u.scheme) ? u.userinfo.split(/:|%3a/i)[0] : ''
  return `${u.scheme}//${user ? `${user}@` : ''}${u.rest}`
}

/** A stored repo URL that no longer passes today's rules, or carries credentials: never shown as is. */
export function isLegacyRepoUrl(url: string): boolean {
  return hasRepoCredentials(url) || !REPO_URL.test(url) || !isParsableRepoUrl(url)
}

/** What the UI shows for a stored repo URL: credentials removed, and an unrecognisable value hidden. */
export function maskRepoUrl(url: string): string {
  const clean = stripRepoCredentials(url)
  return REPO_URL.test(clean) ? clean : '(invalid repository URL)'
}
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

export const MAX_DOMAIN = 253
const DOMAIN_GENERIC = 'Enter a domain like staging.example.com or an http(s) URL'
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6_BRACKETED = /^\[[0-9A-Fa-f:.]+\]$/

export interface EnvDomain {
  kind: 'host' | 'url'
  /** The hostname as written; brackets kept for IPv6. */
  host: string
}

/** A dot-separated hostname: labels of 1-63 letters, digits and hyphens, one trailing dot allowed. */
function isHostname(value: string): boolean {
  const name = value.endsWith('.') ? value.slice(0, -1) : value
  return name.length > 0 && name.split('.').every((l) => HOST_LABEL.test(l))
}

/** The only validator for an environment's Domain or URL. Messages name the rule and never carry the input. */
export function parseEnvDomain(raw: string): { ok: true; value: EnvDomain } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  const value = raw.trim()
  // Before new URL, which silently strips tabs and newlines.
  if (/\s/u.test(value) || UNSAFE_SSH_CHAR.test(value)) return fail(DOMAIN_GENERIC)
  if (value.includes('://')) {
    const scheme = value.slice(0, value.indexOf('://')).toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return fail('Use an http:// or https:// URL')
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return fail(DOMAIN_GENERIC)
    }
    if (url.username !== '' || url.password !== '') return fail('Leave the login out of the URL')
    if (value.length > MAX_URL) return fail('A URL is at most 2048 characters')
    const host = url.hostname
    if (host.length > MAX_DOMAIN) return fail('A domain is at most 253 characters')
    if (!(IPV4.test(host) || IPV6_BRACKETED.test(host) || isHostname(host))) return fail(DOMAIN_GENERIC)
    return { ok: true, value: { kind: 'url', host } }
  }
  if (value.length > MAX_DOMAIN) return fail('A domain is at most 253 characters')
  if (!isHostname(value)) return fail(DOMAIN_GENERIC)
  return { ok: true, value: { kind: 'host', host: value } }
}

/** The suffix bare names take: lowercase, no trailing dot; `null` for an IP literal. */
export function domainHost(d: EnvDomain): string | null {
  const host = d.host.toLowerCase().replace(/\.$/, '')
  return IPV4.test(host) || host.startsWith('[') ? null : host
}

export function domainOpenUrl(d: EnvDomain, raw: string): string {
  return d.kind === 'host' ? `https://${d.host}` : new URL(raw.trim()).href
}

/** Syntactic only: no dot, colon or percent, at least one letter, and not localhost. */
export function isBareName(address: string): boolean {
  return !/[.:%]/.test(address) && /\p{L}/u.test(address) && address.toLowerCase() !== 'localhost'
}

export type AddressSource = 'host' | 'domain'

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
  /** A hostname or an http(s) URL, stored as entered. */
  domain?: string | null
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
  domain: string | null
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
  // Your SSH keys: the agent, then the host's ~/.ssh/config IdentityFiles, then ~/.ssh/id_ed25519 and id_rsa.
  // `userSource` is set when the username came from a ~/.ssh/config User; otherwise it is the local user.
  | { source: 'global'; username: string; auth: 'default'; userSource?: 'ssh-config' }
export interface ResolvedHop {
  hostId: string
  label: string
  /** Dialled address, after any domain expansion. */
  address: string
  addressSource: AddressSource
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
  /** Dialled address, after any domain expansion. */
  address: string
  addressSource: AddressSource
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
