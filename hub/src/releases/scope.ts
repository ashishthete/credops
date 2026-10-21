import type { DeploymentRunMeta, PreflightReport, ReleaseDetail, ReleaseSummary, RunEvent } from '../../../src/shared/deploy'
import type { HubDb } from '../db'

/*
 * A viewer whose grants name deployments sees a release only when it includes one of them, and then only the parts
 * of it that belong to those deployments, the hosts they run on, or the release as a whole. Anything that cannot be
 * tied to a visible part (an unattributed log line) is left out.
 */

/** Shown for a release error that may come from a part the viewer cannot see. */
export const HIDDEN_ERROR = "The details are not shown because they may concern deployments you don't have access to."
/** The version step runs once per repository, so its output, error and warning can name the other checkouts' repositories. */
const VERSION_STEP = 'release:version'

/** What a release's deployment runs say about who may see which part of it. */
export interface RunRef {
  id: string
  deploymentId: string | null
  hostId: string | null
  serviceIds: string[]
}

export interface Visible {
  /** The release's runs, all of them, for the counts. */
  all: RunRef[]
  runs: Set<string>
  deployments: ReadonlySet<string>
  hosts: Set<string>
  /** Visible hosts that also run a hidden checkout: a raw line there can be either's. */
  shared: Set<string>
  services: Set<string>
  /** Error texts of visible failed steps and lock waits; a release error is shown only when it is one of them. */
  errors: Set<string>
}

export function runRefs(db: HubDb, releaseId: string): RunRef[] {
  const rows = db.prepare('SELECT id, deployment_id, host_id, services FROM deployment_runs WHERE release_id = ? ORDER BY position, id').all(releaseId) as {
    id: string
    deployment_id: string | null
    host_id: string | null
    services: string
  }[]
  return rows.map((r) => ({ id: r.id, deploymentId: r.deployment_id, hostId: r.host_id, serviceIds: serviceIdsOf(r.services) }))
}

