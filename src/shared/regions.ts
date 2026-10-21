import type { DeploymentMeta } from './deploy'
import type { EnvironmentMeta, HostMeta, RegionRef } from './inventory'
import type { ServiceMeta } from './services'

// Derived regions: only a host stores one. Everything else is worked out here from the hosts it runs on, so a
// host moving region moves everything on it. Shared by the renderer's views and main's deploy confirm.

/** Host id -> region id. */
export type HostRegions = ReadonlyMap<string, string>

export const hostRegions = (hosts: readonly Pick<HostMeta, 'id' | 'regionId'>[]): HostRegions =>
  new Map(hosts.map((h) => [h.id, h.regionId]))

/** A host's region; null for a host that isn't in the list. */
export const hostRegion = (regions: HostRegions, hostId: string | null): string | null =>
  hostId === null ? null : (regions.get(hostId) ?? null)

/** A checkout's region is its host's. */
export const checkoutRegion = (regions: HostRegions, checkout: Pick<DeploymentMeta, 'hostId'>): string | null =>
  hostRegion(regions, checkout.hostId)

/**
 * An app service's region is its checkout host's; a db service's is its via-host's. None when the service has no
 * checkout or via-host.
 */
export function serviceRegion(
  regions: HostRegions,
  service: ServiceMeta,
  checkouts: readonly Pick<DeploymentMeta, 'id' | 'hostId'>[],
): string | null {
  if (service.kind === 'db') return hostRegion(regions, service.viaHostId)
  const checkout = service.deploymentId === null ? undefined : checkouts.find((c) => c.id === service.deploymentId)
  return checkout ? checkoutRegion(regions, checkout) : null
}

/**
 * The distinct regions of an environment's member hosts, checkout hosts and db via-hosts. `checkouts` and
 * `services` may hold other environments' too: only this one's count.
 */
export function environmentRegions(
  regions: HostRegions,
  env: Pick<EnvironmentMeta, 'id' | 'hosts'>,
  checkouts: readonly Pick<DeploymentMeta, 'environmentId' | 'hostId'>[],
  services: readonly ServiceMeta[],
): string[] {
  const hostIds = [
    ...env.hosts.map((m) => m.hostId),
    ...checkouts.filter((c) => c.environmentId === env.id).map((c) => c.hostId),
    ...services.filter((s) => s.environmentId === env.id && s.kind === 'db').map((s) => (s.kind === 'db' ? s.viaHostId : null)),
  ]
  return distinct(hostIds.map((h) => hostRegion(regions, h)))
}

/** The distinct regions of the hosts given, e.g. those a deploy's checkouts run on. */
export const regionsOfHosts = (regions: HostRegions, hostIds: readonly (string | null)[]): string[] =>
  distinct(hostIds.map((h) => hostRegion(regions, h)))

/** Region ids as refs, ordered by code; ids with no region in the list are left out. */
export function regionRefs(ids: readonly string[], all: readonly RegionRef[]): RegionRef[] {
  const byId = new Map(all.map((r) => [r.id, r]))
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is RegionRef => r !== undefined)
    .map(({ id, code, displayName }) => ({ id, code, displayName }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

const distinct = (ids: (string | null)[]): string[] => [...new Set(ids.filter((id): id is string => id !== null))]
