import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { SIGN_IN_TIMEOUT_MS, type HubMeta } from '../../shared/hub'

export type OidcErrorCode =
  | 'config'
  | 'discovery'
  | 'cancelled'
  | 'timeout'
  | 'state_mismatch'
  | 'denied'
  | 'exchange'
  | 'refresh_expired'
  | 'network'

/** Messages are fixed text: never an authorization code, verifier, token or provider description. */
export class OidcError extends Error {
  readonly code: OidcErrorCode
  constructor(code: OidcErrorCode, message: string) {
    super(message)
    this.name = 'OidcError'
    this.code = code
  }
}

export interface OidcEndpoints {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
}

type EntraCfg = HubMeta['entra']
type Fetch = typeof fetch

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const AUTHORITY_PATH = new RegExp(`^/${GUID}/v2\\.0$`)
/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 60_000
const NOT_ENTRA = "The Hub's sign-in authority is not Microsoft Entra"

const stripSlash = (s: string): string => s.replace(/\/+$/, '')

export function checkAuthority(authority: string): URL {
  let u: URL
  try {
    u = new URL(authority)
  } catch {
    throw new OidcError('config', NOT_ENTRA)
  }
  const hosted = u.protocol === 'https:' && u.hostname === 'login.microsoftonline.com' && u.port === ''
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port !== ''
  const path = u.pathname.replace(/\/+$/, '')
  if (!(hosted || local) || !AUTHORITY_PATH.test(path) || u.username || u.password || u.search || u.hash) {
    throw new OidcError('config', NOT_ENTRA)
  }
  return u
}

const cancelled = (): OidcError => new OidcError('cancelled', 'Sign-in was cancelled')

async function request(f: Fetch, url: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw cancelled()
  try {
    return await f(url, { ...init, ...(signal ? { signal } : {}) })
  } catch {
    // An abort surfaces as an AbortError; either way the cause is dropped.
    if (signal?.aborted) throw cancelled()
    throw new OidcError('network', 'Could not reach the sign-in service')
  }
}

function sameState(got: string | null, want: string): boolean {
  if (got === null) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function discover(authority: string, deps: { fetch: Fetch; signal?: AbortSignal }): Promise<OidcEndpoints> {
  const base = stripSlash(checkAuthority(authority).href)
  const res = await request(deps.fetch, `${base}/.well-known/openid-configuration`, undefined, deps.signal)
  const bad = new OidcError('discovery', 'The sign-in service returned an unusable configuration')
  // The provider failing is not an unusable configuration: callers keep the session and retry.
  if (res.status >= 500) throw new OidcError('network', 'The sign-in service is unavailable')
  if (!res.ok) throw bad
  let doc: unknown
  try {
    doc = await res.json()
  } catch {
    throw bad
  }
  const d = (doc ?? {}) as Record<string, unknown>
  const { issuer, authorization_endpoint: authz, token_endpoint: token } = d
  if (typeof issuer !== 'string' || typeof authz !== 'string' || typeof token !== 'string') throw bad
  if (stripSlash(issuer) !== base) throw bad
  // Endpoints must live on the authority's own origin.
  const origin = new URL(base).origin
  try {
    if (new URL(authz).origin !== origin || new URL(token).origin !== origin) throw bad
  } catch {
    throw bad
  }
  return { issuer, authorizationEndpoint: authz, tokenEndpoint: token }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const PAGE = (msg: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>OpsDeck</title></head><body><p>${msg}</p></body></html>`

export async function startLoopback(opts: {
  path: string
  state: string
  timeoutMs: number
  signal: AbortSignal
  host?: '127.0.0.1' | 'localhost'
}): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let settle!: { ok(v: string): void; fail(e: OidcError): void }
  const code = new Promise<string>((resolve, reject) => {
    settle = { ok: resolve, fail: reject }
  })
  // The caller may not be awaiting yet when the outcome lands.
  code.catch(() => undefined)

  let done = false
  let timer: NodeJS.Timeout | undefined
  const server: Server = createServer()

  const finish = (outcome: { code: string } | OidcError): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
    server.close()
    if (outcome instanceof OidcError) settle.fail(outcome)
    else settle.ok(outcome.code)
  }
  const onAbort = (): void => finish(cancelled())

  const reply = (res: ServerResponse, status: number, msg: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
    res.end(PAGE(msg), () => server.closeAllConnections())
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (done || req.method !== 'GET' || url.pathname !== opts.path) {
      res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' })
      return void res.end()
    }
    const q = url.searchParams
    if (!sameState(q.get('state'), opts.state)) {
      reply(res, 400, 'Sign-in failed. You can close this tab.')
      return finish(new OidcError('state_mismatch', 'The sign-in response did not match the request'))
    }
    if (q.has('error')) {
      reply(res, 400, 'Sign-in was not completed. You can close this tab.')
      return finish(new OidcError('denied', 'Sign-in was denied'))
    }
    const c = q.get('code')
    if (!c) {
      reply(res, 400, 'Sign-in failed. You can close this tab.')
      return finish(new OidcError('exchange', 'The sign-in response had no authorization code'))
    }
    reply(res, 200, 'Signed in to OpsDeck. You can close this tab.')
    finish({ code: c })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new OidcError('network', 'Could not open the local sign-in listener')))
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  if (opts.signal.aborted) onAbort()
  else {
    opts.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(new OidcError('timeout', 'Sign-in timed out')), opts.timeoutMs)
  }

  return {
    redirectUri: `http://${opts.host ?? '127.0.0.1'}:${port}${opts.path}`,
    code,
    close: () => {
      finish(cancelled())
      server.closeAllConnections()
    },
  }
}

export function authorizeUrl(
  ep: OidcEndpoints,
  cfg: EntraCfg,
  p: { redirectUri: string; state: string; challenge: string },
): string {
  const u = new URL(ep.authorizationEndpoint)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('scope', cfg.scopes.join(' '))
  u.searchParams.set('state', p.state)
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('prompt', 'select_account')
  return u.toString()
}

async function tokenRequest(
  ep: OidcEndpoints,
  form: Record<string, string>,
  failure: { code: OidcErrorCode; message: string },
  deps: { fetch: Fetch; now: () => number; signal?: AbortSignal },
): Promise<TokenSet> {
  const res = await request(
    deps.fetch,
    ep.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    },
    deps.signal,
  )
  let body: Record<string, unknown> = {}
  try {
    body = ((await res.json()) ?? {}) as Record<string, unknown>
  } catch {
    if (deps.signal?.aborted) throw cancelled()
    // otherwise fall through to the status check
  }
  if (!res.ok) {
    if (form.grant_type === 'refresh_token' && body.error === 'invalid_grant') {
      throw new OidcError('refresh_expired', 'Your sign-in has expired. Sign in again')
    }
    // The provider failing is not the person's sign-in failing: callers keep the session and retry.
    if (res.status >= 500 || res.status === 429) throw new OidcError('network', 'The sign-in service is unavailable')
    throw new OidcError(failure.code, failure.message)
  }
  const { access_token: access, refresh_token: refresh, expires_in: ttl } = body
  if (typeof access !== 'string' || !access || typeof ttl !== 'number' || !Number.isFinite(ttl)) {
    throw new OidcError(failure.code, failure.message)
  }
  return {
    accessToken: access,
    refreshToken: typeof refresh === 'string' && refresh ? refresh : null,
    expiresAt: deps.now() + ttl * 1000 - EXPIRY_SKEW_MS,
  }
}

