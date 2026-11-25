import {
  LOG_KEEP_DAYS,
  LOG_KEEP_RELEASES,
  MAX_EVENTS_PER_RELEASE,
  type CommitInfo,
  type DeploymentRunMeta,
  type DeploymentRunStatus,
  type EnvLastRelease,
  type PreflightReport,
  type ReleaseDetail,
  type ReleaseKind,
  type ReleaseOptions,
  type ReleaseStatus,
  type ReleaseSummary,
  type RunEvent,
  type RunService,
  type RunEventBody,
  type StepKind,
  type VersionBump,
} from '../../shared/deploy'
import type { OperationMeta } from '../../shared/runbooks'
import type { RegionRef } from '../../shared/inventory'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { uuidv7 } from './uuidv7'

export interface ReleaseStoreDeps {
  db: Db
  now?: () => Date
  /** Cap on `log` events per release; later ones are dropped with a single `log.truncated`. */
  maxEvents?: number
  /** The database has the desktop's hosts and regions, so detail() lists a release's regions. The Hub's has neither. */
  regions?: boolean
}

export interface NewRelease {
  environmentId: string
  kind: ReleaseKind
  status: ReleaseStatus
  version: string | null
  previousVersion: string | null
  versionBump: VersionBump
  redeploy: boolean
  rollbackOf: string | null
  options: ReleaseOptions
  triggeredBy: string
  /** The services the release was confirmed for (releases.service_ids). */
  serviceIds: string[]
  /** Set for a runbook operation (releases.operation). */
  operation?: OperationMeta | null
}

export interface ReleaseStatusExtra {
  startedAt?: string | null
  finishedAt?: string | null
  version?: string | null
  previousVersion?: string | null
  error?: string | null
  releaseNotes?: string | null
  playbook?: string | null
  redeploy?: boolean
  versionBump?: VersionBump
  playbookSource?: 'generated' | 'edited'
  playbookGenerated?: string | null
}

export interface RunPlan {
  deploymentId: string | null
  deploymentName: string
  hostId: string | null
  hostLabel: string
  position: number
  branch: string
  steps: { stepId: string; kind: StepKind }[]
  services: RunService[]
  wholeCheckout: boolean
}

