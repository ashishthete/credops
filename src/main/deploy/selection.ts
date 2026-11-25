import type { DeploymentMeta, HealthUrl, ReleaseFlow, RunService } from '../../shared/deploy'
import type { AppServiceMeta, ServiceMeta } from '../../shared/services'
import { MAX_STEPS_PER_CHECKOUT, stepLabel, type StepBody } from '../../shared/steps'
import { DeployError } from './access'
import type { PlanDeployment, PlanStage, PlanStep } from './runner'

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
    if (s.kind === 'bastion') return refuse(`${s.name} is a bastion; bastions are never deployed`)
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
  return (g.whole ? g.tracked : g.selected).map((s) => ({ id: s.id, name: s.name, composeService: s.composeService, previousCommit: s.lastDeployedCommit, previousReleaseId: s.lastReleaseId, deployedCommit: null }))
}

/**
 * A run's selection less the services a release skips (unchanged since their last deploy). A whole checkout that
 * keeps only some of its services goes partial; one that keeps none has no selection left (null). A checkout with
 * no services is never skipped.
 */
export function skipServices(sel: RunSelection, skip: ReadonlySet<string>): { sel: RunSelection | null; skipped: string[] } {
  const skipped = sel.services.filter((e) => skip.has(e.id)).map((e) => e.id)
  if (skipped.length === 0) return { sel, skipped }
  const services = sel.services.filter((e) => !skip.has(e.id))
  return { sel: services.length ? { services, whole: false } : null, skipped }
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

/** A run as flowStages reads it: the checkout and its selection after skips. */
export interface FlowRun {
  run: { id: string }
  dep: DeploymentMeta
  sel: RunSelection
}

/**
 * A release flow as stages of this release's runs, in flow order. A services stage keeps the selected services it
 * names (a service named twice counts where it first appears), one part per checkout in the order the stage lists
 * them; a stage left with none is dropped, as is a step stage whose service is not selected (or skipped). A
 * checkout's up and health split across its parts: each part ups its services and checks their URLs. Services the
 * flow never names join their checkout's last part, and a whole checkout's last part ups the whole checkout; a
 * checkout the flow never names gets a part in one more stage at the end. A step stage's step is keyed
 * `c_<MAX_STEPS_PER_CHECKOUT + stage index>` (never a checkout's own key) and its secrets `FLOW_<stage index>_<n>`.
 * No flow: null.
 */
export function flowStages(flow: ReleaseFlow | null, selected: readonly FlowRun[], metas: Map<string, ServiceMeta>): PlanStage[] | null {
  if (flow === null) return null
  type Part = { runId: string; services: string[] | null; urls: number[] }
  const runs = selected.map(({ run, dep, sel }) => {
    // the order planFields builds the run's urls in: the entries that have one (none: the checkout's own urls)
    const urlAt = new Map<string, number>()
    for (const e of sel.services) {
      const s = metas.get(e.id)
      if (s?.kind === 'service' && s.url) urlAt.set(e.id, urlAt.size)
    }
    return { runId: run.id, depId: dep.id, sel, urlAt, urls: planFields(dep, sel, metas).urls.length, named: new Set<string>(), parts: [] as Part[] }
  })
  type Run = (typeof runs)[number]
  const byDep = new Map(runs.map((r) => [r.depId, r]))
  const entryOf = (serviceId: string): { r: Run; e: RunService } | null => {
    const m = metas.get(serviceId)
    const r = m?.kind === 'service' && m.deploymentId !== null ? byDep.get(m.deploymentId) : undefined
    const e = r?.sel.services.find((x) => x.id === serviceId)
    return r && e ? { r, e } : null
  }
  const stages: PlanStage[] = []
  flow.stages.forEach((st, i) => {
    if (st.kind === 'step') {
      const hit = entryOf(st.serviceId)
      if (hit) stages.push({ kind: 'step', runId: hit.r.runId, step: flowStep(i, st.step) })
      return
    }
    const parts = new Map<Run, Part>()
    for (const id of st.serviceIds) {
      const hit = entryOf(id)
      if (!hit || hit.r.named.has(id)) continue
      hit.r.named.add(id)
      const part = parts.get(hit.r) ?? { runId: hit.r.runId, services: [], urls: [] }
      if (!part.services?.includes(hit.e.composeService)) part.services?.push(hit.e.composeService)
      const u = hit.r.urlAt.get(id)
      if (u !== undefined) part.urls.push(u)
      parts.set(hit.r, part)
    }
    if (parts.size === 0) return
    for (const [r, part] of parts) r.parts.push(part)
    stages.push({ kind: 'services', parts: [...parts.values()] })
  })
  // What the flow never named: into the checkout's last part, or a last stage of its own.
  const tail: Part[] = []
  for (const r of runs) {
    const all = Array.from({ length: r.urls }, (_, n) => n)
    const names = [...new Set(r.sel.services.map((e) => e.composeService))]
    const last = r.parts.at(-1)
    if (!last) {
      tail.push({ runId: r.runId, services: r.sel.whole ? null : names, urls: all })
      continue
    }
    const earlier = new Set(r.parts.slice(0, -1).flatMap((p) => p.urls))
    last.urls = all.filter((n) => !earlier.has(n))
    const unnamed = r.sel.services.filter((e) => !r.named.has(e.id)).map((e) => e.composeService)
    last.services = r.sel.whole ? null : [...new Set([...(last.services ?? []), ...unnamed])]
  }
  if (tail.length > 0) stages.push({ kind: 'services', parts: tail })
  return stages
}

function flowStep(i: number, step: StepBody): PlanStep {
  return {
    key: `c_${MAX_STEPS_PER_CHECKOUT + i}`,
    label: stepLabel(step),
    step,
    anchor: null,
    alsoOnRollback: false,
    secretKeys: step.secrets.map((x, n) => ({ envName: x.envName, key: `FLOW_${i}_${n}` })),
    paramKeys: [],
  }
}
