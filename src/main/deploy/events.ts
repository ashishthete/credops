import {
  COMPOSE_SERVICE,
  type CommitInfo,
  DISK_WARN_KB,
  LOCK_STALE_MS,
  type LockHolder,
  MAX_COMMITS,
  MAX_LOG_LINE,
  type DockerMode,
  type PreflightCheck,
  type PreflightReport,
  type RunEventBody,
  STEP_LABEL,
  type StepKind,
  filterReverts,
  lockHolderText,
} from '../../shared/deploy'
import { redact } from '../security/redact'
import { MARK, RC_BREAK_KEPT, RC_LOCK_BUSY, parseMarker, parsePfLine, parsePrev, parseStreamLine } from './markers'
import type { DeployPlan, PlanDeployment, PlanHost } from './runner'

export { parseStreamLine }

const MAX_ERROR = 4000
const ERROR_CONTEXT_LINES = 8

interface ResultEvent {
  event: 'ok' | 'failed' | 'skipped' | 'unreachable'
  host?: string
  task?: string
  tags?: string[]
  rc?: number | null
  stdout?: string
  stderr?: string
  msg?: string
  no_log?: boolean
  truncated?: string[]
  ignored?: boolean
}

interface Active {
  startedAt: number
  kind: StepKind
  deploymentRunId: string | null
  hostId: string | null
  seen: number
  expected: number
  done: boolean
}

const STEP_KINDS = new Set<string>(Object.keys(STEP_LABEL))
const cut = (s: string): string => (s.length > MAX_LOG_LINE ? `${s.slice(0, MAX_LOG_LINE - 7)} …(cut)` : s)

/** Turns the callback plugin's JSON lines into run events, redacting every string that leaves. */
export class EventTranslator {
  private readonly depByRun = new Map<string, PlanDeployment>()
  private readonly hostByAlias = new Map<string, PlanHost>()
  private readonly hostById = new Map<string, PlanHost>()
  private readonly active = new Map<string, Active>()
  private readonly failedRuns = new Set<string>()
  private readonly pf = new Map<string, string[]>()
  private readonly pfCut = new Set<string>()
  private readonly rescuedBy = new Map<string, number>()
  private readonly unknownPrevious = new Set<string>()
  private current: { stepId: string; kind: StepKind; run: string; name: string } | null = null
  private sawFailure = false
  private tagNote: string | null = null
  private readonly versionTasks: number

  constructor(private readonly o: { plan: DeployPlan; secrets: () => string[]; now: () => number }) {
    for (const d of o.plan.deployments) this.depByRun.set(d.runId, d)
    // one version task per repo on each host (the generator skips repeats)
    this.versionTasks = Math.max(1, new Set(o.plan.deployments.map((d) => `${d.hostId}\n${d.repoPath}`)).size)
    for (const h of o.plan.hosts) {
      this.hostByAlias.set(h.alias, h)
      this.hostById.set(h.hostId, h)
    }
  }

  // ---- results other code reads
  /** Raw stdout of the preflight tasks, keyed by `od_run` (a deployment run id, or `host:<hostId>`). */
  preflightOutput(): Record<string, string> {
    return Object.fromEntries([...this.pf].map(([k, v]) => [k, v.join('\n')]))
  }
  /** Runs whose preflight output the plugin cut at its cap. */
  preflightCut(): string[] {
    return [...this.pfCut]
  }
  /** Hosts that had rescued failures (a rollback step failing is rescued so the run continues), with the count. */
  rescued(): Record<string, number> {
    return Object.fromEntries(this.rescuedBy)
  }
  /** Deployment runs whose previous commit could not be read from origin (never a first deploy). */
  previousUnknown(): string[] {
    return [...this.unknownPrevious]
  }

  private red(s: string): string {
    return redact(s, this.o.secrets())
  }
  private line(s: string): string {
    return cut(this.red(s))
  }

