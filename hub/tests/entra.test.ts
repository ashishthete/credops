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
    expect(JSON.stringify((err as AuthError).reason)).not.toContain(tok)
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
})
