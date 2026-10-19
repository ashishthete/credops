import type { FastifyInstance } from 'fastify'
import type { HubAction } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import { decide } from '../access/policy'
import type { makeAuth } from '../auth/plugin'

const ACTIONS: HubAction[] = ['deploy.view', 'deploy.edit', 'release.start', 'release.rollback', 'release.cancel', 'lock.break', 'env.lock', 'admin']

export function registerAccess(app: FastifyInstance, deps: { directory: Directory; auth: ReturnType<typeof makeAuth> }): void {
  app.get<{ Querystring: { action: HubAction; environmentId?: string; deploymentIds?: string[] } }>(
    '/api/v1/access',
    {
      onRequest: deps.auth.requireUser,
      schema: {
        querystring: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { enum: ACTIONS },
            environmentId: { type: 'string', minLength: 1, maxLength: 100 },
            deploymentIds: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
    async (req) => {
      const { action, environmentId } = req.query
      const ids = (req.query.deploymentIds ?? []).flatMap((s) => s.split(',')).filter(Boolean)
      const target = environmentId ? { environmentId, ...(ids.length ? { deploymentIds: ids } : {}) } : undefined
      return decide(req.user, deps.directory.listGroups(), action, target)
    },
  )
}