export interface RunPatch {
  status?: DeploymentRunStatus
  rolledBack?: boolean
  previousCommit?: string | null
  deployedCommit?: string | null
  commits?: CommitInfo[]
  steps?: DeploymentRunMeta['steps']
  backupFile?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export const INTERRUPTED_MESSAGE = 'interrupted: CredOps quit during the run'
/** Ends the error failInterrupted writes: the run it started may outlive the app, as may its lock. */
export const INTERRUPTED_RUN_NOTE = '; the ansible run it started may still be working on the hosts'
/** Ends it instead for a release that was rolling back. */
export const INTERRUPTED_ROLLBACK_NOTE = '; it was rolling back, so its hosts may be part way back, and the rollback may still be running there'
export const wasInterrupted = (error: string | null): boolean => error !== null && (error.endsWith(INTERRUPTED_RUN_NOTE) || error.endsWith(INTERRUPTED_ROLLBACK_NOTE))
const MAX_PAGE = 5000
/** previousRelease follows at most this many rollbacks back. */
const MAX_ROLLBACK_CHAIN = 1000

interface ReleaseRow {
  id: string
  environment_id: string
  environment_name: string
  kind: ReleaseKind
  status: ReleaseStatus
  version: string | null
  previous_version: string | null
  redeploy: number
  rollback_of: string | null
  options: string
  service_ids: string
  release_notes: string | null
  error: string | null
  playbook: string | null
  operation: string | null
  playbook_source: 'generated' | 'edited' | null
  playbook_generated: string | null
  triggered_by: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  deployment_count: number
  host_count: number
  service_count: number
}

interface RunRow {
  id: string
  release_id: string
  deployment_id: string | null
  deployment_name: string
  host_id: string | null
  host_label: string
  position: number
  branch: string
  previous_commit: string | null
  deployed_commit: string | null
  commits: string
  steps: string
  status: DeploymentRunStatus
  rolled_back: number
  backup_file: string | null
  started_at: string | null
  finished_at: string | null
  services: string
  whole_checkout: number
}

interface EventRow {
  id: string
  release_id: string
  seq: number
  at: string
  payload: string
}

const SELECT = `SELECT r.*, e.name AS environment_name,
  (SELECT COUNT(*) FROM deployment_runs d WHERE d.release_id = r.id) AS deployment_count,
  (SELECT COUNT(DISTINCT d.host_id) FROM deployment_runs d WHERE d.release_id = r.id) AS host_count,
  (SELECT COUNT(*) FROM deployment_runs d, json_each(CASE WHEN json_valid(d.services) AND json_type(d.services) = 'array' THEN d.services ELSE '[]' END) j
    WHERE d.release_id = r.id AND j.type = 'object') AS service_count
  FROM releases r JOIN environments e ON e.id = r.environment_id`

/**
 * A run (`d`) of release `r` that left its services deployed: a release run that succeeded and was not rolled back, in a
 * release that was not rolled back, or a rollback run that succeeded (rollback runs end `rolled_back`). An operation
 * (a runbook run) deploys nothing.
 */
const DEPLOYED = `((r.kind = 'release' AND r.operation IS NULL AND r.status <> 'rolled_back' AND d.status = 'succeeded' AND d.rolled_back = 0)
  OR (r.kind = 'rollback' AND d.status = 'rolled_back'))`

/**
 * Releases, their per-deployment runs and the append-only event stream. Holds no secrets: events are
 * redacted by the engine before they get here. `transaction()` lets a caller group run updates with events.
 */
export class ReleaseStore {
  private readonly db: Db
  private readonly now: () => Date
  private readonly maxEvents: number
  /** Per release, its stored log and terminal line counts; read from the table once. */
  private readonly logCounts = new Map<string, { logs: number; term: number }>()
  private readonly withRegions: boolean
  /** Logs dropped since the last `log.truncated`, per release; flushed with the next non-log event. */
  private readonly dropped = new Map<string, number>()

  constructor(deps: ReleaseStoreDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => new Date())
    this.maxEvents = deps.maxEvents ?? MAX_EVENTS_PER_RELEASE
    this.withRegions = deps.regions ?? false
  }

  /** Joins the caller's transaction when one is open, otherwise runs `fn` in its own. */
  transaction<T>(fn: () => T): T {
    return this.db.isTransaction ? fn() : inTransaction(this.db, fn)
  }

  createRelease(input: NewRelease): ReleaseSummary {
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO releases(id, environment_id, kind, status, version, previous_version, version_bump, redeploy,
          rollback_of, options, service_ids, triggered_by, created_at, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, input.environmentId, input.kind, input.status, input.version, input.previousVersion, input.versionBump,
        input.redeploy ? 1 : 0, input.rollbackOf, JSON.stringify(input.options), JSON.stringify(input.serviceIds), input.triggeredBy,
        this.now().toISOString(), input.operation ? JSON.stringify(input.operation) : null,
      )
    return this.get(id)
  }

  get(id: string): ReleaseSummary {
    return summary(this.row(id))
  }

