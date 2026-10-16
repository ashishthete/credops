// Imported by the renderer: keep this file to plain constants and types (no node or electron imports).

export const DEFAULT_KEEPALIVE_SEC = 30 // sent every N seconds; ssh2 keepaliveCountMax is 3
export const READY_TIMEOUT_MS = 20_000 // per hop
export const PROMPT_TIMEOUT_MS = 120_000 // an unanswered prompt counts as cancelled
export const MAX_SESSIONS = 32
export const SCROLLBACK_CHARS = 1_048_576 // ring buffer per session, trimmed from the front
export const FLUSH_MS = 16
export const FLUSH_CHARS = 65_536
export const MAX_WRITE_CHARS = 65_536 // per session:write
export const MAX_COLS = 1000
export const MAX_ROWS = 500
export const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024

export type SessionKind = 'ssh' | 'local'
export type SessionState = 'connecting' | 'ready' | 'closed' | 'failed'
export type HopState = 'pending' | 'connecting' | 'up' | 'failed'

/** For SSH, the jump chain then the target, first first; empty for a local shell. */
export interface SessionHop {
  label: string
  state: HopState
}

export type SshErrorCode =
  | 'refused'
  | 'not-found'
  | 'timeout'
  | 'auth'
  | 'host-key-changed'
  | 'host-key-revoked'
  | 'host-key-rejected'
  | 'locked'
  | 'limit'
  | 'closed'
  | 'unknown'

export interface HostKeyInfo {
  host: string
  keyType: string
  fingerprint: string
  known: { keyType: string; fingerprint: string; source: 'app' | 'openssh'; line?: number }[]
}

export interface SessionError {
  code: SshErrorCode
  message: string
  hopLabel?: string
  hostKey?: HostKeyInfo
}

export interface SessionMeta {
  id: string
  kind: SessionKind
  hostId: string | null
  environmentId: string | null
  label: string
  /** The environment colour; null when there is no context. */
  color: string | null
  state: SessionState
  hops: SessionHop[]
  error: SessionError | null
  openedAt: string
  readyAt: string | null
  closedAt: string | null
  /** Starts at 1; each reconnect adds 1. */
  attempt: number
}

export interface OpenSshRequest {
  hostId: string
  environmentId?: string
  cols: number
  rows: number
}
export interface OpenLocalRequest {
  cols: number
  rows: number
}

export type SessionPrompt =
  | { kind: 'host-key'; promptId: string; sessionId: string; hopLabel: string; info: HostKeyInfo }
  | { kind: 'password'; promptId: string; sessionId: string; hopLabel: string; username: string }
  | {
      kind: 'keyboard'
      promptId: string
      sessionId: string
      hopLabel: string
      name: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    }

/** `null` means cancel. */
export type PromptAnswer =
  | { kind: 'host-key'; trust: boolean }
  | { kind: 'password'; password: string | null }
  | { kind: 'keyboard'; responses: string[] | null }

export interface KnownHostMeta {
  id: string
  host: string
  keyType: string
  fingerprint: string
  firstSeen: string
  lastSeen: string
}
