import type { EnvironmentMeta } from '../../../shared/inventory'
import type { SessionMeta } from '../../../shared/ssh'

/**
 * The protected environment an ssh session's host belongs to: the session's own environment when it is
 * protected, else any protected environment that holds the host. A local shell has none.
 */
export function protectedEnvironment(
  meta: Pick<SessionMeta, 'kind' | 'hostId' | 'environmentId'>,
  environments: readonly EnvironmentMeta[],
): EnvironmentMeta | undefined {
  if (meta.kind !== 'ssh' || !meta.hostId) return undefined
  const own = environments.find((e) => e.id === meta.environmentId)
  if (own?.protected) return own
  return environments.find((e) => e.protected && e.hosts.some((m) => m.hostId === meta.hostId))
}
