import type { Db } from '../db/connection'
import { currentVersion } from '../db/migrations'
import { redact } from '../security/redact'
import { formatLogText } from './log-file'

export const DIAGNOSTICS_LOG_LINES = 200
export const NAME_MASK = '‹name›'
const IP_MASK = '‹ip›'
/** Shorter names ("db", "a") would mask ordinary words all over the log. */
const MIN_NAME_LENGTH = 3

/** Rows counted for the bundle: how much there is, never what it is called. */
const COUNTED = ['products', 'environments', 'hosts', 'deployments', 'services', 'tunnels', 'identities', 'ssh_keys', 'secrets', 'vaults', 'releases'] as const
export type DiagnosticCounts = Partial<Record<(typeof COUNTED)[number], number>>

/** Columns whose values name the user's infrastructure; each is masked out of the log tail. */
const NAMED: readonly (readonly [table: string, column: string])[] = [
  ['hosts', 'label'],
  ['hosts', 'address'],
  ['environments', 'name'],
  ['environments', 'domain'],
  ['products', 'name'],
  ['products', 'repo_url'],
  ['deployments', 'name'],
  ['deployments', 'repo_url'],
  ['services', 'name'],
  ['tunnels', 'label'],
  ['identities', 'label'],
  ['identities', 'username'],
  ['ssh_keys', 'label'],
  ['secrets', 'name'],
  ['vaults', 'name'],
  ['regions', 'code'],
  ['regions', 'name'],
  ['known_hosts', 'host'],
  ['hub_link', 'url'],
  ['hub_link', 'hub_name'],
  ['hub_link', 'user_upn'],
  ['hub_link', 'user_name'],
]

export function collectCounts(db: Db): DiagnosticCounts {
  const out: DiagnosticCounts = {}
  for (const table of COUNTED) {
    try {
      out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    } catch {
      // Table absent in this schema.
    }
  }
  return out
}

/** Every saved name, label, address and URL (with its host part on its own), for masking. */
export function collectNames(db: Db): string[] {
  const names = new Set<string>()
  for (const [table, column] of NAMED) {
    let rows: { v: unknown }[]
    try {
      rows = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as { v: unknown }[]
    } catch {
      continue
    }
    for (const { v } of rows) {
      if (typeof v !== 'string' || !v) continue
      names.add(v)
      try {
        const host = new URL(v).hostname
        if (host) names.add(host)
      } catch {
        // Not a URL.
      }
    }
  }
  return [...names]
}

/** Replaces every saved name in `s`, longest first so a name containing another is masked whole. */
export function maskNames(s: string, names: readonly string[], homeDir?: string): string {
  let out = s
  if (homeDir && homeDir.length > 1) out = out.split(homeDir).join('~')
  const usable = [...new Set(names)].filter((n) => n.length >= MIN_NAME_LENGTH).sort((a, b) => b.length - a.length)
  for (const name of usable) if (out.includes(name)) out = out.split(name).join(NAME_MASK)
  return out
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, IP_MASK)
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '‹email›')
}

export interface DiagnosticsInput {
  appVersion: string
  platform: string
  osRelease: string
  arch: string
  versions: { electron?: string; node?: string; chrome?: string }
  packaged: boolean
  schemaVersion: number
  counts: DiagnosticCounts
  logLines: readonly string[]
  knownSecrets: readonly string[]
  names: readonly string[]
  homeDir?: string
  now?: Date
}

/**
 * Plain text a user can paste into a support request. Holds versions, the schema version and row
 * counts; the log tail is redacted again (the file was redacted as it was written, but a secret
 * unlocked since may appear in older lines) and every saved name, address, IP and email is masked.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const counts = Object.entries(input.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const header = [
    'CredOps diagnostics',
    `generated: ${(input.now ?? new Date()).toISOString()}`,
    `app: ${input.appVersion}${input.packaged ? '' : ' (dev)'}`,
    `os: ${input.platform} ${input.osRelease} ${input.arch}`,
    `electron: ${input.versions.electron ?? 'n/a'}, node: ${input.versions.node ?? 'n/a'}, chrome: ${input.versions.chrome ?? 'n/a'}`,
    `schema: ${input.schemaVersion}`,
    `counts: ${counts || 'n/a'}`,
    '',
    `last ${input.logLines.length} log lines:`,
  ]
  const tail = input.logLines.map((line) => maskNames(formatLogText([line], input.knownSecrets), input.names, input.homeDir))
  return redact([...header, ...tail].join('\n'), input.knownSecrets) + '\n'
}

export interface DiagnosticsSource {
  db: Db
  log: { tail(n: number): string[] }
  knownSecrets: () => readonly string[]
  /** Names known outside the database (OS user, machine name), masked like saved ones. */
  extraNames?: readonly string[]
  env: Omit<DiagnosticsInput, 'schemaVersion' | 'counts' | 'logLines' | 'knownSecrets' | 'names'>
}

export function diagnosticsFrom(src: DiagnosticsSource): string {
  return buildDiagnostics({
    ...src.env,
    schemaVersion: currentVersion(src.db),
    counts: collectCounts(src.db),
    logLines: src.log.tail(DIAGNOSTICS_LOG_LINES),
    knownSecrets: src.knownSecrets(),
    names: [...collectNames(src.db), ...(src.extraNames ?? [])],
  })
}
