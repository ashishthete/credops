import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { HubActor } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import { decide } from '../access/policy'
import type { makeAuth } from '../auth/plugin'
import { HubHttpError } from '../errors'
import type { Registry } from '../registry'

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const

const actorOf = (req: FastifyRequest): HubActor => ({ oid: req.user.oid, upn: req.user.upn, name: req.user.name, role: req.user.role })

export function registerRegistry(
  app: FastifyInstance,
  deps: { registry: Registry; directory: Directory; auth: ReturnType<typeof makeAuth> },
): void {
  const { registry, directory, auth } = deps

  // Every publish action goes through the policy, so the rule lives in one place.
  const mayEdit = async (req: FastifyRequest): Promise<void> => {
    await auth.requireUser(req)
    const d = decide(req.user, directory.listGroups(), 'deploy.edit')
    if (!d.allowed) throw new HubHttpError(403, 'forbidden', d.reason)
  }
  const guard = { onRequest: mayEdit }

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/admin/environments/:id',
    { ...guard, schema: { params: idParams, body: { type: 'object' } } },
    async (req) => {
      const env = (req.body as { environment?: { id?: unknown } }).environment
      if (!env || env.id !== req.params.id) throw new HubHttpError(400, 'bad_request', 'invalid request: /environment/id must match the path')
      return registry.publish(req.body, actorOf(req))
    },
  )

  app.delete<{ Params: { id: string } }>('/api/v1/admin/environments/:id', { ...guard, schema: { params: idParams } }, async (req, reply) => {
    registry.unpublish(req.params.id, actorOf(req))
    return reply.code(204).send()
  })

  app.get('/api/v1/admin/environments', guard, async () => registry.list())
  app.get<{ Params: { id: string } }>('/api/v1/admin/environments/:id', { ...guard, schema: { params: idParams } }, async (req) =>
    registry.get(req.params.id),
  )

  app.get('/api/v1/catalog', { onRequest: auth.requireUser }, async (req) => registry.catalogFor(req.user))
}
