import type { HostMeta, RegionMeta, RegionRef } from '../../../shared/inventory'
import { environmentRegions, hostRegions, regionHint, regionRefs } from '../../../shared/regions'
import type { DeploymentMeta } from '../../../shared/deploy'
import type { ServiceMeta } from '../../../shared/services'
import type { InventoryData } from './store'

// Renderer lookups over the inventory store for showing derived regions. The rules live in shared/regions.ts.

/** A region by id; undefined for an id not in the list. */
export const regionById = (regions: readonly RegionMeta[], id: string | null): RegionMeta | undefined =>
  id === null ? undefined : regions.find((r) => r.id === id)

/** A host's region, for its chip. */
export const regionOfHost = (data: Pick<InventoryData, 'hosts' | 'regions'>, hostId: string | null): RegionMeta | undefined =>
  regionById(data.regions, data.hosts.find((h) => h.id === hostId)?.regionId ?? null)

/**
 * An environment's derived regions, ordered by code. Per-row region chips show only when this has more than one
 * entry, so single-region environments stay uncluttered.
 */
export function regionsOfEnvironment(
  data: Pick<InventoryData, 'hosts' | 'regions' | 'environments'>,
  envId: string,
  checkouts: readonly Pick<DeploymentMeta, 'environmentId' | 'hostId'>[] = [],
  services: readonly ServiceMeta[] = [],
): RegionRef[] {
  const env = data.environments.find((e) => e.id === envId)
  if (!env) return []
  return regionRefs(environmentRegions(hostRegions(data.hosts), env, checkouts, services), data.regions)
}

/**
 * Hosts grouped by region for pickers (`<optgroup>` per region), regions ordered by code and hosts by label. Every
 * host picker uses this so they all read the same way.
 */
export function hostsByRegion<H extends { label: string; regionId: string }>(
  regions: readonly RegionMeta[],
  hosts: readonly H[],
): { region: RegionMeta | undefined; hosts: H[] }[] {
  const groups = new Map<string, H[]>()
  for (const h of hosts) groups.set(h.regionId, [...(groups.get(h.regionId) ?? []), h])
  return [...groups.entries()]
    .map(([id, hs]) => ({ region: regionById(regions, id), hosts: [...hs].sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => (a.region?.code ?? '').localeCompare(b.region?.code ?? ''))
}

const listed = (codes: string[]) => (codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} and ${codes.at(-1)}`)

/**
 * The soft hint for `host` joining an environment, in words: "prod's hosts are all in eu-west-1; app-us-1 is in
 * us-east-1." Null when the host's region is already one of the environment's, or the environment has no hosts yet.
 * The host itself doesn't count as a member, so this reads the same before and after it joins.
 */
export function regionHintText(
  data: Pick<InventoryData, 'hosts' | 'regions' | 'environments'>,
  envId: string,
  host: Pick<HostMeta, 'id' | 'label' | 'regionId'>,
  checkouts: readonly Pick<DeploymentMeta, 'environmentId' | 'hostId'>[] = [],
  services: readonly ServiceMeta[] = [],
): string | null {
  const env = data.environments.find((e) => e.id === envId)
  if (!env) return null
  const without = { ...env, hosts: env.hosts.filter((m) => m.hostId !== host.id) }
  const envRegions = regionRefs(environmentRegions(hostRegions(data.hosts), without, checkouts, services), data.regions)
  if (!regionHint(envRegions.map((r) => r.id), host.regionId)) return null
  const codes = envRegions.map((r) => r.code)
  const own = regionById(data.regions, host.regionId)?.code ?? 'another region'
  return `${env.name}'s hosts are ${codes.length === 1 ? 'all ' : ''}in ${listed(codes)}; ${host.label} is in ${own}.`
}