  setStatus(id: string, status: ReleaseStatus, extra: ReleaseStatusExtra = {}): void {
    this.row(id)
    const sets = ['status = ?']
    const args: (string | number | null)[] = [status]
    const cols: Record<keyof ReleaseStatusExtra, string> = {
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      version: 'version',
      previousVersion: 'previous_version',
      error: 'error',
      releaseNotes: 'release_notes',
      playbook: 'playbook',
      redeploy: 'redeploy',
      versionBump: 'version_bump',
      playbookSource: 'playbook_source',
      playbookGenerated: 'playbook_generated',
    }
    for (const k of Object.keys(cols) as (keyof ReleaseStatusExtra)[]) {
      if (extra[k] !== undefined) {
        sets.push(`${cols[k]} = ?`)
        args.push(typeof extra[k] === 'boolean' ? (extra[k] ? 1 : 0) : (extra[k] as string | null))
      }
    }
    this.db.prepare(`UPDATE releases SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  }

  detail(id: string): ReleaseDetail {
    const r = this.row(id)
    const runs = (this.db.prepare('SELECT * FROM deployment_runs WHERE release_id = ? ORDER BY position, id').all(id) as unknown as RunRow[]).map(runMeta)
    const last = this.db.prepare('SELECT MAX(seq) AS s FROM run_events WHERE release_id = ?').get(id) as { s: number | null }
    const pf = this.db
      .prepare("SELECT payload FROM run_events WHERE release_id = ? AND type = 'preflight.done' ORDER BY seq DESC LIMIT 1")
      .get(id) as { payload: string } | undefined
    const stored = pf ? ((JSON.parse(pf.payload) as { report: PreflightReport | undefined }).report ?? null) : null
    // Reports stored before services lack these maps.
    const preflight = stored ? { ...stored, composeServices: stored.composeServices ?? {}, serviceCommits: stored.serviceCommits ?? {} } : null
    return {
      ...summary(r),
      options: JSON.parse(r.options) as ReleaseOptions,
      releaseNotes: r.release_notes,
      playbook: r.playbook,
      playbookGenerated: r.playbook_generated,
      runs,
      preflight,
      lastSeq: last.s ?? 0,
      ...(this.withRegions ? { regions: this.regions(id) } : {}),
    }
  }

  /** A checkout's region is its host's (src/shared/regions.ts): the distinct regions of the runs' hosts, by code. */
  private regions(id: string): RegionRef[] {
    return this.db
      .prepare(
        `SELECT DISTINCT g.id, g.code, g.display_name AS displayName FROM deployment_runs d
         JOIN hosts h ON h.id = d.host_id JOIN regions g ON g.id = h.region_id
         WHERE d.release_id = ? ORDER BY g.code`,
      )
      .all(id) as unknown as RegionRef[]
  }

  /** Newest first. `before` is a release id to page from. */
  list(q: { environmentId?: string; limit: number; before?: string; operations?: 'only' | 'exclude' }): ReleaseSummary[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.environmentId !== undefined) {
      where.push('r.environment_id = ?')
      args.push(q.environmentId)
    }
    if (q.before !== undefined) {
      where.push('r.id < ?')
      args.push(q.before)
    }
    if (q.operations === 'only') where.push('r.operation IS NOT NULL')
    else if (q.operations === 'exclude') where.push('r.operation IS NULL')
    const limit = Math.max(1, Math.min(Math.floor(q.limit), 200))
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as unknown as ReleaseRow[]).map(summary)
  }

  /**
   * Per environment, its newest release that started or is running (a preflight, a ready or blocked one and a discarded
   * one never ran), with the commits of its first run that deployed one. One statement for every environment: each
   * environment walks releases_env from its newest release back, so the cost follows environments, not all releases.
   */
  latestPerEnvironment(): EnvLastRelease[] {
    const run = (col: string) =>
      `(SELECT d.${col} FROM deployment_runs d WHERE d.release_id = q.id ORDER BY d.deployed_commit IS NULL, d.position, d.id LIMIT 1)`
    const sql = `SELECT q.*, ${run('previous_commit')} AS last_previous_commit, ${run('deployed_commit')} AS last_deployed_commit
      FROM (${SELECT} WHERE r.id IN (SELECT (SELECT r2.id FROM releases r2 WHERE r2.environment_id = e.id
          AND r2.operation IS NULL AND r2.status NOT IN ('preflight','ready','blocked','discarded') ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
        FROM environments e)) q
      ORDER BY q.id DESC`
    const rows = this.db.prepare(sql).all() as unknown as (ReleaseRow & { last_previous_commit: string | null; last_deployed_commit: string | null })[]
    return rows.map((r) => ({ ...summary(r), previousCommit: r.last_previous_commit, deployedCommit: r.last_deployed_commit }))
  }

  /** Releases that are executing right now (running or rolling back). */
  active(): ReleaseSummary[] {
    return (this.db.prepare(`${SELECT} WHERE r.status IN ('running','rolling_back') ORDER BY r.id`).all() as unknown as ReleaseRow[]).map(summary)
  }

  // ---- runs ----

  /** Plans one run per deployment; steps start `pending` with null times. */
  createRuns(releaseId: string, plans: RunPlan[]): DeploymentRunMeta[] {
    this.row(releaseId)
    return this.transaction(() => {
      const ins = this.db.prepare(
        `INSERT INTO deployment_runs(id, release_id, deployment_id, deployment_name, host_id, host_label, position, branch, steps,
           services, whole_checkout, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      )
      return plans.map((p) => {
        const id = uuidv7()
        const steps = p.steps.map((s) => ({ stepId: s.stepId, kind: s.kind, state: 'pending' as const, startedAt: null, finishedAt: null }))
        ins.run(
          id, releaseId, p.deploymentId, p.deploymentName, p.hostId, p.hostLabel, p.position, p.branch, JSON.stringify(steps),
          JSON.stringify(p.services), p.wholeCheckout ? 1 : 0,
        )
        return runMeta(this.db.prepare('SELECT * FROM deployment_runs WHERE id = ?').get(id) as unknown as RunRow)
      })
    })
  }