  feed(raw: string): RunEventBody[] {
    const text = raw.replace(/\r$/, '')
    if (text.trim() === '') return []
    let ev: unknown
    try {
      ev = JSON.parse(text)
    } catch {
      return [this.ansibleLog(text)]
    }
    if (typeof ev !== 'object' || ev === null || typeof (ev as { event?: unknown }).event !== 'string') return [this.ansibleLog(text)]
    const e = ev as { event: string } & Record<string, unknown>
    switch (e.event) {
      case 'task_start':
        return this.taskStart(String(e.name ?? ''), Array.isArray(e.tags) ? e.tags.map(String) : [])
      case 'ok':
      case 'failed':
      case 'skipped':
      case 'unreachable':
        return this.result(e as unknown as ResultEvent)
      case 'rescued': {
        const n = typeof e.count === 'number' ? e.count : 1
        const h = this.hostByAlias.get(String(e.host))
        this.rescuedBy.set(h?.hostId ?? String(e.host), n)
        return [this.ansibleLog(`${h?.label ?? String(e.host)}: ${n} failed step${n === 1 ? ' was' : 's were'} rescued`)]
      }
      case 'warning':
        return typeof e.msg === 'string' ? [this.ansibleLog(e.msg)] : []
      default:
        return []
    }
  }

