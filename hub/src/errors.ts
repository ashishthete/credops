import type { FastifyError, FastifyInstance } from 'fastify'
import type { HubErrorBody, HubErrorCode } from '../../src/shared/hub'
import { redact } from '../../src/main/security/redact'

export class HubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HubHttpError'
  }
}

const NOT_FOUND = 'Not found'

export function installErrorHandler(app: FastifyInstance, knownSecrets: () => readonly string[]): void {
  const body = (error: HubErrorCode, message: string): HubErrorBody => ({
    error,
    message: redact(message, knownSecrets()),
  })

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(body('not_found', NOT_FOUND))
  })

  app.setErrorHandler((err: FastifyError | HubHttpError, req, reply) => {
    if (err instanceof HubHttpError) {
      return reply.code(err.status).send(body(err.code, err.message))
    }
    const fe = err as FastifyError
    if (fe.validation && fe.validation.length > 0) {
      const v = fe.validation[0]
      return reply.code(400).send(body('bad_request', `invalid request: ${v.instancePath || '/'} ${v.keyword}`))
    }
    if (fe.statusCode === 413) {
      return reply.code(413).send(body('bad_request', 'Request body too large'))
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send(body('bad_request', 'Bad request'))
    }
    req.log.error({ err: { name: err.name, message: redact(err.message, knownSecrets()) } }, 'internal error')
    return reply.code(500).send(body('internal', 'Internal error'))
  })
}