  /** `whole` also sets the run's form (a start that skips some of a whole checkout's services makes it partial). */
  setRunServices(runId: string, services: RunService[], whole?: boolean): void {
    const res =
      whole === undefined
        ? this.db.prepare('UPDATE deployment_runs SET services = ? WHERE id = ?').run(JSON.stringify(services), runId)
        : this.db.prepare('UPDATE deployment_runs SET services = ?, whole_checkout = ? WHERE id = ?').run(JSON.stringify(services), whole ? 1 : 0, runId)
    if (res.changes === 0) throw new Error('deployment run not found')
  }

  /**
   * Each service → the newest started release (either kind) whose run left it deployed (see `DEPLOYED`). A failed or
   * rolled-back release does not count, nor, with `undoneAfter`, a rollback of a release newer than that one.
   */
  latestTouching(serviceIds: string[], undoneAfter?: string): Map<string, string> {
    const out = new Map<string, string>()
    if (serviceIds.length === 0) return out
    const rows = this.db
      .prepare(
        `SELECT j.value ->> '$.id' AS service_id, MAX(r.id) AS release_id
         FROM releases r JOIN deployment_runs d ON d.release_id = r.id, json_each(d.services) j
         WHERE r.started_at IS NOT NULL AND j.value ->> '$.id' IN (SELECT value FROM json_each(?)) AND ${DEPLOYED}
           AND NOT (r.kind = 'rollback' AND COALESCE(r.rollback_of > ?, 0))
         GROUP BY service_id`,
      )
      .all(JSON.stringify(serviceIds), undoneAfter ?? null) as { service_id: string; release_id: string }[]
    for (const r of rows) out.set(r.service_id, r.release_id)
    return out
  }