  /** Called when ansible exits: closes steps that never finished. */
  finish(exitCode: number | null, signal: string | null, cancelled = false): RunEventBody[] {
    const out: RunEventBody[] = []
    if (cancelled) {
      // a cancel is not a failure: running steps and their deployments close as cancelled
      const runs = new Set<string>()
      for (const [stepId, a] of this.active) {
        if (a.done) continue
        a.done = true
        out.push({ type: 'step.done', stepId, state: 'cancelled', durationMs: this.o.now() - a.startedAt })
        if (a.deploymentRunId && !this.failedRuns.has(a.deploymentRunId)) runs.add(a.deploymentRunId)
      }
      for (const run of runs) out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'cancelled' })
      return out
    }
    const why = signal ? `Ansible was stopped (${signal}) before this step finished` : `Ansible exited with code ${exitCode} before this step finished`
    for (const [stepId, a] of this.active) {
      if (a.done) continue
      a.done = true
      out.push({ type: 'step.failed', stepId, error: this.line(why), durationMs: this.o.now() - a.startedAt })
      this.markFailed(a, out)
    }
    if ((exitCode !== 0 || signal) && out.length === 0 && !this.sawFailure) out.push(this.ansibleLog(signal ? `ansible-playbook was stopped (${signal})` : `ansible-playbook exited with code ${exitCode}`))
    return out
  }

  // ---- internals
  private ansibleLog(line: string): RunEventBody {
    return { type: 'log', stepId: this.current?.stepId || null, hostId: null, stream: 'ansible', line: this.line(line) }
  }

  private tagsOf(tags: string[] | undefined): { kind: string; run: string } | null {
    const kind = tags?.find((t) => t.startsWith('od_step='))?.slice(8)
    const run = tags?.find((t) => t.startsWith('od_run='))?.slice(7)
    return kind && run ? { kind, run } : null
  }

  private describe(kind: StepKind, run: string): { stepId: string; hostId: string | null; deploymentRunId: string | null; name: string; expected: number } {
    // a version tag is a release-level step: its failure never fails the deployment that is already up
    if (kind === 'version') return { stepId: 'release:version', hostId: null, deploymentRunId: null, name: STEP_LABEL.version, expected: this.versionTasks }
    const dep = this.depByRun.get(run)
    if (dep) {
      const expected = kind === 'health' ? Math.max(1, dep.urls.length) : 1
      return { stepId: `${run}:${kind}`, hostId: dep.hostId, deploymentRunId: run, name: `${STEP_LABEL[kind]} ${dep.name}`, expected }
    }
    if (run.startsWith('host:')) {
      const hostId = run.slice(5)
      return { stepId: `${run}:${kind}`, hostId, deploymentRunId: null, name: `${STEP_LABEL[kind]} ${this.hostById.get(hostId)?.label ?? hostId}`, expected: 1 }
    }
    return { stepId: `release:${kind}`, hostId: null, deploymentRunId: null, name: STEP_LABEL[kind], expected: 1 }
  }

  /** The lock task's mkdir/touch helper is part of the lock step, not a step of its own. */
  private internal(name: string): boolean {
    return name.startsWith('lock prep ')
  }

  private taskStart(name: string, tags: string[]): RunEventBody[] {
    const t = this.tagsOf(tags)
    if (!t || !STEP_KINDS.has(t.kind)) {
      this.current = t?.kind === 'preflight' ? { stepId: '', kind: 'record', run: t.run, name } : null
      return []
    }
    const kind = t.kind as StepKind
    const d = this.describe(kind, t.run)
    this.current = { stepId: d.stepId, kind, run: t.run, name }
    if (this.internal(name)) return []
    const out: RunEventBody[] = []
    this.begin(d, kind, out)
    return out
  }

  private begin(d: ReturnType<EventTranslator['describe']>, kind: StepKind, out: RunEventBody[]): Active {
    const known = this.active.get(d.stepId)
    if (known) return known
    const a: Active = { startedAt: this.o.now(), kind, deploymentRunId: d.deploymentRunId, hostId: d.hostId, seen: 0, expected: d.expected, done: false }
    this.active.set(d.stepId, a)
    out.push({ type: 'step.started', stepId: d.stepId, kind, name: d.name, hostId: d.hostId, deploymentRunId: d.deploymentRunId })
    if (d.deploymentRunId && (kind === 'record' || kind === 'rb_checkout')) {
      out.push({ type: 'deployment.updated', deploymentRunId: d.deploymentRunId, status: 'running' })
    }
    return a
  }

  private result(e: ResultEvent): RunEventBody[] {
    const t = this.tagsOf(e.tags)
    const out: RunEventBody[] = []
    const host = e.host ? this.hostByAlias.get(e.host) : undefined
    const hostLabel = host?.label ?? e.host ?? 'host'
    const hidden = e.no_log === true
    const msg = hidden || typeof e.msg !== 'string' ? '' : e.msg

    if (e.event === 'unreachable') {
      const error = this.line(`${hostLabel} is unreachable${msg ? `: ${msg}` : ''}`)
      if (t?.kind === 'preflight') {
        out.push({ type: 'preflight.check', check: this.reachCheck(host, error) })
        return out
      }
      if (t && STEP_KINDS.has(t.kind)) return this.failStep(t.kind as StepKind, t.run, error, out)
      out.push(this.ansibleLog(error))
      return out
    }
    if (!t) {
      // untagged: the rescue bookkeeping tasks. Only worth a line when it carries text.
      if (msg && e.event === 'failed') out.push(this.ansibleLog(msg))
      return out
    }
    if (t.kind === 'preflight') {
      this.collectPreflight(t.run, e)
      return out
    }
    if (!STEP_KINDS.has(t.kind)) return out
    const kind = t.kind as StepKind
    const d = this.describe(kind, t.run)
    const prep = this.internal(e.task ?? '')
    const a = prep ? null : this.begin(d, kind, out)

    const lines = hidden ? [] : this.splitOutput(e, d, out)
    const rc = typeof e.rc === 'number' ? e.rc : null
    if (e.event === 'skipped') {
      if (a) this.settle(d.stepId, a, { state: 'skipped' }, out)
      return out
    }
    if ((kind === 'tag' || kind === 'rb_tag') && a) {
      // best effort: the playbook never fails on tagging, so a failure arrives as the OD-TAG marker or a non-zero rc
      const note = this.tagNote
      this.tagNote = null
      const tagRc = note !== null ? Number(/rc=(\d+)/.exec(note)?.[1] ?? 1) : rc
      if (note !== null || (e.event === 'ok' && rc !== null && rc !== 0)) {
        a.done = true
        const text = this.errorText(kind, d.name, tagRc, msg, lines.slice(-ERROR_CONTEXT_LINES), hidden)
        out.push({ type: 'step.done', stepId: d.stepId, state: 'warn', durationMs: this.o.now() - a.startedAt, message: text })
        this.onDone(a, out)
        return out
      }
    }
    if (e.event === 'failed' && e.ignored !== true) {
      const ctx = lines.slice(-ERROR_CONTEXT_LINES)
      return this.failStep(kind, t.run, this.errorText(kind, d.name, rc, msg, ctx, hidden), out, lines, rc)
    }
    if (a) this.settle(d.stepId, a, { state: 'ok', message: this.prevNote(kind, t.run) }, out)
    return out
  }

  private prevNote(kind: StepKind, run: string): string | undefined {
    return kind === 'record' && this.unknownPrevious.has(run) ? 'The previous commit could not be read from origin' : undefined
  }

  /** Counts a finished task toward its step; the step closes once all its tasks are in. */
  private settle(stepId: string, a: Active, r: { state: 'ok' | 'skipped'; message?: string }, out: RunEventBody[]): void {
    if (a.done) return
    a.seen++
    if (a.seen < a.expected && r.state === 'ok') return
    a.done = true
    const warn = r.state === 'ok' && r.message !== undefined
    out.push({ type: 'step.done', stepId, state: warn ? 'warn' : r.state, durationMs: this.o.now() - a.startedAt, ...(r.message ? { message: this.line(r.message) } : {}) })
    if (r.state === 'ok') this.onDone(a, out)
  }

  /** Release: the tag step finishing makes the deployment succeeded. Rollback: rb_tag makes it rolled back. */
  private onDone(a: Active, out: RunEventBody[]): void {
    if (!a.deploymentRunId || this.failedRuns.has(a.deploymentRunId)) return
    if (a.kind === 'tag') out.push({ type: 'deployment.updated', deploymentRunId: a.deploymentRunId, status: 'succeeded' })
    if (a.kind === 'rb_tag') out.push({ type: 'deployment.updated', deploymentRunId: a.deploymentRunId, status: 'rolled_back' })
  }

  private markFailed(a: Active, out: RunEventBody[]): void {
    this.sawFailure = true
    if (!a.deploymentRunId) return
    this.failedRuns.add(a.deploymentRunId)
    out.push({ type: 'deployment.updated', deploymentRunId: a.deploymentRunId, status: a.kind.startsWith('rb_') ? 'rollback_failed' : 'failed' })
  }

  private failStep(kind: StepKind, run: string, error: string, out: RunEventBody[], lines: string[] = [], rc: number | null = null): RunEventBody[] {
    const d = this.describe(kind, run)
    const a = this.active.get(d.stepId) ?? this.begin(d, kind, out)
    if (a.done) return out
    a.done = true
    const dur = this.o.now() - a.startedAt
    // tagging is best effort: the deploy already happened
    if (kind === 'tag' || kind === 'rb_tag') {
      out.push({ type: 'step.done', stepId: d.stepId, state: 'warn', durationMs: dur, message: error })
      this.onDone(a, out)
      return out
    }
    if (kind === 'lock' && rc === RC_LOCK_BUSY) {
      const busy = this.lockBusy(d.hostId, lines)
      if (busy) {
        out.push(busy.event)
        error = busy.error
      }
    }
    if (kind === 'unlock' && rc === RC_BREAK_KEPT) error = this.line('The lock changed since the check, so it was not removed')
    out.push({ type: 'step.failed', stepId: d.stepId, error, durationMs: dur })
    this.markFailed(a, out)
    return out
  }

  private errorText(kind: StepKind, name: string, rc: number | null, msg: string, ctx: string[], hidden: boolean): string {
    const base = hidden
      ? `${name} failed (output hidden)`
      : rc !== null && rc !== 0
        ? `${name} failed with exit code ${rc}${msg && msg !== 'non-zero return code' ? `: ${msg}` : ''}`
        : `${name} failed${msg ? `: ${msg}` : ''}`
    const text = ctx.length ? `${base}\n${ctx.join('\n')}` : base
    return this.red(text).slice(0, MAX_ERROR)
  }

  private redHolder(h: LockHolder): LockHolder {
    return { ...h, releaseId: this.red(h.releaseId), user: this.red(h.user), machine: this.red(h.machine), environment: this.red(h.environment), version: h.version === null ? null : this.red(h.version) }
  }

  private lockBusy(hostId: string | null, lines: string[]): { event: RunEventBody; error: string } | null {
    if (!hostId) return null
    // the busy repo is the last lock line printed before exit 42
    const last = [...lines].reverse().find((l) => parseMarker(l)?.mark === MARK.LOCK)
    const raw = last ? (parseMarker(last)?.rest ?? '') : ''
    const holder = parseHolder(raw)
    const startedAt = Date.parse(holder.startedAt)
    const stale = Number.isFinite(startedAt) && this.o.now() - startedAt > LOCK_STALE_MS
    const text = this.line(lockHolderText(holder, this.o.now()))
    const label = this.hostById.get(hostId)?.label ?? hostId
    return {
      event: { type: 'lock.busy', hostId, holder: this.redHolder(holder), stale, text },
      error: this.line(`${label} is locked: ${text}`),
    }
  }

  /** stdout / stderr into log events and markers. Returns the (raw, unredacted) lines for error context. */
  private splitOutput(e: ResultEvent, d: ReturnType<EventTranslator['describe']>, out: RunEventBody[]): string[] {
    const ctx: string[] = []
    const emit = (stream: 'out' | 'err', text: string | undefined): void => {
      if (!text) return
      for (const raw of text.split('\n')) {
        const l = raw.replace(/\r$/, '')
        if (l === '') continue
        const s = parseStreamLine(l)
        if (s && `${s.runId}:${s.kind}` === d.stepId) {
          // the tail of the step's own stream.log lines: error context only, the log tap already delivers them
          ctx.push(s.text)
          continue
        }
        const marker = stream === 'out' ? parseMarker(l) : null
        if (marker && this.marker(marker.mark, marker.rest, d, out)) {
          if (marker.mark === MARK.LOCK) ctx.push(l)
          continue
        }
        ctx.push(l)
        out.push({ type: 'log', stepId: d.stepId, hostId: d.hostId, stream, line: this.line(l) })
      }
    }
    emit('out', e.stdout)
    emit('err', e.stderr)
    if (e.truncated?.length) out.push({ type: 'log', stepId: d.stepId, hostId: d.hostId, stream: 'ansible', line: `Output of this step was cut (${e.truncated.join(', ')})` })
    return ctx
  }

  /** Returns true when the marker was consumed (no log line). */
  private marker(mark: string, rest: string, d: ReturnType<EventTranslator['describe']>, out: RunEventBody[]): boolean {
    const run = d.deploymentRunId
    if (mark === MARK.PREV && run) {
      const p = parsePrev(rest)
      if (p?.kind === 'sha') out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', previousCommit: p.sha })
      else if (p?.kind === 'unknown') this.unknownPrevious.add(run)
      return true
    }
    if (mark === MARK.HEAD && run) {
      const sha = rest.trim()
      if (/^[0-9a-f]{40}$/.test(sha) && d.stepId.endsWith(':checkout')) out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', deployedCommit: sha })
      return d.stepId.endsWith(':checkout') || d.stepId.endsWith(':rb_checkout')
    }
    if (mark === MARK.BACKUP && run) {
      const file = rest.trim()
      if (file) out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', backupFile: this.red(file) })
      return true
    }
    if (mark === MARK.TAG) {
      this.tagNote = rest
      return true
    }
    // lock lines carry the holder; the busy one is read from the failed result
    return mark === MARK.LOCK
  }

  // ---- preflight
  private collectPreflight(run: string, e: ResultEvent): void {
    if (e.no_log) return
    if (e.truncated?.includes('stdout')) this.pfCut.add(run)
    if (typeof e.stdout === 'string' && e.stdout) {
      const list = this.pf.get(run) ?? []
      list.push(e.stdout)
      this.pf.set(run, list)
    }
  }

  private reachCheck(host: PlanHost | undefined, error: string): PreflightCheck {
    return { id: 'reachable', deploymentId: null, hostId: host?.hostId ?? '', label: host?.label ?? '', level: 'block', message: error }
  }
}

