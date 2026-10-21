import type { RegionMeta, RegionRef } from '../../../shared/inventory'
import { environmentRegions, hostRegions, regionRefs } from '../../../shared/regions'
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
