import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PlaybookPreview, PreflightRequest, ReleaseConfirm, ReleaseDetail, ReleaseSummary, RunEvent } from '../../../src/shared/deploy'
import type { makeAuth } from '../auth/plugin'
import type { HubReleases } from '../releases/service'

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const
const confirmBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    typedName: { type: 'string', maxLength: 200 },
    redeploy: { type: 'boolean' },
    playbookSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const

export function registerReleases(app: FastifyInstance, deps: { releases: HubReleases; auth: ReturnType<typeof makeAuth> }): void {
  const { releases, auth } = deps
  const onRequest = auth.requireUser
  const done = (reply: FastifyReply): FastifyReply => reply.code(204)

  app.post<{ Body: PreflightRequest }>(
    '/api/v1/releases/preflight',
    {
      onRequest,
      schema: {
        body: {
          type: 'object',
          required: ['environmentId', 'serviceIds', 'bump', 'options'],
          additionalProperties: false,
          properties: {
            environmentId: { type: 'string', pattern: UUID },
            serviceIds: { type: 'array', maxItems: 500, items: { type: 'string', pattern: UUID } },
            checkoutIds: { type: 'array', maxItems: 500, items: { type: 'string', pattern: UUID } },
            bump: { enum: ['major', 'minor', 'patch', 'none'] },
            options: {
              type: 'object',
              required: ['backup', 'notify'],
              additionalProperties: false,
              properties: { backup: { type: 'boolean' }, notify: { type: 'boolean' }, qa: { type: 'boolean' } },
            },
            releaseNotes: { type: 'string', maxLength: 20_000 },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(await releases.preflight(req.user, req.body)),
  )

  app.post<{ Params: { id: string }; Body: ReleaseConfirm | null }>(
    '/api/v1/releases/:id/start',
    { onRequest, schema: { params: idParams, body: confirmBody } },
    async (req, reply) => {
      await releases.start(req.user, req.params.id, req.body ?? {})
      return done(reply).send()
    },
  )

  app.post<{ Params: { id: string } }>('/api/v1/releases/:id/cancel', { onRequest, schema: { params: idParams } }, async (req, reply) => {
    await releases.cancel(req.user, req.params.id)
    return done(reply).send()
  })

  app.post<{ Params: { id: string }; Body: ReleaseConfirm | null }>(
    '/api/v1/releases/:id/rollback',
    { onRequest, schema: { params: idParams, body: confirmBody } },
    async (req, reply) => reply.code(201).send(await releases.rollback(req.user, req.params.id, req.body ?? {})),
  )

  app.post<{ Params: { id: string }; Body: { hostId: string; typedLabel: string } }>(
    '/api/v1/releases/:id/break-lock',
    {
      onRequest,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['hostId', 'typedLabel'],
          additionalProperties: false,
          properties: { hostId: { type: 'string', pattern: UUID }, typedLabel: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      await releases.breakLock(req.user, req.params.id, req.body.hostId, req.body.typedLabel)
      return done(reply).send()
    },
  )

  app.post<{ Params: { id: string } }>('/api/v1/releases/:id/discard', { onRequest, schema: { params: idParams } }, async (req, reply) => {
    await releases.discard(req.user, req.params.id)
    return done(reply).send()
  })

  app.post<{ Params: { id: string } }>('/api/v1/releases/:id/retry-version', { onRequest, schema: { params: idParams } }, async (req, reply) => {
    await releases.retryVersion(req.user, req.params.id)
    return done(reply).send()
  })

  app.get<{ Querystring: { environmentId?: string; limit?: number; before?: string } }>(
    '/api/v1/releases',
    {
      onRequest,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            environmentId: { type: 'string', pattern: UUID },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            before: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req): Promise<ReleaseSummary[]> => releases.list(req.user, req.query),
  )

  app.get('/api/v1/releases/active', { onRequest }, async (req): Promise<ReleaseSummary[]> => releases.active(req.user))

  app.get<{ Params: { id: string } }>('/api/v1/releases/:id', { onRequest, schema: { params: idParams } }, async (req): Promise<ReleaseDetail> =>
    releases.detail(req.user, req.params.id),
  )

  app.get<{ Params: { id: string } }>('/api/v1/releases/:id/playbook', { onRequest, schema: { params: idParams } }, async (req): Promise<PlaybookPreview> =>
    releases.previewPlaybook(req.user, req.params.id),
  )

  app.get<{ Params: { id: string }; Querystring: { afterSeq?: number; limit?: number } }>(
    '/api/v1/releases/:id/events',
    {
      onRequest,
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { afterSeq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } },
        },
      },
    },
    async (req): Promise<RunEvent[]> => releases.events(req.user, req.params.id, req.query.afterSeq ?? 0, req.query.limit ?? 1000),
  )
}