  /**
   * The newest started release before `beforeReleaseId` whose run for the service succeeded, with the commit it
   * deployed. A rollback release's runs end `rolled_back` when they succeed; a release that was rolled back no longer counts.
   */
  previousTouching(serviceId: string, beforeReleaseId: string): { releaseId: string; commit: string | null; rollbackOf: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT r.id AS release_id, j.value ->> '$.deployedCommit' AS commit_sha, CASE WHEN r.kind = 'rollback' THEN r.rollback_of END AS rollback_of
         FROM releases r JOIN deployment_runs d ON d.release_id = r.id, json_each(d.services) j
         WHERE r.started_at IS NOT NULL AND r.id < ? AND j.value ->> '$.id' = ? AND ${DEPLOYED}
         ORDER BY r.id DESC LIMIT 1`,
      )
      .get(beforeReleaseId, serviceId) as { release_id: string; commit_sha: string | null; rollback_of: string | null } | undefined
    return row ? { releaseId: row.release_id, commit: row.commit_sha, rollbackOf: row.rollback_of } : null
  }

  /**
   * The release (never a rollback) the service was on before `beforeReleaseId`: a rollback found on the way stands for
   * the release it restored, the one before the release it undid. A malformed chain (a rollback not newer than the
   * release it undid) gives null rather than looping.
   */
  previousRelease(serviceId: string, beforeReleaseId: string): string | null {
    let hit = this.previousTouching(serviceId, beforeReleaseId)
    for (let steps = 0; hit !== null && hit.rollbackOf !== null; steps++) {
      const next = this.previousTouching(serviceId, hit.rollbackOf)
      if (steps >= MAX_ROLLBACK_CHAIN || (next !== null && next.releaseId >= hit.releaseId)) return null
      hit = next
    }
    return hit?.releaseId ?? null
  }

  updateRun(runId: string, patch: RunPatch): void {
    const cols: [keyof RunPatch, string, (v: never) => string | number | null][] = [
      ['status', 'status', (v) => v],
      ['rolledBack', 'rolled_back', (v: boolean) => (v ? 1 : 0)],
      ['previousCommit', 'previous_commit', (v) => v],
      ['deployedCommit', 'deployed_commit', (v) => v],
      ['commits', 'commits', (v) => JSON.stringify(v)],
      ['steps', 'steps', (v) => JSON.stringify(v)],
      ['backupFile', 'backup_file', (v) => v],
      ['startedAt', 'started_at', (v) => v],
      ['finishedAt', 'finished_at', (v) => v],
    ]
    const sets: string[] = []
    const args: (string | number | null)[] = []
    for (const [k, col, enc] of cols) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`)
        args.push(enc(patch[k] as never))
      }
    }
    if (sets.length === 0) return
    const res = this.db.prepare(`UPDATE deployment_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, runId)
    if (res.changes === 0) throw new Error('deployment run not found')
  }

  // ---- events ----

  /**
   * Appends in order, assigning seq and UUIDv7 ids. Logs past the cap are dropped. run_events is append-only,
   * so the drop count can't be edited in place: it is written as one `log.truncated` (dropped = lines since the
   * previous marker) just before the next non-log event.
   */
  appendEvents(releaseId: string, bodies: RunEventBody[]): RunEvent[] {
    this.row(releaseId)
    return this.transaction(() => {
      // terminal lines have their own cap, so the console view never crowds out the step logs (counted once, then kept)
      const counts =
        this.logCounts.get(releaseId) ??
        (this.db
          .prepare("SELECT COALESCE(SUM(json_extract(payload, '$.stream') IS NOT 'term'), 0) AS logs, COALESCE(SUM(json_extract(payload, '$.stream') = 'term'), 0) AS term FROM run_events WHERE release_id = ? AND type = 'log'")
          .get(releaseId) as { logs: number; term: number })
      let logs = counts.logs
      let term = counts.term
      let seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM run_events WHERE release_id = ?').get(releaseId) as { s: number }).s
      let dropped = this.dropped.get(releaseId) ?? 0
      const out: RunEvent[] = []
      const ins = this.db.prepare('INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES (?,?,?,?,?,?)')
      const put = (body: RunEventBody) => {
        const ev = { id: uuidv7(), runId: releaseId, seq: ++seq, at: this.now().toISOString(), ...body } as RunEvent
        ins.run(ev.id, releaseId, ev.seq, ev.at, ev.type, JSON.stringify(body))
        out.push(ev)
      }
      for (const body of bodies) {
        if (body.type === 'log' && body.stream === 'term') {
          if (term >= this.maxEvents) continue
          if (++term === this.maxEvents) {
            put({ ...body, line: `… the terminal view stops here (${this.maxEvents} lines); the step logs go on` })
            continue
          }
        } else if (body.type === 'log') {
          if (logs >= this.maxEvents) {
            dropped++
            continue
          }
          logs++
        } else if (dropped > 0) {
          put({ type: 'log.truncated', dropped })
          dropped = 0
        }
        put(body)
      }
      if (dropped > 0) this.dropped.set(releaseId, dropped)
      else this.dropped.delete(releaseId)
      this.logCounts.set(releaseId, { logs, term })
      return out
    })
  }

  events(releaseId: string, afterSeq: number, limit: number): RunEvent[] {
    const n = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE))
    const rows = this.db
      .prepare('SELECT id, release_id, seq, at, payload FROM run_events WHERE release_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(releaseId, afterSeq, n) as unknown as EventRow[]
    return rows.map((r) => ({ id: r.id, runId: r.release_id, seq: r.seq, at: r.at, ...(JSON.parse(r.payload) as RunEventBody) }) as RunEvent)
  }

  // ---- startup ----

  /**
   * A release left preflight, running or rolling back by a quit can never finish: mark it failed (its runs and
   * their steps too). `ready` is a stable waiting state and stays. Returns the ids.
   */
  failInterrupted(message: string = INTERRUPTED_MESSAGE): string[] {
    const rows = this.db.prepare("SELECT id, status, kind FROM releases WHERE status IN ('preflight','running','rolling_back') ORDER BY id").all() as { id: string; status: ReleaseStatus; kind: ReleaseKind }[]
    const ids = rows.map((r) => r.id)
    if (ids.length === 0) return ids
    const ts = this.now().toISOString()
    this.transaction(() => {
      for (const { id, status: was, kind } of rows) {
        const runs = this.db.prepare("SELECT id, status, steps FROM deployment_runs WHERE release_id = ? AND status IN ('running','pending')").all(id) as unknown as Pick<RunRow, 'id' | 'status' | 'steps'>[]
        for (const run of runs) {
          const steps = (JSON.parse(run.steps) as DeploymentRunMeta['steps']).map((st) =>
            st.state === 'running' ? { ...st, state: 'failed' as const, finishedAt: ts } : st.state === 'pending' ? { ...st, state: 'skipped' as const } : st,
          )
          const status = run.status === 'running' ? 'failed' : 'cancelled'
          this.db
            .prepare('UPDATE deployment_runs SET status = ?, steps = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?')
            .run(status, JSON.stringify(steps), run.status === 'running' ? ts : null, run.id)
        }
        // A preflight holds no lock and changes nothing.
        const error = was === 'preflight' ? message : `${message}${was === 'rolling_back' || kind === 'rollback' ? INTERRUPTED_ROLLBACK_NOTE : INTERRUPTED_RUN_NOTE}`
        this.setStatus(id, 'failed', { error, finishedAt: ts })
        this.appendEvents(id, [{ type: 'run.finished', status: 'failed', error }])
      }
    })
    return ids
  }

  /**
   * Drops the log lines of releases that finished more than `keepDays` ago, sparing each environment's newest
   * `keepReleases`. The release, its runs, steps and every other event stay; one `log.truncated` says how many lines
   * went. Returns the number of lines removed.
   */
  pruneLogs(keepDays: number = LOG_KEEP_DAYS, keepReleases: number = LOG_KEEP_RELEASES): number {
    const cutoff = new Date(this.now().getTime() - keepDays * 86_400_000).toISOString()
    const ids = (
      this.db
        .prepare(
          `SELECT r.id FROM releases r
           WHERE r.finished_at IS NOT NULL AND r.finished_at < ?
             AND EXISTS (SELECT 1 FROM run_events e WHERE e.release_id = r.id AND e.type = 'log')
             AND r.id NOT IN (SELECT r2.id FROM releases r2 WHERE r2.environment_id = r.environment_id ORDER BY r2.created_at DESC, r2.id DESC LIMIT ?)`,
        )
        .all(cutoff, keepReleases) as { id: string }[]
    ).map((r) => r.id)
    let removed = 0
    for (const id of ids) {
      this.transaction(() => {
        const n = Number(this.db.prepare("DELETE FROM run_events WHERE release_id = ? AND type = 'log'").run(id).changes)
        const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM run_events WHERE release_id = ?').get(id) as { s: number }).s
        this.db
          .prepare('INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES (?,?,?,?,?,?)')
          .run(uuidv7(), id, seq + 1, this.now().toISOString(), 'log.truncated', JSON.stringify({ type: 'log.truncated', dropped: n }))
        removed += n
      })
      this.logCounts.delete(id)
    }
    return removed
  }

  private row(id: string): ReleaseRow {
    const row = this.db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as ReleaseRow | undefined
    if (!row) throw new Error('release not found')
    return row
  }
}

function summary(r: ReleaseRow): ReleaseSummary {
  return {
    id: r.id,
    environmentId: r.environment_id,
    environmentName: r.environment_name,
    kind: r.kind,
    status: r.status,
    version: r.version,
    previousVersion: r.previous_version,
    redeploy: r.redeploy === 1,
    rollbackOf: r.rollback_of,
    triggeredBy: r.triggered_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    deploymentCount: r.deployment_count,
    hostCount: r.host_count,
    serviceIds: serviceIds(r.service_ids),
    serviceCount: r.service_count,
    error: r.error,
    operation: parseOperation(r.operation),
    playbookSource: r.playbook_source === 'edited' ? 'edited' : 'generated',
  }
}

/** A release's stored operation, or null when absent or unreadable. */
function parseOperation(json: string | null): OperationMeta | null {
  if (json === null) return null
  try {
    const o = JSON.parse(json) as OperationMeta
    return typeof o === 'object' && o !== null ? o : null
  } catch {
    return null
  }
}

function runMeta(r: RunRow): DeploymentRunMeta {
  return {
    id: r.id,
    releaseId: r.release_id,
    deploymentId: r.deployment_id,
    deploymentName: r.deployment_name,
    hostId: r.host_id,
    hostLabel: r.host_label,
    position: r.position,
    branch: r.branch,
    previousCommit: r.previous_commit,
    deployedCommit: r.deployed_commit,
    commits: JSON.parse(r.commits) as CommitInfo[],
    status: r.status,
    rolledBack: r.rolled_back === 1,
    backupFile: r.backup_file,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    steps: JSON.parse(r.steps) as DeploymentRunMeta['steps'],
    services: runServices(r.services),
    wholeCheckout: r.whole_checkout === 1,
  }
}

/** A release's stored service ids, keeping only strings; anything else (bad JSON, not an array) reads as none. */
function serviceIds(json: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** A run's stored services, keeping only well-formed entries; anything else (old rows, bad JSON) reads as none. */
function runServices(json: string): RunService[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const str = (v: unknown): v is string => typeof v === 'string'
  const opt = (v: unknown): v is string | null => v === null || typeof v === 'string'
  return raw.flatMap((e: unknown) => {
    if (typeof e !== 'object' || e === null) return []
    const o = e as Record<string, unknown>
    // An entry stored before previousReleaseId existed reads it as null.
    const previousReleaseId = o.previousReleaseId === undefined ? null : o.previousReleaseId
    if (!str(o.id) || !str(o.name) || !str(o.composeService) || !opt(o.previousCommit) || !opt(previousReleaseId) || !opt(o.deployedCommit)) return []
    return [{ id: o.id, name: o.name, composeService: o.composeService, previousCommit: o.previousCommit, previousReleaseId, deployedCommit: o.deployedCommit }]
  })
}
