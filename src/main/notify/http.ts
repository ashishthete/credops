import { redact } from '../security/redact'

export type Fetch = typeof fetch
export type IntegrationService = 'teams' | 'sendgrid' | 'github' | 'anthropic'
export type IntegrationErrorCode = 'http' | 'network' | 'timeout' | 'auth' | 'config'

/** Fixed text per service. Messages never hold a URL, a header or a response body. */
const NAMES: Record<IntegrationService, { name: string; short: string; failed: string; auth: string }> = {
  teams: { name: 'Teams webhook', short: 'Teams', failed: 'Teams webhook failed', auth: 'Teams rejected the webhook' },
  sendgrid: { name: 'SendGrid', short: 'SendGrid', failed: 'SendGrid request failed', auth: 'SendGrid rejected the API key' },
  github: { name: 'GitHub', short: 'GitHub', failed: 'GitHub request failed', auth: 'GitHub rejected the token' },
  anthropic: { name: 'Claude API', short: 'Claude', failed: 'Claude API request failed', auth: 'Claude rejected the API key' },
}

export class IntegrationError extends Error {
  override readonly name = 'IntegrationError'
  readonly service: IntegrationService
  readonly code: IntegrationErrorCode
  readonly status?: number

  constructor(service: IntegrationService, code: IntegrationErrorCode, message: string, knownSecrets: readonly string[], status?: number) {
    super(redact(message, knownSecrets))
    this.service = service
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface HttpOptions {
  service: IntegrationService
  headers?: Record<string, string>
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  timeoutMs?: number
  knownSecrets: readonly string[]
}

const TIMEOUT_MS = 10_000
const RETRY_WAITS = [1000, 4000] as const
const MAX_RETRY_AFTER_S = 30
const DEFAULT_MAX_BYTES = 4096

function fail(o: HttpOptions, code: IntegrationErrorCode, status?: number): IntegrationError {
  const n = NAMES[o.service]
  const text =
    code === 'config' ? `${n.name} URL must use https`
    : code === 'network' ? `${n.name} could not be reached`
    : code === 'timeout' ? `${n.name} timed out`
    : code === 'auth' ? `${n.auth} (HTTP ${status})`
    : status === undefined ? `${n.short} returned a response OpsDeck could not read`
    : `${n.failed} (HTTP ${status})`
  return new IntegrationError(o.service, code, text, o.knownSecrets, status)
}

function httpsUrl(url: string, o: HttpOptions): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw fail(o, 'config')
  }
  if (parsed.protocol !== 'https:') throw fail(o, 'config')
  return url
}

/** Seconds from `Retry-After`, as ms, when it is at most 30 s; otherwise null. */
function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after')
  if (v === null) return null
  const secs = /^\d+$/.test(v.trim()) ? Number(v.trim()) : (Date.parse(v) - Date.now()) / 1000
  return Number.isFinite(secs) && secs >= 0 && secs <= MAX_RETRY_AFTER_S ? Math.ceil(secs * 1000) : null
}

const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // The body is never read; a cancel failure changes nothing.
  }
}

/**
 * One guarded request: https only, 10 s per attempt, up to 2 retries on network errors, 429 and 5xx.
 * A timeout is never retried: the request may have arrived, and a retry could post twice.
 */
async function request(url: string, init: RequestInit, o: HttpOptions): Promise<Response> {
  const target = httpsUrl(url, o)
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await o.fetch(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) })
    } catch (e) {
      if (isTimeout(e)) throw fail(o, 'timeout')
      if (attempt < RETRY_WAITS.length) {
        await o.sleep(RETRY_WAITS[attempt]!)
        continue
      }
      throw fail(o, 'network')
    }
    if (res.ok) return res
    await discard(res)
    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < RETRY_WAITS.length) {
      await o.sleep((res.status === 429 ? retryAfterMs(res) : null) ?? RETRY_WAITS[attempt]!)
      continue
    }
    throw fail(o, res.status === 401 || res.status === 403 ? 'auth' : 'http', res.status)
  }
}

export async function postJson(url: string, body: unknown, o: HttpOptions): Promise<Response> {
  return request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...o.headers }, body: JSON.stringify(body) }, o)
}

/** Reads at most `maxBytes` (4 KB by default); a larger or non-JSON body is an error. */
export async function getJson<T>(url: string, o: HttpOptions & { maxBytes?: number }): Promise<T> {
  const res = await request(url, { method: 'GET', headers: { accept: 'application/json', ...o.headers } }, o)
  const max = o.maxBytes ?? DEFAULT_MAX_BYTES
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw fail(o, 'http')
      }
      chunks.push(value)
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw fail(o, 'http')
  }
}
