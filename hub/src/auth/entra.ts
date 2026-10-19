import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
import type { HubIdentity } from '../../../src/shared/hub'
import type { HubConfig } from '../config'

export type AuthErrorReason =
  | 'expired'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'tenant'
  | 'scope'
  | 'claims'
  | 'jwks'

export class AuthError extends Error {
  constructor(readonly reason: AuthErrorReason) {
    super('Microsoft sign-in token was not accepted')
    this.name = 'AuthError'
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface EntraVerifierDeps {
  now?: () => Date
  /** Minimum gap between JWKS refetches triggered by an unknown kid. */
  jwksCooldownMs?: number
}

function classify(err: unknown): AuthErrorReason {
  if (err instanceof errors.JWTExpired) return 'expired'
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return 'issuer'
    if (err.claim === 'aud') return 'audience'
    if (err.claim === 'exp') return 'expired'
    return 'claims'
  }
  if (err instanceof errors.JWKSTimeout) return 'jwks'
  if (err instanceof errors.JOSEError) {
    // Bad signature, unknown key, disallowed alg (none, HS256), malformed token.
    return 'signature'
  }
  return 'jwks' // network or parse failure fetching the key set
}

export class EntraVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>
  private readonly now: () => Date

  constructor(
    private readonly cfg: HubConfig['entra'],
    deps: EntraVerifierDeps = {},
  ) {
    this.now = deps.now ?? ((): Date => new Date())
    this.jwks = createRemoteJWKSet(new URL(cfg.jwksUri), { cooldownDuration: deps.jwksCooldownMs ?? 30_000 })
  }

  async verify(token: string): Promise<HubIdentity & { tid: string }> {
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.authority,
        audience: [this.cfg.clientId, `api://${this.cfg.clientId}`],
        algorithms: ['RS256'],
        clockTolerance: 120,
        currentDate: this.now(),
      }))
    } catch (err) {
      throw new AuthError(classify(err))
    }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
    if (payload.tid !== this.cfg.tenantId) throw new AuthError('tenant')
    const scopes = (str(payload.scp) ?? '').split(' ')
    if (!scopes.includes('access_as_user')) throw new AuthError('scope')
    const oid = str(payload.oid)
    const upn = str(payload.preferred_username) ?? str(payload.upn)
    if (!oid || !GUID.test(oid) || !upn) throw new AuthError('claims')
    return { oid, upn, name: str(payload.name) ?? upn, tid: this.cfg.tenantId }
  }
}
