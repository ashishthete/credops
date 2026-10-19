import type { FastifyReply, FastifyRequest } from 'fastify'
import type { HubUser } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import { HubHttpError } from '../errors'
import { SESSION_TOKEN_RE, type SessionStore } from './sessions'

declare module 'fastify' {
  interface FastifyRequest {
    user: HubUser
    /** The Hub session token of an authenticated request; never logged. */
    sessionToken: string
  }
}

const TOUCH_EVERY_MS = 60_000

export function bearerOf(req: FastifyRequest): string | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  return m ? m[1] : null
}

export interface AuthDeps {
  sessions: SessionStore
  directory: Directory
  now: () => Date
}

export function makeAuth(deps: AuthDeps) {
  const requireUser = async (req: FastifyRequest, _reply?: FastifyReply): Promise<void> => {
    const token = bearerOf(req)
    if (!token || !SESSION_TOKEN_RE.test(token)) {
      throw new HubHttpError(401, 'unauthenticated', 'Sign in to the Hub')
    }
    const session = deps.sessions.resolve(token)
    if (!session) throw new HubHttpError(401, 'session_expired', 'Your Hub session has ended')
    const user = deps.directory.get(session.oid)
    if (!user) throw new HubHttpError(401, 'session_expired', 'Your Hub session has ended')
    if (user.status === 'disabled') throw new HubHttpError(403, 'forbidden', 'Your Hub account is disabled')
    const last = user.lastSeenAt ? Date.parse(user.lastSeenAt) : 0
    if (deps.now().getTime() - last >= TOUCH_EVERY_MS) {
      deps.directory.touch(user.oid)
    }
    req.user = user
    req.sessionToken = token
  }
  const requireAdmin = async (req: FastifyRequest, reply?: FastifyReply): Promise<void> => {
    await requireUser(req, reply)
    if (req.user.role !== 'admin') throw new HubHttpError(403, 'forbidden', 'Admins only')
  }
  return { requireUser, requireAdmin }
}