function parseHolder(raw: string): LockHolder {
  const unknown: LockHolder = { releaseId: '', user: 'unknown', machine: 'unknown', environment: '', version: null, startedAt: '' }
  try {
    const j = JSON.parse(raw) as Partial<LockHolder>
    if (typeof j !== 'object' || j === null) return unknown
    return {
      releaseId: typeof j.releaseId === 'string' ? j.releaseId : '',
      user: typeof j.user === 'string' ? j.user : 'unknown',
      machine: typeof j.machine === 'string' ? j.machine : 'unknown',
      environment: typeof j.environment === 'string' ? j.environment : '',
      version: typeof j.version === 'string' ? j.version : null,
      startedAt: typeof j.startedAt === 'string' ? j.startedAt : '',
    }
  } catch {
    return unknown
  }
}

// ---------------------------------------------------------------- preflight report

const GB = 1024 * 1024
const gb = (kb: number): string => String(Number((kb / GB).toFixed(1)))

function decodeCommits(b64: string, deploymentId: string, cutOff: boolean, red: (s: string) => string): { commits: CommitInfo[]; cut: boolean } {
  let text = Buffer.from(b64, 'base64').toString('utf8')
  // records end with \x1e; a cut line may stop mid-record, so only complete records are used
  const end = text.lastIndexOf('\x1e')
  text = end < 0 ? '' : text.slice(0, end + 1)
  const commits: CommitInfo[] = []
  for (const rec of text.split('\x1e')) {
    const r = rec.replace(/^\n+/, '')
    if (!r) continue
    const [sha, subject, author, date] = r.split('\x1f')
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || subject === undefined || author === undefined || date === undefined) continue
    commits.push({ sha, subject: red(subject), author: red(author), date, deploymentId })
  }
  return { commits, cut: cutOff }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * For each selected service, the services it depends on that are neither running nor selected (an up of
 * the selection starts those itself). `configJson` is `docker compose config --format json`; `psJson` is
 * `docker compose ps --status running --format json`, an array or one object per line. Throws on input it
 * can't read; only services with something missing are returned.
 */