function serviceIdsOf(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.flatMap((s) => (s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string' ? [(s as { id: string }).id] : [])) : []
  } catch {
    return []
  }
}

/** The parts of `releaseId` a viewer granted `deploymentIds` sees, or null when it has none. */
export function visibleIn(db: HubDb, deploymentIds: ReadonlySet<string>, releaseId: string): Visible | null {
  const all = runRefs(db, releaseId)
  const mine = all.filter((r) => r.deploymentId !== null && deploymentIds.has(r.deploymentId))
  if (mine.length === 0) return null
  const hostsOf = (rs: RunRef[]) => new Set(rs.flatMap((r) => (r.hostId === null ? [] : [r.hostId])))
  const hosts = hostsOf(mine)
  const hiddenHosts = hostsOf(all.filter((r) => !mine.includes(r)))
  const v: Visible = {
    all,
    runs: new Set(mine.map((r) => r.id)),
    deployments: deploymentIds,
    hosts,
    shared: new Set([...hosts].filter((h) => hiddenHosts.has(h))),
    services: new Set(mine.flatMap((r) => r.serviceIds)),
    errors: new Set(),
  }
  const rows = db.prepare("SELECT payload FROM run_events WHERE release_id = ? AND type IN ('step.failed', 'lock.busy')").all(releaseId) as { payload: string }[]
  for (const row of rows) {
    const e = JSON.parse(row.payload) as { type: string; stepId?: string; error?: string; hostId?: string; text?: string }
    if (e.type === 'step.failed' && e.stepId && e.stepId !== VERSION_STEP && e.error && stepVisible(e.stepId, v)) v.errors.add(e.error)
    if (e.type === 'lock.busy' && e.hostId && e.text && v.hosts.has(e.hostId)) v.errors.add(e.text)
  }
  return v
}

const errorFor = (error: string | null, v: Visible): string | null => (error === null || v.errors.has(error) ? error : HIDDEN_ERROR)

/** The summary with its counts over the visible runs only, and its error only when it comes from a visible part. */
export function scopeSummary<T extends ReleaseSummary>(s: T, v: Visible): T {
  const mine = v.all.filter((r) => v.runs.has(r.id))
  return {
    ...s,
    error: errorFor(s.error, v),
    deploymentCount: mine.length,
    hostCount: v.hosts.size,
    serviceIds: s.serviceIds.filter((id) => v.services.has(id)),
    serviceCount: mine.reduce((n, r) => n + r.serviceIds.length, 0),
  }
}

const pick = <V>(m: Record<string, V>, keep: (k: string) => boolean): Record<string, V> => Object.fromEntries(Object.entries(m).filter(([k]) => keep(k)))

function scopeReport(p: PreflightReport, v: Visible): PreflightReport {
  const dep = (k: string) => v.deployments.has(k)
  const commits = pick(p.commits, dep)
  return {
    ...p,
    checks: p.checks.filter((c) => (c.deploymentId === null ? v.hosts.has(c.hostId) : v.deployments.has(c.deploymentId))),
    commits,
    dockerModes: pick(p.dockerModes, dep),
    composeServices: pick(p.composeServices, dep),
    ...(p.composeDatabases ? { composeDatabases: pick(p.composeDatabases, dep) } : {}),
    serviceCommits: pick(p.serviceCommits, (k) => v.services.has(k)),
    locks: pick(p.locks, (k) => v.hosts.has(k)),
    commitsTotal: Object.values(commits).reduce((n, c) => n + c.commits.length, 0),
  }
}

export function scopeDetail(d: ReleaseDetail, v: Visible): ReleaseDetail {
  const shown: DeploymentRunMeta[] = d.runs.filter((r) => v.runs.has(r.id))
  // The playbook and the release notes cover every deployment of the release: theirs only when all of them are.
  const whole = shown.length === d.runs.length
  return {
    ...scopeSummary(d, v),
    runs: shown,
    preflight: d.preflight === null ? null : scopeReport(d.preflight, v),
    playbook: whole ? d.playbook : null,
    playbookGenerated: whole ? d.playbookGenerated : null,
    releaseNotes: whole ? d.releaseNotes : null,
    ...(whole ? {} : { playbookHidden: true }),
  }
}

/** Step ids are `<deploymentRunId>:<kind>`, `host:<hostId>:<kind>` or `release:<kind>`. */
function stepVisible(stepId: string, v: Visible): boolean {
  if (stepId.startsWith('release:')) return true
  if (stepId.startsWith('host:')) return v.hosts.has(stepId.slice(5, stepId.lastIndexOf(':')))
  const i = stepId.lastIndexOf(':')
  return i > 0 && v.runs.has(stepId.slice(0, i))
}

function scopeEvent(e: RunEvent, v: Visible): RunEvent | null {
  switch (e.type) {
    case 'preflight.check':
      return (e.check.deploymentId === null ? v.hosts.has(e.check.hostId) : v.deployments.has(e.check.deploymentId)) ? e : null
    case 'preflight.done':
      return { ...e, report: scopeReport(e.report, v) }
    case 'step.failed':
      if (e.stepId === VERSION_STEP) return { ...e, error: HIDDEN_ERROR }
      return stepVisible(e.stepId, v) ? e : null
    case 'step.done':
      if (e.stepId === VERSION_STEP) return e.message === undefined ? e : { ...e, message: HIDDEN_ERROR }
      return stepVisible(e.stepId, v) ? e : null
    case 'step.started':
    case 'task.done':
      return stepVisible(e.stepId, v) ? e : null
    case 'log':
      if (e.stepId === VERSION_STEP) return null
      if (e.stepId !== null) return stepVisible(e.stepId, v) ? e : null
      return e.hostId !== null && v.hosts.has(e.hostId) && !v.shared.has(e.hostId) ? e : null
    case 'lock.busy':
      return v.hosts.has(e.hostId) ? e : null
    case 'deployment.updated':
      return v.runs.has(e.deploymentRunId) ? e : null
    case 'rollback.started': {
      const ids = e.deploymentRunIds.filter((id) => v.runs.has(id))
      return ids.length ? { ...e, deploymentRunIds: ids } : null
    }
    case 'run.finished':
      return e.error === undefined ? e : { ...e, error: errorFor(e.error, v)! }
    default:
      // run.started, log.truncated, rollback.done, version.bumped: the release as a whole.
      return e
  }
}

export function scopeEvents(events: RunEvent[], v: Visible): RunEvent[] {
  return events.flatMap((e) => {
    const s = scopeEvent(e, v)
    return s ? [s] : []
  })
}
