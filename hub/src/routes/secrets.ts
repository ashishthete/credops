import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HUB_SECRET_KINDS, MAX_SECRET_NAME, type HubActor, type HubSecretKind, type HubSecretList } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import { decide } from '../access/policy'
import type { makeAuth } from '../auth/plugin'
import type { HubAudit } from '../audit'
import { HubHttpError } from '../errors'
import type { EnvLocks } from '../locks'
import type { Registry } from '../registry'
import type { DeployKeys } from '../secrets/deploykeys'
import type { SecretStore } from '../secrets/store'

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const
// A name is text a person reads: no control characters.
const NAME = '^[^\\u0000-\\u001f\\u007f]+$'

const FORBIDDEN_KEYS = new Set(['value', 'privateKey', 'private_enc', 'privateEnc', 'value_enc', 'valueEnc'])

/** Belt and braces: no response from these routes may carry a secret-shaped key, however it got there. */
export function assertNoSecretKeys(payload: unknown, depth = 0): void {
  if (payload === null || typeof payload !== 'object') return
  if (depth > 8) throw new Error('response too deep to check')
  if (Array.isArray(payload)) {
    for (const item of payload) assertNoSecretKeys(item, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(payload)) {
    if (FORBIDDEN_KEYS.has(k)) throw new Error('refusing to send a secret-shaped field')
    assertNoSecretKeys(v, depth + 1)
  }
}

const actorOf = (req: FastifyRequest): HubActor => ({ oid: req.user.oid, upn: req.user.upn, name: req.user.name, role: req.user.role })

export function registerSecrets(
  app: FastifyInstance,
  deps: {
    secrets: SecretStore
    deployKeys: DeployKeys
    registry: Pick<Registry, 'required' | 'exists' | 'nameOf'>
    locks: Pick<EnvLocks, 'get'>
    directory: Pick<Directory, 'listGroups'>
    audit: Pick<HubAudit, 'append'>
    auth: ReturnType<typeof makeAuth>
  },
): void {
  const { secrets, deployKeys, registry, locks, directory, audit, auth } = deps

  /** Changing an environment's secrets or deploy key while a release runs on it would change what that release uses. */
  const assertNotReleasing = (environmentId: string | null): void => {
    if (environmentId !== null && locks.get(environmentId)?.kind === 'release') {
      throw new HubHttpError(409, 'env_locked', `A release is running on ${registry.nameOf(environmentId) ?? 'this environment'}`)
    }
  }

  const mayAdmin = async (req: FastifyRequest): Promise<void> => {
    await auth.requireUser(req)
    const d = decide(req.user, directory.listGroups(), 'admin')
    if (!d.allowed) throw new HubHttpError(403, 'forbidden', d.reason)
  }

  // Encapsulated so the serialization guard covers exactly these routes.
  void app.register(async (scope) => {
    scope.addHook('onRequest', mayAdmin)
    scope.addHook('preSerialization', async (_req, _reply, payload) => {
      assertNoSecretKeys(payload)
      return payload
    })

    scope.get<{ Querystring: { environmentId?: string } }>(
      '/api/v1/admin/secrets',
      { schema: { querystring: { type: 'object', properties: { environmentId: { type: 'string', pattern: UUID } }, additionalProperties: false } } },
      async (req): Promise<HubSecretList> => {
        const environmentId = req.query.environmentId
        const missing: HubSecretList['missing'] = {}
        for (const m of registry.required(environmentId)) (missing[m.environmentId] ??= []).push({ secretId: m.secretId, name: m.name })
        return { secrets: secrets.meta(environmentId), missing }
      },
    )

    scope.put<{ Params: { id: string }; Body: { environmentId: string | null; name: string; kind: HubSecretKind; value: unknown } }>(
      '/api/v1/admin/secrets/:id',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            required: ['environmentId', 'name', 'kind', 'value'],
            additionalProperties: false,
            properties: {
              environmentId: { anyOf: [{ type: 'string', pattern: UUID }, { type: 'null' }] },
              name: { type: 'string', minLength: 1, maxLength: MAX_SECRET_NAME, pattern: NAME },
              kind: { type: 'string', enum: [...HUB_SECRET_KINDS] },
              // The byte limit is checked by the store, which never echoes the value.
              value: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      async (req, reply) => {
        const b = req.body
        assertNotReleasing(b.environmentId)
        secrets.set({ id: req.params.id, environmentId: b.environmentId, name: b.name, kind: b.kind, value: b.value as string }, actorOf(req))
        return reply.code(204).send()
      },
    )

    scope.delete<{ Params: { id: string }; Querystring: { environmentId?: string } }>(
      '/api/v1/admin/secrets/:id',
      { schema: { params: idParams, querystring: { type: 'object', properties: { environmentId: { type: 'string', pattern: UUID } }, additionalProperties: false } } },
      async (req, reply) => {
      const environmentId = req.query.environmentId ?? null
      assertNotReleasing(environmentId)
      secrets.delete(req.params.id, environmentId, actorOf(req))
      return reply.code(204).send()
      },
    )

    scope.post<{ Params: { id: string } }>('/api/v1/admin/environments/:id/deploy-key', { schema: { params: idParams } }, async (req) => {
      const name = registry.nameOf(req.params.id)
      if (name === null) throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
      assertNotReleasing(req.params.id)
      const rotated = deployKeys.has(req.params.id)
      const key = deployKeys.create(req.params.id, name)
      audit.append({
        action: 'deploykey.create',
        outcome: 'success',
        actor: actorOf(req),
        targetType: 'environment',
        targetId: req.params.id,
        targetLabel: name,
        details: { name, environmentId: req.params.id, rotated },
      })
      return key
    })

    scope.get<{ Params: { id: string } }>('/api/v1/admin/environments/:id/deploy-key', { schema: { params: idParams } }, async (req) => {
      const key = deployKeys.publicKey(req.params.id)
      if (!key) throw new HubHttpError(404, 'not_found', 'This environment has no deploy key yet')
      return key
    })
  })
}