export function parseDeps(configJson: string, psJson: string, selected: string[]): { service: string; missing: string[] }[] {
  const config: unknown = JSON.parse(configJson)
  if (!isObj(config) || !isObj(config.services)) throw new Error('compose config has no services')
  const services = config.services
  const ps = psJson.trim()
  const rows: unknown[] = !ps ? [] : ps.startsWith('[') ? (JSON.parse(ps) as unknown[]) : ps.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown)
  if (!Array.isArray(rows)) throw new Error('compose ps is not a list')
  const running = new Set(rows.flatMap((r) => (isObj(r) && typeof r.Service === 'string' ? [r.Service] : [])))
  const chosen = new Set(selected)
  const out: { service: string; missing: string[] }[] = []
  for (const service of selected) {
    const svc = services[service]
    const dep = isObj(svc) ? svc.depends_on : undefined
    const names = Array.isArray(dep) ? dep.filter((x): x is string => typeof x === 'string') : isObj(dep) ? Object.keys(dep) : []
    const missing = names.filter((n) => !running.has(n) && !chosen.has(n))
    if (missing.length) out.push({ service, missing })
  }
  return out
}

/** "a", "a and b", "a, b and c". */
const andList = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The compose file's services from `services_b64`; null when absent, empty or any name is not a service name. */
function decodeServices(b64: string | undefined): string[] | null {
  if (!b64) return null
  const names = Buffer.from(b64, 'base64').toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  return names.length && names.every((n) => COMPOSE_SERVICE.test(n)) ? names : null
}

