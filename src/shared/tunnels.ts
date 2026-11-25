// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import type { SshErrorCode } from './ssh'

export const MAX_TUNNELS = 256
export const MAX_RUNNING_TUNNELS = 64
export const TUNNEL_LIMIT = `Too many running tunnels (${MAX_RUNNING_TUNNELS})`
export const MAX_TUNNEL_CHANNELS = 128
export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 60000
/** Ten tries on the backoff is about four minutes: long enough for Wi-Fi to come back or a VPN to reconnect. */
export const DEFAULT_MAX_FAILURES = 10
export const STABLE_MS = 30000
export const PROBE_INTERVAL_MS = 15000
export const PROBE_TIMEOUT_MS = 3000
export const PROBE_GRACE_MS = 25
export const TUNNEL_KEEPALIVE_SEC = 15
export const STATS_MS = 1000
export const SPARK_POINTS = 60
export const SOCKS_HANDSHAKE_MS = 10000
export const SOCKS_MAX_REQUEST = 262
export const LSOF_TIMEOUT_MS = 2000
export const MAX_BIND_ADDRESS = 64
/** A running tunnel stops itself this many minutes after it was started, unless set otherwise or to no limit. */
export const DEFAULT_TUNNEL_MAX_MINUTES = 60
export const MAX_TUNNEL_MAX_MINUTES = 1440
/** The limits the tunnel dialog offers, in minutes; null is no limit. */
export const TUNNEL_MAX_MINUTES_CHOICES: readonly (number | null)[] = [15, 30, 60, 120, 240, 480, 1440, null]

const IPV4 = '(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
/** An IPv4 dotted quad, an IPv6 literal (shape only; the store also asks `net.isIP`) or `localhost`. */
export const BIND_ADDRESS = new RegExp(`^(?:localhost|${IPV4}|(?=(?:[^:]*:){2})[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?)$`, 'i')

export type TunnelType = 'L' | 'R' | 'D'

/** Changing any of these on a running tunnel restarts it. */
export const TUNNEL_ROUTE_FIELDS = ['hostId', 'environmentId', 'type', 'bindAddress', 'bindPort', 'targetHost', 'targetPort'] as const
export type TunnelState = 'stopped' | 'connecting' | 'up' | 'retrying' | 'failed'

export interface TunnelMeta {
  id: string
  label: string
  hostId: string
  environmentId: string | null
  type: TunnelType
  bindAddress: string
  bindPort: number
  /** `targetHost` and `targetPort` are null exactly when `type === 'D'`. */
  targetHost: string | null
  targetPort: number | null
  autoStart: boolean
  autoReconnect: boolean
  /** Minutes after a start when the tunnel disconnects itself; null runs it until it is stopped. */
  maxMinutes: number | null
  createdAt: string
  updatedAt: string
}

export interface TunnelInput {
  label: string
  hostId: string
  environmentId?: string
  type: TunnelType
  /** Default `127.0.0.1`. */
  bindAddress?: string
  bindPort: number
  targetHost?: string
  targetPort?: number
  /** Default false. */
  autoStart?: boolean
  /** Default true. */
  autoReconnect?: boolean
  /** Default DEFAULT_TUNNEL_MAX_MINUTES; null is no limit. */
  maxMinutes?: number | null
}

export type TunnelPatch = Partial<Omit<TunnelInput, 'environmentId' | 'targetHost' | 'targetPort'>> & {
  environmentId?: string | null
  targetHost?: string | null
  targetPort?: number | null
}

export type TunnelErrorCode = SshErrorCode | 'dropped' | 'probe-failed' | 'port-in-use' | 'bind-denied' | 'remote-refused'

export interface TunnelError {
  code: TunnelErrorCode
  message: string
  hopLabel?: string
}

export interface TunnelRuntime {
  id: string
  state: TunnelState
  error: TunnelError | null
  failures: number
  /** The failure count that turns `retrying` into `failed`, for "attempt 2 of 5". */
  maxFailures: number
  /** ISO; null while paused or not retrying. */
  retryAt: string | null
  boundAddress: string | null
  /** The real port when `bindPort` is 0. */
  boundPort: number | null
  liveness: 'probe' | 'keepalive'
  startedAt: string | null
  /** When a running tunnel with a time limit disconnects itself; null without one. */
  stopsAt: string | null
  upAt: string | null
  lastProbeAt: string | null
}

/** `bytesIn` is remote to local; the rates are bytes per second over the last `STATS_MS`. */
export interface TunnelStats {
  id: string
  bytesIn: number
  bytesOut: number
  rateIn: number
  rateOut: number
  connections: number
  rejected: number
  /** Connections the server would not forward to the target, and why the latest one failed. */
  openFailed: number
  lastOpenError: string | null
}

export type TunnelStopReason = 'user' | 'failed' | 'quit' | 'deleted' | 'edited' | 'reset' | 'expired'

export type TunnelEvent =
  | { type: 'connecting'; tunnelId: string; label: string; at: string; trigger: 'user' | 'auto' }
  | { type: 'up'; tunnelId: string; label: string; at: string; recovered: boolean }
  | { type: 'retrying'; tunnelId: string; label: string; at: string; failures: number; retryInMs: number | null; error: TunnelError }
  | { type: 'failed'; tunnelId: string; label: string; at: string; error: TunnelError; wasUp: boolean }
  | { type: 'stopped'; tunnelId: string; label: string; at: string; reason: TunnelStopReason }

/** `localhost`, `::1` and 127.0.0.0/8 are loopback; everything else (`0.0.0.0`, `::`, LAN addresses) is exposed. */
export function isLoopback(address: string): boolean {
  const a = address.trim().toLowerCase()
  if (a === 'localhost' || a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/** "45 min", "2 h", "1 h 30 min" for a time limit in minutes. */
export function minutesText(m: number): string {
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}
