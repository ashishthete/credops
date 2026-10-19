import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, type TunnelErrorCode } from '../../shared/tunnels'

/** The wait before retry number `failure` (1-based): 1, 2, 4, 8 s and so on, capped at `BACKOFF_CAP_MS`. */
export function backoffMs(failure: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (Math.max(1, failure) - 1), BACKOFF_CAP_MS)
}

const RETRYABLE: ReadonlySet<TunnelErrorCode> = new Set<TunnelErrorCode>([
  'refused',
  'not-found',
  'timeout',
  'closed',
  'dropped',
  'probe-failed',
  'unknown',
])

/**
 * Network trouble is retried on the backoff. Auth, host keys, bind and remote-listen refusals and the
 * limit fail at once, so a reconnect loop never re-prompts or re-binds forever.
 */
export function isRetryable(code: TunnelErrorCode): boolean {
  return RETRYABLE.has(code)
}
