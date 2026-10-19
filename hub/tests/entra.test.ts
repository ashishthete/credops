import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeEntra, type FakeEntra } from '../../tests/main/fake-entra'
import { AuthError, EntraVerifier } from '../src/auth/entra'

let entra: FakeEntra
let verifier: EntraVerifier
const OTHER = '99999999-9999-4999-8999-999999999999'

beforeEach(async () => {
  entra = await startFakeEntra()
  verifier = new EntraVerifier(
    {
      tenantId: entra.tenantId,
      clientId: entra.clientId,
      redirectUri: 'http://127.0.0.1/callback',
      authority: entra.issuer,
      jwksUri: `${entra.authority.replace('/v2.0', '')}/discovery/v2.0/keys`,
    },
    { jwksCooldownMs: 0 },
  )
})
afterEach(async () => entra.close())

describe('EntraVerifier', () => {
  it('accepts a valid access token', async () => {
    const id = await verifier.verify(entra.mintAccessToken())
    expect(id).toEqual({ oid: entra.user.oid, upn: entra.user.upn, name: entra.user.name, tid: entra.tenantId })
  })

  const cases: [string, (e: FakeEntra) => string, string][] = [
    ['aud', (e) => e.mintAccessToken({ aud: OTHER }), 'audience'],
    ['tid', (e) => e.mintAccessToken({ tid: OTHER }), 'tenant'],
    ['iss', (e) => e.mintAccessToken({ iss: `http://127.0.0.1:1/${OTHER}/v2.0` }), 'issuer'],
    ['id_token', (e) => e.mintIdToken(), 'scope'],
    ['expired', (e) => e.mintAccessToken({}, { expiresInSec: -300 }), 'expired'],
    ['rogue key', (e) => e.mintAccessToken({}, { key: 'rogue' }), 'signature'],
    ['alg none', (e) => e.mintAccessToken({}, { alg: 'none' }), 'signature'],
    ['HS256 with public jwk', (e) => e.mintAccessToken({}, { alg: 'HS256-with-public-jwk' }), 'signature'],
    ['missing oid', (e) => e.mintAccessToken({ oid: undefined }), 'claims'],
  ]
  it.each(cases)('rejects %s', async (_n, mint, reason) => {
    const tok = mint(entra)
    const err = await verifier.verify(tok).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).reason).toBe(reason)
    expect((err as AuthError).message).toBe('Microsoft sign-in token was not accepted')
    expect(String(err)).not.toContain(tok)
    expect((err as AuthError).stack).not.toContain(tok)
  })

  it('falls back to upn for the name and rejects a missing upn', async () => {
    const id = await verifier.verify(entra.mintAccessToken({ name: undefined }))
    expect(id.name).toBe(entra.user.upn)
    await expect(verifier.verify(entra.mintAccessToken({ preferred_username: undefined }))).rejects.toMatchObject({ reason: 'claims' })
  })

  it('follows key rotation', async () => {
    await verifier.verify(entra.mintAccessToken())
    entra.rotateKeys()
    await expect(verifier.verify(entra.mintAccessToken())).resolves.toMatchObject({ oid: entra.user.oid })
  })

  it('accepts clock skew, api:// audience and a multi-value scp', async () => {
    await expect(verifier.verify(entra.mintAccessToken({}, { expiresInSec: -60 }))).resolves.toBeTruthy()
    await expect(verifier.verify(entra.mintAccessToken({ aud: `api://${entra.clientId}` }))).resolves.toBeTruthy()
    await expect(verifier.verify(entra.mintAccessToken({ scp: 'other access_as_user' }))).resolves.toBeTruthy()
    await expect(verifier.verify(entra.mintAccessToken({ scp: 'other' }))).rejects.toMatchObject({ reason: 'scope' })
  })

  it('honours the now dep', async () => {
    const late = new EntraVerifier(
      { ...cfgOf(entra) },
      { now: () => new Date(Date.now() + 3 * 3600_000), jwksCooldownMs: 0 },
    )
    await expect(late.verify(entra.mintAccessToken())).rejects.toMatchObject({ reason: 'expired' })
  })

  it('tolerates a trailing slash on the authority and an upper-case tenant id', async () => {
    const v = new EntraVerifier(
      { ...cfgOf(entra), authority: `${entra.issuer}/`, tenantId: entra.tenantId.toUpperCase() },
      { jwksCooldownMs: 0 },
    )
    await expect(v.verify(entra.mintAccessToken())).resolves.toBeTruthy()
  })
})

function cfgOf(e: FakeEntra) {
  return {
    tenantId: e.tenantId,
    clientId: e.clientId,
    redirectUri: 'http://127.0.0.1/callback',
    authority: e.issuer,
    jwksUri: `${e.issuer.replace('/v2.0', '')}/discovery/v2.0/keys`,
  }
}

describe('EntraVerifier jwks failures', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })

  async function verifierFor(status: number, body: string): Promise<EntraVerifier> {
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    return new EntraVerifier({ ...cfgOf(entra), jwksUri: `http://127.0.0.1:${port}/keys` }, { jwksCooldownMs: 0 })
  }

  it.each([
    ['a non-200 status', 404, '{}'],
    ['a 5xx status', 503, '{"keys":[]}'],
    ['invalid json', 200, '<html>proxy</html>'],
    ['a malformed key set', 200, '{"keys":"nope"}'],
  ])('%s is reported as jwks', async (_n, status, body) => {
    const v = await verifierFor(status, body)
    const tok = entra.mintAccessToken()
    const err = await v.verify(tok).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).reason).toBe('jwks')
  })

  it('an unreachable endpoint is reported as jwks', async () => {
    const v = await verifierFor(200, '{}')
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    await expect(v.verify(entra.mintAccessToken())).rejects.toMatchObject({ reason: 'jwks' })
  })

  it('an empty key set is a signature failure, not an outage', async () => {
    const v = await verifierFor(200, '{"keys":[]}')
    await expect(v.verify(entra.mintAccessToken())).rejects.toMatchObject({ reason: 'signature' })
  })
})
