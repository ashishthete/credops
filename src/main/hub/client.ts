import { HUB_TIMEOUT_MS, type HubErrorCode } from '../../shared/hub'
import { redact } from '../security/redact'

type Fetch = typeof fetch
type Query = Record<string, string | number | boolean | readonly string[] | undefined>

export type HubClientErrorCode = HubErrorCode | 'network' | 'timeout' | 'incompatible'

/** Messages are the Hub's own fixed text, redacted; they never carry a token. */
export class HubError extends Error {
  readonly code: HubClientErrorCode
  readonly status?: number
  constructor(code: HubClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'HubError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface HubClientDeps {
  baseUrl: string
  fetch: Fetch
  token: () => string | null
  /** Replaces the session after a 401 session_expired; resolves false when the user must sign in again. */
  renew: () => Promise<boolean>
  knownSecrets: () => readonly string[]
  timeoutMs?: number
  /** Reports whether the last request reached the Hub. */
  onReach?: (online: boolean) => void
}

const ERROR_CODES: readonly string[] = [
  'bad_request', 'unauthenticated', 'session_expired', 'forbidden', 'not_found', 'conflict',
  'last_group', 'last_admin', 'builtin_group', 'unavailable', 'internal',
]

export class HubClient {
  private readonly d: HubClientDeps

  constructor(deps: HubClientDeps) {
    this.d = deps
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, undefined, query)
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body)
  }
  async del(path: string, body?: unknown): Promise<void> {
    await this.request<void>('DELETE', path, body)
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    try {
      return await this.once<T>(method, path, body, query)
    } catch (err) {
      if (!(err instanceof HubError) || err.code !== 'session_expired') throw err
      if (!(await this.d.renew())) throw new HubError('unauthenticated', 'Sign in to the Hub again', 401)
      return this.once<T>(method, path, body, query)
    }
  }

  private url(path: string, query?: Query): string {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue
      if (Array.isArray(v)) for (const item of v) qs.append(k, item)
      else qs.append(k, String(v))
    }
    const s = qs.toString()
    return `${this.d.baseUrl.replace(/\/+$/, '')}${path}${s ? `?${s}` : ''}`
  }

  private async once<T>(method: string, path: string, body: unknown, query?: Query): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = this.d.token()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.d.timeoutMs ?? HUB_TIMEOUT_MS)
    let res: Response
    let text: string
    try {
      res = await this.d.fetch(this.url(path, query), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      })
      text = await res.text()
    } catch {
      this.d.onReach?.(false)
      // The cause is dropped: it can name the URL or echo request details.
      if (ctl.signal.aborted) throw new HubError('timeout', 'The Hub took too long to respond')
      throw new HubError('network', "Can't reach the Hub")
    } finally {
      clearTimeout(timer)
    }
    this.d.onReach?.(true)
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (res.ok) return parsed as T
    const b = (parsed ?? {}) as { error?: unknown; message?: unknown }
    const code = (typeof b.error === 'string' && ERROR_CODES.includes(b.error) ? b.error : 'internal') as HubErrorCode
    const message = typeof b.message === 'string' && b.message ? b.message : `The Hub returned an error (${res.status})`
    throw new HubError(code, redact(message, this.d.knownSecrets()), res.status)
  }
}
