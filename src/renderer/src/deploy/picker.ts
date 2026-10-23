import type { DeploymentMeta } from '../../../shared/deploy'
import { listNames, type AppServiceMeta, type ServiceMeta } from '../../../shared/services'

export interface PickerGroup {
  checkout: DeploymentMeta
  services: AppServiceMeta[]
  selected: Set<string>
  /** Every service ticked, or a checkout with no services ticked as one row. */
  whole: boolean
  /** Some services ticked, not all. */
  partial: boolean
}

/** The environment's app services under their checkouts, in checkout order; dbs are never deployed. */
export function pickerGroups(
  services: ServiceMeta[],
  deployments: DeploymentMeta[],
  selected: Set<string>,
  wholeCheckouts: Set<string>,
): { groups: PickerGroup[]; unavailable: AppServiceMeta[] } {
  const apps = services.filter((s): s is AppServiceMeta => s.kind === 'service').sort((a, b) => a.position - b.position)
  const byId = new Map(deployments.map((d) => [d.id, d]))
  const unavailable = apps.filter((s) => s.deploymentId === null || !byId.has(s.deploymentId))
  const groups = [...deployments]
    .sort((a, b) => a.position - b.position)
    .map((checkout) => {
      const mine = apps.filter((s) => s.deploymentId === checkout.id)
      const ticked = new Set(mine.filter((s) => selected.has(s.id)).map((s) => s.id))
      const whole = mine.length ? ticked.size === mine.length : wholeCheckouts.has(checkout.id)
      return { checkout, services: mine, selected: ticked, whole, partial: ticked.size > 0 && ticked.size < mine.length }
    })
  return { groups, unavailable }
}

/**
 * What a partial selection does to the rest of the checkout. `composeServices` is the compose file's services
 * once preflight has read them (null before, or when unknown); `databases` are the ones it classed as databases.
 */
export function checkoutNotice(g: PickerGroup, composeServices: string[] | null, databases: string[] = []): string[] {
  if (!g.partial) return []
  const picked = g.services.filter((s) => g.selected.has(s.id)).map((s) => s.name)
  const rest = g.services.filter((s) => !g.selected.has(s.id)).map((s) => s.name)
  const lines = [`Updates code for ${g.checkout.name} to ${g.checkout.defaultBranch}. Only ${listNames(picked)} ${picked.length === 1 ? 'is' : 'are'} rebuilt and restarted.`]
  lines.push(
    rest.length === 1
      ? `${rest[0]} keeps running its current image; it will pick up the new code the next time it is deployed or restarted.`
      : `${listNames(rest)} keep running their current images; they will pick up the new code the next time they are deployed or restarted.`,
  )
  if (composeServices === null) lines.push('Other compose services in this checkout are not restarted.')
  else {
    const tracked = new Set([...g.services.map((s) => s.composeService), ...databases])
    const untracked = [...new Set(composeServices)].filter((c) => !tracked.has(c))
    if (untracked.length) lines.push(`Compose services CredOps doesn't track (${listNames(untracked)}) are not restarted.`)
  }
  if (g.checkout.managedEnv) lines.push('The managed .env is rewritten for the whole checkout.')
  return lines
}

/** The preflight request's selection: the ticked services, and each service-less checkout ticked whole. */
export function selectionRequest(groups: PickerGroup[]): { serviceIds: string[]; checkoutIds: string[] } {
  return {
    serviceIds: groups.flatMap((g) => g.services.filter((s) => g.selected.has(s.id)).map((s) => s.id)),
    checkoutIds: groups.filter((g) => !g.services.length && g.whole).map((g) => g.checkout.id),
  }
}
