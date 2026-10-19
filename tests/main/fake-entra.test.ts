import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeEntra, type FakeEntra } from './fake-entra'

let entra: FakeEntra
afterEach(async () => entra.close())

const b64u = (b: Buffer): string => b.toString('base64url')
const REDIRECT = 'http://127.0.0.1:5555/callback'

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}

async function authorize(challenge: string, state = 'st1'): Promise<URL> {
  const u = new URL(`${entra.authority.replace('/v2.0', '')}/oauth2/v2.0/authorize`)
  u.search = new URLSearchParams({
    client_id: entra.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: `openid profile offline_access api://${entra.clientId}/access_as_user`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  const res = await fetch(u, { redirect: 'manual' })
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location')!)
}

function token(body: Record<string, string>): Promise<Response> {
  return fetch(`${entra.authority.replace('/v2.0', '')}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
}

describe('fake entra', () => {
  it('discovery points at its own endpoints', async () => {
    entra = await startFakeEntra()
    const d = (await (await fetch(`${entra.authority}/.well-known/openid-configuration`)).json()) as Record<string, string>
    expect(d.issuer).toBe(entra.issuer)
    expect(d.token_endpoint).toContain(`/${entra.tenantId}/oauth2/v2.0/token`)
    const keys = (await (await fetch(d.jwks_uri)).json()) as { keys: { kid: string }[] }
    expect(keys.keys[0].kid).toBeTruthy()
  })

  it('authorize redirects with code and state, token checks pkce', async () => {
    entra = await startFakeEntra()
    const { verifier, challenge } = pkce()
    const loc = await authorize(challenge)
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get('state')).toBe('st1')
    const code = loc.searchParams.get('code')!

    const bad = await token({ grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: REDIRECT, client_id: entra.clientId })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant')

    const loc2 = await authorize(challenge)
    const ok = await token({ grant_type: 'authorization_code', code: loc2.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, client_id: entra.clientId })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as Record<string, unknown>
    expect(body.token_type).toBe('Bearer')
    expect(body.access_token && body.id_token && body.refresh_token).toBeTruthy()
  })

  it('denies when armed', async () => {
    entra = await startFakeEntra()
    entra.deny(true)
    const loc = await authorize(pkce().challenge)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st1')
  })

  it('codes are single use', async () => {
    entra = await startFakeEntra()
    const { verifier, challenge } = pkce()
    const code = (await authorize(challenge)).searchParams.get('code')!
    const req = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: entra.clientId }
    expect((await token(req)).status).toBe(200)
    expect((await token(req)).status).toBe(400)
  })

  it('refresh rotates', async () => {
    entra = await startFakeEntra()
    const { verifier, challenge } = pkce()
    const code = (await authorize(challenge)).searchParams.get('code')!
    const first = (await (await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: entra.clientId })).json()) as { refresh_token: string }
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: entra.clientId })
    expect(r1.status).toBe(200)
    const second = (await r1.json()) as { refresh_token: string }
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: entra.clientId })).status).toBe(400)
  })
})
