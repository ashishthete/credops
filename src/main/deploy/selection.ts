import type { DeploymentMeta, HealthUrl, RunService } from '../../shared/deploy'
import type { AppServiceMeta, ServiceMeta } from '../../shared/services'
import { DeployError } from './access'
import type { PlanDeployment } from './runner'

/* Which checkouts a service selection touches, and in which form: whole (every tracked service, plain
   build and up) or partial (the selected compose services, up with --no-deps). */

export interface SelectionGroup {
  deployment: DeploymentMeta
  /** In position order. Empty for a checkout with no services, chosen by `checkoutIds`. */
  selected: AppServiceMeta[]
  /** Every app service of the checkout, in position order. */
  tracked: AppServiceMeta[]
  whole: boolean
}

/** What a run stores about its services: the entries, and whether the checkout went whole. */
export interface RunSelection {
  services: RunService[]
  whole: boolean
}

const SHA = /^[0-9a-f]{40}$/
const FOREIGN = 'A selected service does not belong to this environment'
const refuse = (message: string): never => {
  throw new DeployError('INVALID_STATE', message)
}
const byPosition = <T extends { position: number; name: string; id: string }>(a: T, b: T): number =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/** Groups in checkout position order. Throws DeployError('INVALID_STATE', …). */
export function resolveSelection(
  environmentId: string,
  req: { serviceIds: string[]; checkoutIds: string[] },
  data: { services: ServiceMeta[]; deployments: DeploymentMeta[] },
): SelectionGroup[] {
  const ids = [...req.serviceIds, ...req.checkoutIds]
  if (new Set(ids).size !== ids.length) refuse('A service is listed twice')
  if (ids.length === 0) refuse('Select at least one service')
  const services = new Map(data.services.map((s) => [s.id, s]))
  const deployments = new Map(data.deployments.filter((d) => d.environmentId === environmentId).map((d) => [d.id, d]))
  const trackedOf = (deploymentId: string): AppServiceMeta[] =>
    data.services.filter((s): s is AppServiceMeta => s.kind === 'service' && s.deploymentId === deploymentId && s.environmentId === environmentId).sort(byPosition)

  const picked = new Map<string, Set<string>>()
  for (const id of req.serviceIds) {
    const s = services.get(id)
    if (!s || s.environmentId !== environmentId) return refuse(FOREIGN)
    if (s.kind === 'db') return refuse(`${s.name} is a database; databases are never deployed`)
    if (s.deploymentId === null) return refuse(`${s.name} has no checkout`)
    if (!deployments.has(s.deploymentId)) return refuse(FOREIGN)
    const set = picked.get(s.deploymentId) ?? new Set<string>()
    set.add(s.id)
    picked.set(s.deploymentId, set)
  }
  const bare = new Set<string>()
  for (const id of req.checkoutIds) {
    const d = deployments.get(id)
    if (!d) return refuse(FOREIGN)
    if (trackedOf(id).length > 0) return refuse(`${d.name} has services; pick them instead`)
    bare.add(id)
  }

  return [...deployments.values()]
    .filter((d) => picked.has(d.id) || bare.has(d.id))
    .sort(byPosition)
    .map((deployment) => {
      const tracked = trackedOf(deployment.id)
      const want = picked.get(deployment.id)
      const selected = want ? tracked.filter((s) => want.has(s.id)) : []
      return { deployment, selected, tracked, whole: !want || selected.length === tracked.length }
    })
}

/** A run's service entries at preflight: every tracked service when whole, else the selected ones. */
export function runServicesOf(g: SelectionGroup): RunService[] {
  return (g.whole ? g.tracked : g.selected).map((s) => ({ id: s.id, name: s.name, composeService: s.composeService, previousCommit: s.lastDeployedCommit, deployedCommit: null }))
}

/**
 * The plan fields a run's selection decides. Urls come from the entries' services as they are now (with
 * `urlCheckFrom`), else the checkout's own; a deleted service has no url. Commit bases are the entries'
 * distinct previous commits, plus the tag when any entry has none or there are no entries.
 */
export function planFields(dep: DeploymentMeta, sel: RunSelection, services: Map<string, ServiceMeta>): Pick<PlanDeployment, 'services' | 'urls' | 'commitBases'> {
  const urls: HealthUrl[] = sel.services.flatMap((e) => {
    const s = services.get(e.id)
    return s?.kind === 'service' && s.url ? [{ url: s.url, from: s.urlCheckFrom }] : []
  })
  // A stored commit that isn't a full sha counts as unknown, so the range falls back to the tag.
  const previous = sel.services.map((e) => (e.previousCommit !== null && SHA.test(e.previousCommit) ? e.previousCommit : null))
  const shas = [...new Set(previous.filter((c): c is string => c !== null))]
  return {
    services: sel.whole ? null : sel.services.map((e) => e.composeService),
    urls: urls.length ? urls : dep.urls,
    commitBases: { shas, tag: previous.length === 0 || previous.some((c) => c === null) },
  }
}
