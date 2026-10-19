// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import type { HostRole } from './inventory'
import type { SessionError } from './ssh'

export const MAX_SNIPPETS = 500
export const MAX_SCRIPT = 16_384 // chars
export const MAX_SNIPPET_DESCRIPTION = 500
export const MAX_VARIABLES = 16
/** Lower-case snake case; never an Object.prototype name (`__proto__` already fails the first-letter rule). */
export const VARIABLE_NAME = /^(?!(?:constructor|prototype)$)[a-z][a-z0-9_]{0,31}$/
export const MAX_VARIABLE_VALUE = 4096
export const MAX_COMMAND = 16_384
export const MAX_RUN_TARGETS = 100
export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 16
export const DEFAULT_RUN_TIMEOUT_SEC = 600
export const MAX_RUN_TIMEOUT_SEC = 3600
export const RUN_OUTPUT_CHARS = 262_144 // per host: a ring trimmed from the front, with a `truncated` flag
export const MAX_RUNS_KEPT = 20 // finished runs beyond this are dropped oldest-first
export const MAX_ACTIVE_RUNS = 4
export const OUTPUT_FLUSH_MS = 50
export const OUTPUT_FLUSH_CHARS = 32_768
export const LOG_TAIL_DEFAULT = 200
export const LOG_TAIL_MAX = 5000
export const MAX_LOG_FOLLOWS = 8
export const LINK_IDLE_MS = 30_000
export const MAX_EXEC_LINKS = 24
/** Exec channels open at once on one link; below OpenSSH's default `MaxSessions 10`. */
export const MAX_CHANNELS_PER_LINK = 8
/** A container id or name: one word that can never read as an option. */
export const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
export const MAX_CONTAINERS = 500

/**
 * A command that needs the protected-environment confirmation. Word matches, case-insensitive (`DROP TABLE`).
 * A redirect to /dev/ counts except to null, stdout, stderr, tty and fd/, which every script uses.
 */
export const DESTRUCTIVE_PATTERN = new RegExp(
  [
    String.raw`\b(?:rm|rmdir|mkfs(?:\.\w+)?|dd|shutdown|reboot|halt|poweroff|kill|pkill|killall|truncate|drop)\b`,
    String.raw`\bsystemctl\s+(?:stop|restart|disable|kill)\b`,
    String.raw`\bservice\s+\S+\s+(?:stop|restart)\b`,
    String.raw`\bdocker\s+(?:rm|rmi|stop|kill|restart|prune)\b`,
    String.raw`\bdocker\s+system\s+prune\b`,
    String.raw`\bdocker\s+compose\s+down\b`,
    String.raw`>\s*\/dev\/(?!(?:null|stdout|stderr|tty)\b|fd\/)`,
  ].join('|'),
  'i',
)

export interface SnippetVariable {
  name: string
  /** Opened from the sealed defaults; only names are stored in plaintext. */
  default: string | null
}

/** A snippet as main returns it while the vault is unlocked: `script` and the defaults are opened from their sealed columns. */
export interface SnippetMeta {
  id: string
  label: string
  script: string
  description: string
  tags: string[]
  variables: SnippetVariable[]
  destructive: boolean
  createdAt: string
  updatedAt: string
}

/** Main seals `script` and `defaults` with the Default vault before storing them. */
export interface SnippetInput {
  label: string
  script: string
  description?: string
  tags?: string[]
  defaults?: Record<string, string | null>
  destructive?: boolean
}

export type RunTarget =
  | { kind: 'hosts'; hostIds: string[]; environmentId?: string }
  | { kind: 'environment'; environmentId: string; role?: HostRole }

export type RunCommand = { kind: 'text'; text: string } | { kind: 'snippet'; snippetId: string; values: Record<string, string> }

export interface RunRequest {
  target: RunTarget
  command: RunCommand
  concurrency?: number
  timeoutSec?: number
  confirm?: string
}

/**
 * `details.command` of a run.start audit row. A typed command is never stored, only its program and size:
 * no pattern pass can catch every way a secret is typed (-pXXX, URLs, base64).
 */
export type AuditedRunCommand =
  | { kind: 'text'; program: string; chars: number; lines: number }
  | { kind: 'snippet'; snippetId: string; label: string; variables: string[] }

export type RunHostState = 'queued' | 'connecting' | 'running' | 'ok' | 'failed' | 'cancelled' | 'timeout'

export interface RunHostMeta {
  hostId: string
  label: string
  state: RunHostState
  exitCode: number | null
  signal: string | null
  error: SessionError | null
  startedAt: string | null
  endedAt: string | null
  truncated: boolean
}

export interface RunSummary {
  id: string
  state: 'running' | 'done' | 'cancelled'
  title: string
  environmentId: string | null
  environmentName: string | null
  concurrency: number
  hosts: RunHostMeta[]
  startedAt: string
  endedAt: string | null
}

export interface RunOutput {
  hostId: string
  text: string
  errRanges: [number, number][]
}

/** stdout and stderr interleave into one stream per host; stderr chunks carry `stream: 'err'`. */
export type RunEvent =
  | { runId: string; kind: 'host'; host: RunHostMeta }
  | { runId: string; kind: 'output'; hostId: string; chunk: string; stream?: 'err' }
  | { runId: string; kind: 'run'; run: RunSummary }

export const CONTAINER_STATES = ['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing', 'unknown'] as const

export interface ContainerMeta {
  id: string
  name: string
  image: string
  state: (typeof CONTAINER_STATES)[number]
  status: string
  ports: string
  createdAt: string
  project: string | null
  service: string | null
}

export interface ContainerList {
  containers: ContainerMeta[]
  truncated: boolean
  skipped: number
  fetchedAt: string
}

export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'] as const
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number]

export type ContainerLogEvent = { followId: string; chunk: string } | { followId: string; ended: true; error: SessionError | null }
