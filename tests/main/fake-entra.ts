import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface FakeUser {
  oid: string
  upn: string
  name: string
}

export interface MintOpts {
  key?: 'current' | 'rogue'
  alg?: 'RS256' | 'none' | 'HS256-with-public-jwk'
  expiresInSec?: number
}

export interface FakeEntra {
  tenantId: string
  clientId: string
  /** `<origin>/<tenant>/v2.0`: the issuer and the base of the discovery document. */
  authority: string
  issuer: string
  user: FakeUser
  requests: { path: string; params: Record<string, string> }[]
  setUser(u: FakeUser): void
  deny(on: boolean): void
  rotateKeys(): void
  mintAccessToken(claims?: Record<string, unknown>, opts?: MintOpts): string
  mintIdToken(claims?: Record<string, unknown>): string
  close(): Promise<void>
}

interface KeyPair {
  kid: string
  priv: KeyObject
  jwk: Record<string, unknown>
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')
const s256 = (v: string): string => createHash('sha256').update(v).digest('base64url')

function newKey(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = randomUUID()
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } }
}

export async function startFakeEntra(opts: { tenantId?: string; clientId?: string } = {}): Promise<FakeEntra> {
  const tenantId = opts.tenantId ?? randomUUID()
  const clientId = opts.clientId ?? randomUUID()
  let current = newKey()
  const rogue = newKey()
  let denyOn = false
  const user: FakeUser = { oid: randomUUID(), upn: 'alice@example.com', name: 'Alice Example' }
  const requests: FakeEntra['requests'] = []
  const codes = new Map<string, { challenge: string; redirect: string; nonce?: string; exp: number }>()
  const refreshTokens = new Set<string>()
  let origin = ''

  const issuerOf = (): string => `${origin}/${tenantId}/v2.0`

  function sign(claims: Record<string, unknown>, o: MintOpts = {}): string {
    const alg = o.alg ?? 'RS256'
    const key = o.key === 'rogue' ? rogue : current
    const header = { alg, typ: 'JWT', kid: key.kid }
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
    if (alg === 'none') return `${input}.`
    if (alg === 'HS256-with-public-jwk') {
      return `${input}.${createHmac('sha256', String(current.jwk.n)).update(input).digest('base64url')}`
    }
    return `${input}.${createSign('RSA-SHA256').update(input).sign(key.priv).toString('base64url')}`
  }

  function baseClaims(extra: Record<string, unknown>, expiresInSec = 3600): Record<string, unknown> {
    const iat = Math.floor(Date.now() / 1000)
    return {
      iss: issuerOf(),
      tid: tenantId,
      oid: user.oid,
      name: user.name,
      preferred_username: user.upn,
      ver: '2.0',
      iat,
      nbf: iat,
      exp: iat + expiresInSec,
      ...extra,
    }
  }

  const mintAccessToken: FakeEntra['mintAccessToken'] = (claims = {}, o = {}) =>
    sign(baseClaims({ aud: clientId, scp: 'access_as_user', ...claims }, o.expiresInSec), o)
  const mintIdToken: FakeEntra['mintIdToken'] = (claims = {}) => sign(baseClaims({ aud: clientId, ...claims }))

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const invalidGrant = (res: ServerResponse): void => json(res, 400, { error: 'invalid_grant' })

  function issue(res: ServerResponse, nonce?: string): void {
    const refresh = randomBytes(24).toString('base64url')
    refreshTokens.add(refresh)
    json(res, 200, {
      access_token: mintAccessToken(),
      id_token: mintIdToken(nonce ? { nonce } : {}),
      refresh_token: refresh,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: `openid profile offline_access api://${clientId}/access_as_user`,
    })
  }

  async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const prefix = `/${tenantId}`
      const path = url.pathname
      if (req.method === 'GET' && path === `${prefix}/v2.0/.well-known/openid-configuration`) {
        requests.push({ path, params: {} })
        return json(res, 200, {
          issuer: issuerOf(),
          authorization_endpoint: `${origin}${prefix}/oauth2/v2.0/authorize`,
          token_endpoint: `${origin}${prefix}/oauth2/v2.0/token`,
          jwks_uri: `${origin}${prefix}/discovery/v2.0/keys`,
        })
      }
      if (req.method === 'GET' && path === `${prefix}/discovery/v2.0/keys`) {
        requests.push({ path, params: {} })
        return json(res, 200, { keys: [current.jwk] })
      }
      if (req.method === 'GET' && path === `${prefix}/oauth2/v2.0/authorize`) {
        const p = Object.fromEntries(url.searchParams)
        requests.push({ path, params: p })
        const redirect = p.redirect_uri ?? ''
        if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(redirect)) {
          return json(res, 400, { error: 'invalid_request', message: 'redirect_uri' })
        }
        if (
          p.client_id !== clientId ||
          p.response_type !== 'code' ||
          p.code_challenge_method !== 'S256' ||
          !p.code_challenge ||
          !(p.scope ?? '').split(' ').includes(`api://${clientId}/access_as_user`)
        ) {
          return json(res, 400, { error: 'invalid_request' })
        }
        const back = new URL(redirect)
        if (denyOn) {
          back.searchParams.set('error', 'access_denied')
        } else {
          const code = randomBytes(18).toString('base64url')
          codes.set(code, { challenge: p.code_challenge, redirect, nonce: p.nonce, exp: Date.now() + 60_000 })
          back.searchParams.set('code', code)
        }
        if (p.state !== undefined) back.searchParams.set('state', p.state)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (req.method === 'POST' && path === `${prefix}/oauth2/v2.0/token`) {
        const f = await readForm(req)
        requests.push({ path, params: f })
        if (f.client_id !== clientId) return invalidGrant(res)
        if (f.grant_type === 'authorization_code') {
          const entry = f.code ? codes.get(f.code) : undefined
          if (f.code) codes.delete(f.code) // single use, even when the attempt fails
          if (
            !entry ||
            entry.exp < Date.now() ||
            entry.redirect !== f.redirect_uri ||
            !f.code_verifier ||
            s256(f.code_verifier) !== entry.challenge
          ) {
            return invalidGrant(res)
          }
          return issue(res, entry.nonce)
        }
        if (f.grant_type === 'refresh_token') {
          if (!f.refresh_token || !refreshTokens.delete(f.refresh_token)) return invalidGrant(res)
          return issue(res)
        }
        return invalidGrant(res)
      }
      json(res, 404, { error: 'not_found' })
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server_error' })
      else res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const fake: FakeEntra = {
    tenantId,
    clientId,
    authority: issuerOf(),
    issuer: issuerOf(),
    user,
    requests,
    setUser(u) {
      Object.assign(user, u)
    },
    deny(on) {
      denyOn = on
    },
    rotateKeys() {
      current = newKey()
    },
    mintAccessToken,
    mintIdToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return fake
}
