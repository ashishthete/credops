import type { DeploymentRunMeta, PreflightReport, ReleaseDetail, ReleaseSummary, RunEvent } from '../../../src/shared/deploy'
import type { HubDb } from '../db'

/*
 * A viewer whose grants name deployments sees a release only when it includes one of them, and then only the parts
 * of it that belong to those deployments, the hosts they run on, or the release as a whole. Anything that cannot be
 * tied to a visible part (an unattributed log line) is left out.
 */

/** What a release's deployment runs say about who may see which part of it. */
export interface RunRef {
  id: string
  deploymentId: string | null
  hostId: string | null
  serviceIds: string[]
}

export interface Visible {
  runs: Set<string>
  deployments: ReadonlySet<string>
  hosts: Set<string>
  services: Set<string>
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

/** The visible parts, or null when the release has none for this viewer. */
export function visibleOf(deploymentIds: ReadonlySet<string>, runs: RunRef[]): Visible | null {
  const mine = runs.filter((r) => r.deploymentId !== null && deploymentIds.has(r.deploymentId))
  if (mine.length === 0) return null
  return {
    runs: new Set(mine.map((r) => r.id)),
    deployments: deploymentIds,
    hosts: new Set(mine.flatMap((r) => (r.hostId === null ? [] : [r.hostId]))),
    services: new Set(mine.flatMap((r) => r.serviceIds)),
  }
}

/** The summary with its counts over the visible runs only. */
export function scopeSummary<T extends ReleaseSummary>(s: T, runs: RunRef[], v: Visible): T {
  const mine = runs.filter((r) => v.runs.has(r.id))
  return {
    ...s,
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

export function scopeDetail(d: ReleaseDetail, runs: RunRef[], v: Visible): ReleaseDetail {
  const shown: DeploymentRunMeta[] = d.runs.filter((r) => v.runs.has(r.id))
  return {
    ...scopeSummary(d, runs, v),
    runs: shown,
    preflight: d.preflight === null ? null : scopeReport(d.preflight, v),
    // The playbook covers every deployment of the release; it is hers only when they all are.
    playbook: shown.length === d.runs.length ? d.playbook : null,
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
    case 'step.started':
    case 'step.done':
    case 'step.failed':
    case 'task.done':
      return stepVisible(e.stepId, v) ? e : null
    case 'log':
      if (e.stepId !== null) return stepVisible(e.stepId, v) ? e : null
      return e.hostId !== null && v.hosts.has(e.hostId) ? e : null
    case 'lock.busy':
      return v.hosts.has(e.hostId) ? e : null
    case 'deployment.updated':
      return v.runs.has(e.deploymentRunId) ? e : null
    case 'rollback.started': {
      const ids = e.deploymentRunIds.filter((id) => v.runs.has(id))
      return ids.length ? { ...e, deploymentRunIds: ids } : null
    }
    default:
      // run.started, log.truncated, rollback.done, version.bumped, run.finished: the release as a whole.
      return e
  }
}

export function scopeEvents(events: RunEvent[], v: Visible): RunEvent[] {
  return events.flatMap((e) => {
    const s = scopeEvent(e, v)
    return s ? [s] : []
  })
}
