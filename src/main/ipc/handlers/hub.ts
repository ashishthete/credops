import type { AuditInput } from '../../../shared/audit'
import type {
  AccessTarget,
  GrantScope,
  HubAction,
  HubAuditEvent,
  HubDecision,
  HubGroup,
  HubUser,
} from '../../../shared/hub'
import type { Handlers } from '../../../shared/ipc'
import type { HubConnection } from '../../hub/connection'

type HubChannel = Extract<keyof Handlers, `hub:${string}`>

const ADMIN = '/api/v1/admin'

/** Admin calls go through the Hub; each mutation is audited locally as `hub.admin { op, target }` (never the values). */
export function createHubHandlers(deps: {
  conn: Pick<HubConnection, 'client' | 'status' | 'connect' | 'signIn' | 'cancelSignIn' | 'signOut' | 'unlink' | 'me'>
  vault: { assertUnlocked(): void }
  audit: { append(input: AuditInput): unknown }
}): Pick<Handlers, HubChannel> {
  const { conn, vault, audit } = deps
  const record = (op: string, target: string): void => {
    audit.append({ action: 'hub.admin', outcome: 'success', details: { op, target } })
  }
  const mutate = async <T>(ops: (result: T) => [op: string, target: string][], run: () => Promise<T>): Promise<T> => {
    vault.assertUnlocked()
    const result = await run()
    for (const [op, target] of ops(result)) record(op, target)
    return result
  }
  return {
    'hub:status': () => conn.status(),
    'hub:connect': (url) => {
      vault.assertUnlocked()
      return conn.connect(url)
    },
    'hub:signIn': () => {
      vault.assertUnlocked()
      return conn.signIn()
    },
    'hub:cancelSignIn': () => conn.cancelSignIn(),
    'hub:signOut': () => {
      vault.assertUnlocked()
      return conn.signOut()
    },
    'hub:unlink': () => {
      vault.assertUnlocked()
      return conn.unlink()
    },
    'hub:me': () => conn.me(),
    'hub:access': (action: HubAction, target: AccessTarget) =>
      conn.client().get<HubDecision>('/api/v1/access', {
        action,
        environmentId: target.environmentId,
        ...(target.deploymentIds?.length ? { deploymentIds: target.deploymentIds } : {}),
      }),
    'hub:users': () => conn.client().get<HubUser[]>(`${ADMIN}/users`),
    'hub:updateUser': (oid, patch) =>
      mutate(
        () => [
          ...(patch.role !== undefined ? [['user.role', oid] as [string, string]] : []),
          ...(patch.disabled !== undefined ? [[patch.disabled ? 'user.disable' : 'user.enable', oid] as [string, string]] : []),
        ],
        () => conn.client().patch<HubUser>(`${ADMIN}/users/${oid}`, patch),
      ),
    'hub:groups': () => conn.client().get<HubGroup[]>(`${ADMIN}/groups`),
    'hub:createGroup': (input) =>
      mutate((g) => [['group.create', g.id]], () => conn.client().post<HubGroup>(`${ADMIN}/groups`, input)),
    'hub:updateGroup': (id, patch) =>
      mutate(() => [['group.update', id]], () => conn.client().patch<HubGroup>(`${ADMIN}/groups/${id}`, patch)),
    'hub:deleteGroup': (id) => mutate(() => [['group.delete', id]], () => conn.client().del(`${ADMIN}/groups/${id}`)),
    'hub:addMembers': (groupId, oids) =>
      mutate(() => [['member.add', groupId]], () => conn.client().post<HubGroup>(`${ADMIN}/groups/${groupId}/members`, { oids })),
    'hub:removeMember': (groupId, oid) =>
      mutate(
        () => [['member.remove', groupId]],
        async () => {
          await conn.client().del(`${ADMIN}/groups/${groupId}/members/${oid}`)
          const groups = await conn.client().get<HubGroup[]>(`${ADMIN}/groups`)
          return groups.find((g) => g.id === groupId) as HubGroup
        },
      ),
    'hub:addGrant': (groupId, scope: GrantScope) =>
      mutate(
        () => [['grant.add', groupId]],
        async () => {
          await conn.client().post(`${ADMIN}/groups/${groupId}/grants`, { scope })
          const groups = await conn.client().get<HubGroup[]>(`${ADMIN}/groups`)
          return groups.find((g) => g.id === groupId) as HubGroup
        },
      ),
    'hub:removeGrant': (grantId) =>
      mutate(() => [['grant.remove', grantId]], () => conn.client().del(`${ADMIN}/grants/${grantId}`)),
    'hub:audit': (filter) => conn.client().get<HubAuditEvent[]>(`${ADMIN}/audit`, filter as Record<string, string | number | string[]>),
    'hub:verifyAudit': () =>
      mutate(() => [['audit.verify', 'hub']], () => conn.client().post<{ ok: boolean; count: number; brokenAtId?: number }>(`${ADMIN}/audit/verify`)),
  }
}
