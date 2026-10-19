import type { FastifyInstance } from 'fastify'
import type { HubSession } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import type { HubAudit } from '../audit'
import { bearerOf, makeAuth } from '../auth/plugin'
import { AuthError, type EntraVerifier } from '../auth/entra'
import type { SessionStore } from '../auth/sessions'
import { HubHttpError } from '../errors'

export interface SessionRouteDeps {
  audit: HubAudit
  verifier: Pick<EntraVerifier, 'verify'>
  sessions: SessionStore
  directory: Directory
  now: () => Date
}

export function registerSession(app: FastifyInstance, deps: SessionRouteDeps, auth: ReturnType<typeof makeAuth>): void {

  app.post('/api/v1/session', async (req, reply) => {
    const entraToken = bearerOf(req)
    if (!entraToken) {
      deps.audit.append({ action: 'session.denied', outcome: 'denied', actor: null, details: { reason: 'missing' } })
      throw new HubHttpError(401, 'unauthenticated', 'Sign in with Microsoft')
    }
    let identity
    try {
      identity = await deps.verifier.verify(entraToken)
    } catch (err) {
      const reason = err instanceof AuthError ? err.reason : 'jwks'
      deps.audit.append({ action: 'session.denied', outcome: 'denied', actor: null, details: { reason } })
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