export interface ParsePreflightOptions {
  now: number
  /** Run keys whose output the callback plugin cut (EventTranslator.preflightCut()). */
  cut?: string[]
  secrets?: string[]
}

/**
 * Builds the preflight report from the OD-PF lines of each run's stdout. A check whose lines are missing is
 * never reported as clean: a missing repo blocks, and anything else that printed nothing blocks as "no result".
 */
export function parsePreflight(plan: DeployPlan, stdoutByRun: Record<string, string>, o: ParsePreflightOptions): Omit<PreflightReport, 'releaseId'> {
  const checks: PreflightCheck[] = []
  const commits: PreflightReport['commits'] = {}
  const dockerModes: Record<string, DockerMode> = {}
  const composeServices: PreflightReport['composeServices'] = Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, null]))
  const locks: PreflightReport['locks'] = {}
  const red = (s: string): string => redact(s, o.secrets ?? [])
  const cutRuns = new Set(o.cut ?? [])
  const hostById = new Map(plan.hosts.map((h) => [h.hostId, h]))

  const linesOf = (run: string): { check: string; fields: Record<string, string> }[] =>
    (stdoutByRun[run] ?? '')
      .split('\n')
      .map((l) => parseMarker(l.replace(/\r$/, '')))
      .filter((m): m is NonNullable<typeof m> => m !== null && m.mark === MARK.PF)
      .flatMap((m) => parsePfLine(m.rest) ?? [])

  let commitsTotal = 0
  for (const d of plan.deployments) {
    const host = hostById.get(d.hostId)
    const hl = host?.label ?? d.hostId
    const all = linesOf(d.runId)
    const get = (c: string): Record<string, string> | undefined => all.find((l) => l.check === c)?.fields
    const add = (id: string, level: PreflightCheck['level'], message: string): void => {
      checks.push({ id, deploymentId: d.deploymentId, hostId: d.hostId, label: `${d.name}`, level, message: red(message) })
    }
    const noResult = (id: string, what: string): void => add(id, 'block', `${what} gave no result on ${hl}`)

    // tools
    const tools = get('tools')
    if (!tools) noResult('tools', 'The tools check')
    else if (tools.missing) add('tools', 'block', `missing tools on ${hl}: ${tools.missing.split(',').join(', ')}`)
    else add('tools', 'ok', `git, docker and curl are available on ${hl}`)

    // docker
    const dk = all.find((l) => l.check === 'docker' && l.fields.become === undefined)?.fields
    const become = all.find((l) => l.check === 'docker' && l.fields.become !== undefined)?.fields
    if (!dk) noResult('docker', 'The docker check')
    else if (dk.use !== 'yes' && dk.plain === 'ok') {
      dockerModes[d.deploymentId] = 'plain'
      add('docker', 'ok', `docker works without sudo on ${hl}`)
    } else if (dk.use !== 'no' && dk.sudo === 'ok') {
      dockerModes[d.deploymentId] = 'sudo'
      add('docker', 'ok', `docker works with sudo on ${hl}`)
    } else if (become?.become === 'ok') {
      dockerModes[d.deploymentId] = 'sudo-password'
      add('docker', 'ok', `docker works with the sudo password on ${hl}`)
    } else if (become) add('docker', 'block', `docker needs sudo on ${hl} and the sudo password did not work`)
    else if (dk.use === 'no') add('docker', 'block', `docker is not usable on ${hl} and sudo is turned off for ${d.name}`)
    else add('docker', 'block', `docker needs sudo on ${hl} and no sudo password is set`)

    // repo; the checks that run inside it print nothing when it is missing
    const repo = get('repo')
    let repoOk = false
    if (!repo) noResult('repo', 'The repository check')
    else if (repo.exists !== '1') add('repo', 'block', `${d.repoPath} does not exist on ${hl}`)
    else if (repo.git !== '1') add('repo', 'block', `${d.repoPath} is not a git repository on ${hl}`)
    else {
      repoOk = true
      add('repo', 'ok', `${d.repoPath} is a git repository`)
    }

    if (repoOk) {
      const clean = get('clean')
      if (!clean) noResult('clean', 'The clean check')
      else if (clean.ok === '1') add('clean', 'ok', `${d.repoPath} has no uncommitted changes`)
      else {
        const n = Number(clean.files)
        add('clean', 'block', `${d.repoPath} has uncommitted changes${Number.isInteger(n) && n > 0 ? ` (${n} file${n === 1 ? '' : 's'})` : ''}`)
      }

      const br = get('branch')
      if (!br) noResult('branch', 'The branch check')
      else if (br.exists !== '1') add('branch', 'block', `branch ${d.branch} not found on origin`)
      else if (br.fetched !== '1') add('branch', 'warn', `could not fetch branch ${d.branch} from origin on ${hl}; using the last fetched copy`)
      else add('branch', 'ok', `branch ${d.branch} is up to date`)

      const cp = get('compose')
      if (!cp) noResult('compose', 'The compose check')
      else if (cp.exists !== '1') add('compose', 'block', `compose file ${d.composeFile} not found in ${d.repoPath}`)
      else {
        add('compose', 'ok', `${d.composeFile} exists`)
        composeServices[d.deploymentId] = decodeServices(cp.services_b64)
        // partial checkouts: a warning for what --no-deps leaves stopped, never a block
        if (d.services !== null) {
          const dp = get('deps')
          let found: { service: string; missing: string[] }[] | null = null
          try {
            if (dp?.config_b64) found = parseDeps(Buffer.from(dp.config_b64, 'base64').toString('utf8'), Buffer.from(dp.ps_b64 ?? '', 'base64').toString('utf8'), d.services)
          } catch {
            found = null
          }
          if (found === null) add('deps', 'warn', `Couldn't check compose dependencies on ${hl}`)
          else
            for (const f of found) {
              const one = f.missing.length === 1
              add('deps', 'warn', `${f.service} depends on ${andList(f.missing)}, which ${one ? "isn't" : "aren't"} running. --no-deps won't start ${one ? 'it' : 'them'}`)
            }
        }
      }

      const disk = get('disk')
      const kb = disk ? Number(disk.avail_kb) : NaN
      if (!disk || !Number.isFinite(kb)) noResult('disk', 'The disk check')
      else if (kb < DISK_WARN_KB) add('disk', 'warn', `only ${gb(kb)} GB free on ${hl} (warning below ${gb(DISK_WARN_KB)} GB)`)
      else add('disk', 'ok', `${gb(kb)} GB free on ${hl}`)

      const tag = get('tag')
      const cm = all.find((l) => l.check === 'commits')?.fields
      let firstDeploy = false
      let tagUnknown = false
      if (!tag) noResult('tag', 'The deploy tag check')
      else if (tag.exists === 'unknown') {
        tagUnknown = true
        add('tag', 'block', `could not read tag ${d.deployTag} from origin (network or access problem)`)
      } else if (tag.exists === '1') add('tag', 'ok', `last deployed commit ${(tag.commit ?? '').slice(0, 7)}`)
      else {
        firstDeploy = true
        add('tag', 'ok', `no previous deploy (${d.deployTag} not found): first deploy`)
      }

      let list: CommitInfo[] = []
      let hidden = 0
      let truncated = 0
      let newest: string | null = null
      if (!cm) {
        if (!tagUnknown) noResult('commits', 'The commit list')
      } else if ('unknown' in cm) {
        add('commits', 'block', `could not list the commits to deploy on ${hl}: origin was unreachable`)
      } else if (typeof cm.log_b64 === 'string') {
        const dec = decodeCommits(cm.log_b64, d.deploymentId, cutRuns.has(d.runId), red)
        const f = filterReverts(dec.commits)
        newest = dec.commits[0]?.sha ?? null
        hidden = f.hiddenPairs
        truncated = Math.max(0, f.kept.length - MAX_COMMITS)
        list = f.kept.slice(0, MAX_COMMITS)
        if (dec.cut) truncated = Math.max(truncated, 1)
        if (truncated > 0) add('commits', 'warn', `the commit list is not complete (at least ${truncated} more not shown); showing the newest ${list.length}`)
      }
      commitsTotal += list.length
      commits[d.deploymentId] = { commits: list, hiddenPairs: hidden, truncated, firstDeploy, head: newest }
    }
  }

  // the version tag is checked in every repo; one existing tag blocks, none readable blocks too
  if (plan.version !== null) {
    const seen = plan.deployments.flatMap((d) => {
      const f = linesOf(d.runId).find((l) => l.check === 'version-tag')?.fields
      return f ? [{ d, exists: f.exists }] : []
    })
    const taken = seen.find((x) => x.exists === '1')
    const base = { id: 'version-tag', deploymentId: null, hostId: '', label: plan.environment.name }
    if (taken) checks.push({ ...base, deploymentId: taken.d.deploymentId, hostId: taken.d.hostId, label: taken.d.name, level: 'block', message: red(`Tag ${plan.version} already exists in ${taken.d.name}`) })
    else if (seen.length) checks.push({ ...base, level: 'ok', message: `${plan.version} is free` })
    else if (plan.deployments.every((d) => commits[d.deploymentId] !== undefined)) checks.push({ ...base, level: 'block', message: 'The version tag check gave no result' })
  }

  // locks: one OD-PF line per repo of each host
  for (const h of plan.hosts) {
    const lines = linesOf(`host:${h.hostId}`).filter((l) => l.check === 'lock')
    const held = lines.filter((l) => l.fields.held === '1')
    const add = (level: PreflightCheck['level'], message: string): void => {
      checks.push({ id: 'lock', deploymentId: null, hostId: h.hostId, label: h.label, level, message: red(message) })
    }
    if (lines.length === 0) {
      locks[h.hostId] = null
      add('block', `the lock check gave no result on ${h.label}`)
    } else if (held.length === 0) {
      locks[h.hostId] = null
      add('ok', `${h.label} is not locked`)
    } else {
      const one = held[0]
      const rawText = Buffer.from(one.fields.raw_b64 ?? '', 'base64').toString('utf8')
      const holder = parseHolder(rawText)
      const at = Date.parse(holder.startedAt)
      const stale = Number.isFinite(at) && o.now - at > LOCK_STALE_MS
      const safe: LockHolder = { ...holder, releaseId: red(holder.releaseId), user: red(holder.user), machine: red(holder.machine), environment: red(holder.environment), version: holder.version === null ? null : red(holder.version) }
      locks[h.hostId] = { holder: safe, stale, raw: rawText }
      add('block', `${red(lockHolderText(holder, o.now))}${stale ? ' (older than 2 hours; it may be stale and can be broken)' : ''}`)
    }
  }

  return { checks, commits, dockerModes, composeServices, locks, commitsTotal, blocked: checks.some((c) => c.level === 'block') }
}
