import type { FastifyInstance } from 'fastify'
import { GROUP_NAME, HUB_AUDIT_ACTIONS, MAX_BULK_MEMBERS, MAX_GROUP_DESCRIPTION, type GrantScope, type HubAuditFilter, type HubRole } from '../../../src/shared/hub'
import { HubHttpError } from '../errors'
import type { Directory } from '../access/directory'
import type { HubAudit } from '../audit'
import type { makeAuth } from '../auth/plugin'

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const uuid = { type: 'string', pattern: UUID } as const
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const

export function registerAdmin(
  app: FastifyInstance,
  deps: { directory: Directory; audit: HubAudit; auth: ReturnType<typeof makeAuth> },
): void {
  const { directory, audit } = deps
  // onRequest, so authorization runs before body parsing and validation.
  const guard = { onRequest: deps.auth.requireAdmin }
  const actorOf = (req: { user: { oid: string; upn: string; name: string; role: HubRole } }) => ({
    oid: req.user.oid,
    upn: req.user.upn,
    name: req.user.name,
    role: req.user.role,
  })

  app.get('/api/v1/admin/users', guard, async () => directory.list())

  app.patch<{ Params: { oid: string }; Body: { role?: HubRole; disabled?: boolean } }>(
    '/api/v1/admin/users/:oid',
    {
      ...guard,
      schema: {
        params: { type: 'object', required: ['oid'], properties: { oid: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { role: { enum: ['admin', 'maintainer'] }, disabled: { type: 'boolean' } },
        },
      },
    },
    async (req) => directory.updateUser(actorOf(req), req.params.oid, req.body),
  )

  app.get('/api/v1/admin/groups', guard, async () => directory.listGroups())

  app.post<{ Body: { name: string; description?: string } }>(
    '/api/v1/admin/groups',
    {
      ...guard,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', pattern: GROUP_NAME.source },
            description: { type: 'string', maxLength: MAX_GROUP_DESCRIPTION },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(directory.createGroup(actorOf(req), req.body)),
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/api/v1/admin/groups/:id',
    {
      ...guard,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', pattern: GROUP_NAME.source },
            description: { type: 'string', maxLength: MAX_GROUP_DESCRIPTION },
          },
        },
      },
    },
    async (req) => directory.updateGroup(actorOf(req), req.params.id, req.body),
  )

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/groups/:id',
    { ...guard, schema: { params: idParams } },
    async (req, reply) => {
      directory.deleteGroup(actorOf(req), req.params.id)
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { id: string }; Body: { oids: string[] } }>(
    '/api/v1/admin/groups/:id/members',
    {
      ...guard,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['oids'],
          additionalProperties: false,
          properties: { oids: { type: 'array', minItems: 1, maxItems: MAX_BULK_MEMBERS, items: uuid } },
        },
      },
    },
    async (req) => directory.addMembers(actorOf(req), req.params.id, req.body.oids),
  )

  app.delete<{ Params: { id: string; oid: string } }>(
    '/api/v1/admin/groups/:id/members/:oid',
    {
      ...guard,
      schema: { params: { type: 'object', required: ['id', 'oid'], properties: { id: uuid, oid: uuid } } },
    },
    async (req, reply) => {
      directory.removeMember(actorOf(req), req.params.id, req.params.oid)
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { id: string }; Body: { scope: GrantScope } }>(
    '/api/v1/admin/groups/:id/grants',
    {
      ...guard,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['scope'],
          additionalProperties: false,
          properties: {
            scope: {
              type: 'object',
              required: ['kind'],
              additionalProperties: false,
              properties: {
                kind: { enum: ['all', 'environment', 'deployment'] },
                environmentId: uuid,
                deploymentId: uuid,
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const sc = req.body.scope as { kind: string; environmentId?: string; deploymentId?: string }
      const shapeOk =
        sc.kind === 'all'
          ? !sc.environmentId && !sc.deploymentId
          : sc.kind === 'environment'
            ? !!sc.environmentId && !sc.deploymentId
            : !!sc.environmentId && !!sc.deploymentId
      if (!shapeOk) throw new HubHttpError(400, 'bad_request', 'invalid request: /scope shape')
      return reply.code(201).send(directory.addGrant(actorOf(req), req.params.id, req.body.scope))
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/grants/:id',
    { ...guard, schema: { params: idParams } },
    async (req, reply) => {
      directory.removeGrant(actorOf(req), req.params.id)
      return reply.code(204).send()
    },
  )

  app.get<{ Querystring: HubAuditFilter }>(
    '/api/v1/admin/audit',
    {
      ...guard,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            actions: { type: 'array', items: { enum: [...HUB_AUDIT_ACTIONS] } },
            actorOid: { type: 'string', maxLength: 100 },
            outcome: { enum: ['success', 'failure', 'denied', 'info'] },
            from: { type: 'string', maxLength: 40 },
            to: { type: 'string', maxLength: 40 },
            beforeId: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => audit.list(req.query),
  )

  app.post('/api/v1/admin/audit/verify', guard, async (req) => {
    const result = audit.verify()
    audit.append({
      action: 'audit.verify',
      outcome: result.ok ? 'success' : 'failure',
      actor: actorOf(req),
      details: { ok: result.ok, count: result.count },
    })
    return result
  })
}
