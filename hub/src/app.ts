import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { HUB_BODY_LIMIT } from '../../src/shared/hub'
import { Directory } from './access/directory'
import type { EntraVerifier } from './auth/entra'
import { SessionStore } from './auth/sessions'
import type { HubAudit } from './audit'
import type { HubConfig } from './config'
import type { HubDb } from './db'
import { installErrorHandler } from './errors'
import { makeAuth } from './auth/plugin'
import { registerAccess } from './routes/access'
import { registerAdmin } from './routes/admin'
import { Registry } from './registry'
import { registerRegistry } from './routes/registry'
import { registerMeta } from './routes/meta'
import { registerSession } from './routes/session'

export interface HubDeps {
  config: HubConfig
  db: HubDb
  audit: HubAudit
  verifier: Pick<EntraVerifier, 'verify'>
  now: () => Date
  ids: () => string
  /** pino destination; defaults to stdout */
  log?: { write(msg: string): void }
}

export function buildApp(deps: HubDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: HUB_BODY_LIMIT,
    ...(deps.config.tls
      ? { https: { cert: readFileSync(deps.config.tls.certFile), key: readFileSync(deps.config.tls.keyFile) } }
      : {}),
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req: (req: { method: string; url: string; socket?: { remoteAddress?: string } }) => ({
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.socket?.remoteAddress,
        }),
      },
      ...(deps.log ? { stream: deps.log } : {}),
    },
  })
  installErrorHandler(app, () => [])
  app.addHook('onClose', async () => {
    deps.audit.append({ action: 'hub.stop', outcome: 'info', actor: null })
  })
  registerMeta(app, deps)
  const sessions = new SessionStore(deps.db, { now: deps.now, ttlHours: deps.config.sessionTtlHours })
  const directory = new Directory(deps.db, { firstAdmin: deps.config.firstAdmin, now: deps.now, ids: deps.ids, audit: deps.audit, sessions })
  const auth = makeAuth({ sessions, directory, now: deps.now })
  registerSession(app, { audit: deps.audit, verifier: deps.verifier, sessions, directory, now: deps.now }, auth)
  registerAdmin(app, { directory, audit: deps.audit, auth })
  registerAccess(app, { directory, auth })
  const registry = new Registry(deps.db, { audit: deps.audit, directory, now: deps.now })
  registerRegistry(app, { registry, directory, auth })
  return app
}
