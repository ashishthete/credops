import type { FastifyInstance } from 'fastify'
import type { HubSession } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import type { HubAudit } from '../audit'
import { bearerOf, makeAuth } from '../auth/plugin'
import { AuthError, type EntraVerifier } from '../auth/entra'
import type { SessionStore } from '../auth/sessions'
import { HubHttpError } from '../errors'
import type { Coalescer, RateLimiter } from '../ratelimit'

export interface SessionRouteDeps {
  audit: HubAudit
  verifier: Pick<EntraVerifier, 'verify'>
  sessions: SessionStore
  directory: Directory
  now: () => Date
  /** Sign-in attempts per client address. */
  limiter: RateLimiter
  /** One full `session.denied` row per client address per window; the rest are summarised (see buildApp). */
  denials: Coalescer
}

export function registerSession(app: FastifyInstance, deps: SessionRouteDeps, auth: ReturnType<typeof makeAuth>): void {

  // Unauthenticated denials are written once per address per window, so a caller cannot flood the append-only log.
  const denied = (ip: string, reason: string): void => {
    if (deps.denials.first(ip)) {
      deps.audit.append({ action: 'session.denied', outcome: 'denied', actor: null, details: { reason, ip } })
    }
  }

  app.post('/api/v1/session', async (req, reply) => {
    const limit = deps.limiter.hit(req.ip)
    if (!limit.allowed) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))))
      throw new HubHttpError(429, 'unavailable', 'Too many sign-in attempts; try again shortly')
    }
    const entraToken = bearerOf(req)
    if (!entraToken) {
      denied(req.ip, 'missing')
      throw new HubHttpError(401, 'unauthenticated', 'Sign in with Microsoft')
    }
    let identity
    try {
      identity = await deps.verifier.verify(entraToken)
    } catch (err) {
      const reason = err instanceof AuthError ? err.reason : 'jwks'
      denied(req.ip, reason)
      throw new HubHttpError(401, 'unauthenticated', 'Microsoft sign-in token was not accepted')
    }
    const { user, created, bootstrapped, recovery, previousRole } = deps.directory.upsertOnSignIn(identity)
    const actor = { oid: user.oid, upn: user.upn, name: user.name, role: user.role }
    if (user.status === 'disabled') {
      deps.audit.append({ action: 'session.denied', outcome: 'denied', actor, details: { reason: 'disabled' } })
      throw new HubHttpError(403, 'forbidden', 'Your Hub account is disabled')
    }
    const { token, expiresAt } = deps.sessions.create(user.oid)
    deps.directory.touch(user.oid)
    deps.audit.append({
      action: 'session.create',
      outcome: 'success',
      actor,
      targetType: 'user',
      targetId: user.oid,
      details: { created, bootstrapped, recovery, pending: user.status === 'pending' },
    })
    if (bootstrapped && previousRole !== null && previousRole !== 'admin') {
      // Recovery path: an existing user was promoted. Audit the role change as its own event.
      deps.audit.append({
        action: 'user.update',
        outcome: 'success',
        actor,
        targetType: 'user',
        targetId: user.oid,
        targetLabel: user.upn,
        details: { op: 'bootstrap.repromote', from: previousRole, to: 'admin' },
      })
    }
    const session: HubSession = { token, expiresAt, user: deps.directory.get(user.oid)! }
    return reply.code(201).send(session)
  })

  app.delete('/api/v1/session', { onRequest: auth.requireUser }, async (req, reply) => {
    deps.sessions.revoke(req.sessionToken)
    deps.audit.append({
      action: 'session.revoke',
      outcome: 'success',
      actor: { oid: req.user.oid, upn: req.user.upn, name: req.user.name, role: req.user.role },
      targetType: 'user',
      targetId: req.user.oid,
    })
    return reply.code(204).send()
  })

  app.get('/api/v1/me', { onRequest: auth.requireUser }, async (req) => req.user)
}
