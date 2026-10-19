import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { HUB_BODY_LIMIT } from '../../src/shared/hub'
import type { HubAudit } from './audit'
import type { HubConfig } from './config'
import type { HubDb } from './db'
import { installErrorHandler } from './errors'
import { registerMeta } from './routes/meta'

export interface HubDeps {
  config: HubConfig
  db: HubDb
  audit: HubAudit
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
  return app
}
