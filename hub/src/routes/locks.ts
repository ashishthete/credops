import type { FastifyInstance, FastifyRequest } from 'fastify'
import { FREEZE_MAX_HOURS, MAX_FREEZE_REASON, type HubActor, type HubEnvLock, type HubGroup, type HubUser } from '../../../src/shared/hub'
import type { Directory } from '../access/directory'
import { decide } from '../access/policy'
import type { makeAuth } from '../auth/plugin'
import type { HubAudit } from '../audit'
import { HubHttpError } from '../errors'
import type { EnvLocks } from '../locks'

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const
const actorOf = (req: FastifyRequest): HubActor => ({ oid: req.user.oid, upn: req.user.upn, name: req.user.name, role: req.user.role })

export function registerLocks(
  app: FastifyInstance,
  deps: {
    locks: EnvLocks
    directory: Pick<Directory, 'listGroups'>
    audit: Pick<HubAudit, 'append'>
    auth: ReturnType<typeof makeAuth>
    /** The caller's copy of a lock; a deployment-scoped member does not learn the id of a release they cannot view. */
    view?: (user: HubUser, groups: HubGroup[], lock: HubEnvLock) => HubEnvLock | null
  },
): void {
  const { locks, directory, audit, auth } = deps
  const view = deps.view ?? ((_user: HubUser, _groups: HubGroup[], lock: HubEnvLock) => lock)

  app.get('/api/v1/locks', { onRequest: auth.requireUser }, async (req): Promise<HubEnvLock[]> => {
    const groups = directory.listGroups()
    return locks
      .list()
      .filter((l) => decide(req.user, groups, 'deploy.view', { environmentId: l.environmentId }).allowed)
      .flatMap((l) => view(req.user, groups, l) ?? [])
  })

  app.post<{ Params: { id: string }; Body: { reason: string; hours?: number } }>(
    '/api/v1/environments/:id/freeze',
    {
      onRequest: auth.requireUser,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: MAX_FREEZE_REASON, pattern: '\\S' },
            hours: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
        },
      },
    },
    async (req) => {
      const d = decide(req.user, directory.listGroups(), 'env.lock', { environmentId: req.params.id })
      if (!d.allowed) throw new HubHttpError(403, 'forbidden', d.reason)
      const lock = locks.freeze(req.params.id, { oid: req.user.oid, name: req.user.name }, req.body)
      audit.append({
        action: 'lock.freeze',
        outcome: 'success',
        actor: actorOf(req),
        targetType: 'environment',
        targetId: req.params.id,
        details: { environmentId: req.params.id, reason: lock.reason, expiresAt: lock.expiresAt, hours: Math.min(FREEZE_MAX_HOURS, Math.max(1, req.body.hours ?? 4)) },
      })
      return lock
    },
  )

  app.delete<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/environments/:id/freeze',
    {
      onRequest: auth.requireUser,
      schema: {
        params: idParams,
      },
    },
    async (req, reply) => {
      const environmentId = req.params.id
      // Whether an environment exists, is frozen, or who froze it is for its holder, admins and people who can view it.
      if (req.user.role !== 'admin' && locks.get(environmentId)?.holder.oid !== req.user.oid) {
        const d = decide(req.user, directory.listGroups(), 'deploy.view', { environmentId })
        if (!d.allowed) {
          // Same uniform refusal for every id, and recorded; nothing about the environment was read.
          audit.append({
            action: 'access.denied',
            outcome: 'denied',
            actor: actorOf(req),
            targetType: 'environment',
            targetId: environmentId,
            details: { attempted: 'lock.unfreeze', code: 'forbidden', environmentId },
          })
          throw new HubHttpError(403, 'forbidden', d.reason)
        }
      }
      const typed = (req.body as { typedName?: unknown } | null | undefined)?.typedName
      if (typed !== undefined && (typeof typed !== 'string' || typed.length > 200)) throw new HubHttpError(400, 'bad_request', 'typedName must be a string')
      try {
        const { lock, broke } = locks.unfreeze(environmentId, { oid: req.user.oid, role: req.user.role }, { typedName: typed })
        audit.append({
          action: broke ? 'lock.break' : 'lock.unfreeze',
          outcome: 'success',
          actor: actorOf(req),
          targetType: 'environment',
          targetId: environmentId,
          details: { environmentId, holder: lock.holder.oid },
        })
      } catch (err) {
        // A refused lift is audited, and it happens before anything changes.
        if (err instanceof HubHttpError && (err.code === 'forbidden' || err.code === 'confirm_required')) {
          audit.append({
            action: 'access.denied',
            outcome: 'denied',
            actor: actorOf(req),
            targetType: 'environment',
            targetId: environmentId,
            details: { attempted: 'lock.unfreeze', code: err.code, environmentId },
          })
        }
        throw err
      }
      return reply.code(204).send()
    },
  )
}