export function exchangeCode(
  ep: OidcEndpoints,
  cfg: EntraCfg,
  p: { code: string; verifier: string; redirectUri: string },
  deps: { fetch: Fetch; now: () => number; signal?: AbortSignal },
): Promise<TokenSet> {
  return tokenRequest(
    ep,
    {
      client_id: cfg.clientId,
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      scope: cfg.scopes.join(' '),
    },
    { code: 'exchange', message: 'Sign-in could not be completed' },
    deps,
  )
}

export function refreshTokens(
  ep: OidcEndpoints,
  cfg: EntraCfg,
  refreshToken: string,
  deps: { fetch: Fetch; now: () => number; signal?: AbortSignal },
): Promise<TokenSet> {
  return tokenRequest(
    ep,
    { client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: cfg.scopes.join(' ') },
    { code: 'exchange', message: 'Sign-in could not be renewed' },
    deps,
  )
}

export async function signIn(
  cfg: EntraCfg,
  deps: { fetch: Fetch; openBrowser: (url: string) => Promise<void>; signal: AbortSignal; now: () => number; timeoutMs?: number },
): Promise<TokenSet> {
  checkAuthority(cfg.authority)
  let template: URL
  try {
    template = new URL(cfg.redirectUri)
  } catch {
    throw new OidcError('config', "The Hub's sign-in redirect is not a loopback address")
  }
  if (template.protocol !== 'http:' || (template.hostname !== '127.0.0.1' && template.hostname !== 'localhost')) {
    throw new OidcError('config', "The Hub's sign-in redirect is not a loopback address")
  }
  if (deps.signal.aborted) throw cancelled()

  const ep = await discover(cfg.authority, deps)
  const { verifier, challenge } = pkce()
  const state = randomBytes(16).toString('base64url')
  const lb = await startLoopback({
    path: template.pathname,
    state,
    timeoutMs: deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    signal: deps.signal,
    host: template.hostname as '127.0.0.1' | 'localhost',
  })
  try {
    // Race the browser launch against the loopback so a hung launcher cannot block Cancel or the timeout.
    const opened = Promise.resolve()
      .then(() => deps.openBrowser(authorizeUrl(ep, cfg, { redirectUri: lb.redirectUri, state, challenge })))
      .catch(() => {
        throw new OidcError('cancelled', 'Could not open the browser for sign-in')
      })
    opened.catch(() => undefined)
    const code = await Promise.race([lb.code, opened.then(() => lb.code)])
    if (deps.signal.aborted) throw cancelled()
    const tokens = await exchangeCode(ep, cfg, { code, verifier, redirectUri: lb.redirectUri }, deps)
    // A cancel that raced the exchange must not hand back credentials.
    if (deps.signal.aborted) throw cancelled()
    return tokens
  } finally {
    lb.close()
  }
}
