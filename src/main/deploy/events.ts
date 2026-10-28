import {
  COMPOSE_SERVICE,
  type CommitInfo,
  DISK_WARN_KB,
  LOCK_STALE_MS,
  LOCK_STALE_NOTE,
  type LockHolder,
  MAX_COMMITS,
  MAX_LOG_LINE,
  type DockerMode,
  type PreflightCheck,
  type PreflightReport,
  RESTORE_FIRST_NOTE,
  type RunEventBody,
  STEP_LABEL,
  type StepKind,
  type TaskState,
  filterReverts,
  lockHolderText,
  REPO_PATH,
} from '../../shared/deploy'
import { isHelperTask } from '../../shared/playbook-steps'
import { redact } from '../security/redact'
import { planSteps, stepList } from './generate'
import { operationSteps } from './generate-ops'
import { withBase64Forms } from './mask'
import { MARK, RC_BREAK_KEPT, RC_LOCK_BUSY, parseMarker, parsePfLine, parsePrev, parseStreamLine } from './markers'
import type { DeployPlan, PlanDeployment, PlanHost, PlanStep, RunnerPreflight } from './runner'

export { parseStreamLine }

const MAX_ERROR = 4000
const ERROR_CONTEXT_LINES = 8

interface ResultEvent {
  event: 'ok' | 'failed' | 'skipped' | 'unreachable'
  host?: string
  task?: string
  tags?: string[]
  rc?: number | null
  changed?: boolean
  attempts?: number | null
  stdout?: string
  stderr?: string
  msg?: string
  no_log?: boolean
  truncated?: string[]
  ignored?: boolean
}

interface Active {
  startedAt: number
  stepId: string
  kind: StepKind
  /** The task's `od_step` tag: the kind, or `c_<n>` for a custom step. */
  key: string
  deploymentRunId: string | null
  hostId: string | null
  seen: number
  expected: number
  done: boolean
}

/** A step as a task's tag names it. */
interface Ref {
  kind: StepKind
  key: string
}
type Desc = Ref & { stepId: string; hostId: string | null; deploymentRunId: string | null; name: string; expected: number }
type StepNote = { state: 'skipped' } | { state: 'warn'; rc: number }

const CUSTOM_KEY = /^c_\d{1,3}$/
/** A runbook built-in's key: `op_<builtin>`, with `_<n>` for a repeat (generate-ops.ts). */
const OP_KEY = /^op_[a-z0-9_]{1,29}$/
const STEP_KINDS = new Set<string>(Object.keys(STEP_LABEL))
const cut = (s: string): string => (s.length > MAX_LOG_LINE ? `${s.slice(0, MAX_LOG_LINE - 7)} …(cut)` : s)

/** Turns the callback plugin's JSON lines into run events, redacting every string that leaves. */
export class EventTranslator {
  private readonly depByRun = new Map<string, PlanDeployment>()
  private readonly hostByAlias = new Map<string, PlanHost>()
  private readonly hostById = new Map<string, PlanHost>()
  /** Open steps, keyed `${hostId}|${stepId}` so hosts of one play keep separate state. */
  private readonly active = new Map<string, Active>()
  private readonly failedRuns = new Set<string>()
  private readonly pf = new Map<string, string[]>()
  private readonly pfCut = new Set<string>()
  /** Per preflight run key, the error of each check task that failed outright (no stdout to parse). */
  private readonly pfErr = new Map<string, Map<string, string>>()
  /** Per preflight run key, the checks whose task ansible skipped. */
  private readonly pfSkip = new Map<string, Set<string>>()
  /** The play ansible last started, and the first "no hosts" stop it reported. */
  private play = ''
  private noHosts: string | null = null
  /** Host names ansible reported results for that the plan has no alias for (each is logged once). */
  private readonly strangers = new Set<string>()
  private readonly rescuedBy = new Map<string, number>()
  private readonly unknownPrevious = new Set<string>()
  /** When each task (by name) last started, for its task.done duration. */
  private readonly taskBegan = new Map<string, number>()
  /** The step each host last started (a task_start carries no host, so it is the host of the task's run). */
  private readonly currentStep = new Map<string, string>()
  private lastStep: string | null = null
  private sawFailure = false
  /** OD-TAG failures and custom step markers, by `${hostId}|${stepId}`. */
  private readonly tagNotes = new Map<string, string>()
  /** A prepare restore's OD-RESTORE line (`ok <sha>`, `first`, `failed rc=<n>`), by step. */
  private readonly restoreNotes = new Map<string, string>()
  private readonly stepNotes = new Map<string, StepNote>()
  /** `${run}:c_<n>` of the custom steps that have a `when`. */
  private readonly hasWhen = new Set<string>()
  /** No_log custom steps with a `when` that returned ok with no marker yet, waiting for a late OD-SKIP. */
  private readonly pending: Active[] = []
  /** `${run}:c_<n>` -> the PlanStep label; `${run}:op_<..>` -> the built-in's name. */
  private readonly customLabel = new Map<string, string>()
  /** Operation runs whose first step has started (that start is the run's start). */
  private readonly opStarted = new Set<string>()
  /** Run id -> the key of the last step of its block. */
  private readonly lastKey = new Map<string, string>()
  /** Run id -> how many up tasks a flow gives it (one per services part); absent means one. */
  private readonly ups = new Map<string, number>()
  private readonly versionTasks: number

  constructor(private readonly o: { plan: DeployPlan; secrets: () => string[]; now: () => number }) {
    for (const d of o.plan.deployments) this.depByRun.set(d.runId, d)
    this.readSteps(o.plan)
    // one version task per repo on each host (the generator skips repeats)
    this.versionTasks = Math.max(1, new Set(o.plan.deployments.map((d) => `${d.hostId}\n${d.repoPath}`)).size)
    for (const h of o.plan.hosts) {
      this.hostByAlias.set(h.alias, h)
      this.hostById.set(h.hostId, h)
    }
  }

  private readSteps(plan: DeployPlan): void {
    if (plan.kind === 'operation') return this.readOperation(plan)
    const flow = plan.kind === 'release' ? (plan.flow ?? null) : null
    for (const st of flow?.stages ?? []) {
      if (st.kind === 'step') {
        this.customLabel.set(`${st.runId}:${st.step.key}`, st.step.label)
        if (st.step.step.when.kind !== 'always') this.hasWhen.add(`${st.runId}:${st.step.key}`)
      } else for (const p of st.parts) this.ups.set(p.runId, (this.ups.get(p.runId) ?? 0) + 1)
    }
    for (const d of plan.deployments) {
      let steps: PlanStep[]
      try {
        steps = planSteps(d)
      } catch {
        continue
      }
      for (const p of steps) {
        this.customLabel.set(`${d.runId}:${p.key}`, p.label)
        if (p.step.when.kind !== 'always') this.hasWhen.add(`${d.runId}:${p.key}`)
      }
      if (plan.kind !== 'release' && plan.kind !== 'rollback') continue
      let list: { key: string }[] = []
      try {
        list = stepList(plan.kind, [{ ...d, steps }], flow).get(d.runId) ?? []
      } catch {
        continue
      }
      const last = list.at(-1)
      if (last) this.lastKey.set(d.runId, last.key)
    }
  }

  /** An operation's rows per target, as generate-ops tags them; a target succeeds on its last row. */
  private readOperation(plan: DeployPlan): void {
    const op = plan.operation
    if (!op) return
    const seenHost = new Set<string>()
    for (const t of op.targets) {
      const d = this.depByRun.get(t.runId)
      if (!d) continue
      const first = !seenHost.has(d.hostId)
      seenHost.add(d.hostId)
      const list = operationSteps(op.items, first)
      for (const x of list) if (x.kind === 'custom' || x.kind === 'op') this.customLabel.set(`${t.runId}:${x.key}`, x.label)
      const last = list.at(-1)
      if (last) this.lastKey.set(t.runId, last.key)
    }
  }

  // ---- results other code reads
  /** Raw stdout of the preflight tasks, keyed by `od_run` (a deployment run id, or `host:<hostId>`). */
  preflightOutput(): Record<string, string> {
    return Object.fromEntries([...this.pf].map(([k, v]) => [k, v.join('\n')]))
  }
  /** Runs whose preflight commits output the plugin cut at its cap. */
  preflightCut(): string[] {
    return [...this.pfCut]
  }
  /** Per run key, the preflight checks whose task ansible skipped. */
  preflightSkipped(): Record<string, string[]> {
    return Object.fromEntries([...this.pfSkip].map(([k, v]) => [k, [...v]]))
  }
  /** Why ansible ran no tasks on some host: the first play that matched no hosts or ran out of them. */
  noHostsReason(): string | null {
    return this.noHosts
  }
  /** Per run key, check name to the (redacted) error of a preflight task that failed outright. */
  preflightErrors(): Record<string, Record<string, string>> {
    return Object.fromEntries([...this.pfErr].map(([k, v]) => [k, Object.fromEntries(v)]))
  }
  /** Hosts that had rescued failures (a rollback step failing is rescued so the run continues), with the count. */
  rescued(): Record<string, number> {
    return Object.fromEntries(this.rescuedBy)
  }
  /** Deployment runs whose previous commit could not be read from origin (never a first deploy). */
  previousUnknown(): string[] {
    return [...this.unknownPrevious]
  }

  /** Every secret, plus its base64 forms (mask.ts's), so an event is stored without either. */
  private forms(): string[] {
    const known = this.o.secrets()
    // the caller hands over the same array for the whole run, so the forms are built once
    if (this.formsFor !== known) {
      this.formsFor = known
      this.formsCache = withBase64Forms(known.filter((x) => x !== ''))
    }
    return this.formsCache
  }
  private formsFor: string[] | null = null
  private formsCache: string[] = []

  private red(s: string): string {
    return redact(s, this.forms())
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
      case 'play_start':
        this.play = this.line(String(e.name ?? ''))
        return []
      case 'no_hosts': {
        const play = this.play ? `the play ${this.play}` : 'a play'
        const text = e.why === 'matched' ? `ansible matched no hosts for ${play}` : `ansible stopped ${play}: no hosts are left to run on`
        this.noHosts ??= text
        return [this.ansibleLog(text)]
      }
      default:
        return []
    }
  }

  /** Called when ansible exits: closes steps that never finished. */
  finish(exitCode: number | null, signal: string | null, cancelled = false): RunEventBody[] {
    const out: RunEventBody[] = this.flush(null)
    if (cancelled) {
      // a cancel is not a failure: running steps and their deployments close as cancelled
      const runs = new Set<string>()
      for (const a of this.active.values()) {
        if (a.done) continue
        a.done = true
        out.push({ type: 'step.done', stepId: a.stepId, state: 'cancelled', durationMs: this.o.now() - a.startedAt })
        if (a.deploymentRunId && !this.failedRuns.has(a.deploymentRunId)) runs.add(a.deploymentRunId)
      }
      for (const run of runs) out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'cancelled' })
      return out
    }
    const why = signal ? `Ansible was stopped (${signal}) before this step finished` : `Ansible exited with code ${exitCode} before this step finished`
    for (const a of this.active.values()) {
      if (a.done) continue
      a.done = true
      out.push({ type: 'step.failed', stepId: a.stepId, error: this.line(why), durationMs: this.o.now() - a.startedAt })
      this.markFailed(a, out)
    }
    if ((exitCode !== 0 || signal) && out.length === 0 && !this.sawFailure) out.push(this.ansibleLog(signal ? `ansible-playbook was stopped (${signal})` : `ansible-playbook exited with code ${exitCode}`))
    return out
  }

  // ---- internals
  private ansibleLog(line: string, hostId: string | null = null): RunEventBody {
    const stepId = (hostId === null ? this.lastStep : (this.currentStep.get(hostId) ?? null)) || null
    return { type: 'log', stepId, hostId: null, stream: 'ansible', line: this.line(line) }
  }

  private tagsOf(tags: string[] | undefined): { kind: string; run: string } | null {
    const kind = tags?.find((t) => t.startsWith('od_step='))?.slice(8)
    const run = tags?.find((t) => t.startsWith('od_run='))?.slice(7)
    return kind && run ? { kind, run } : null
  }

  /** A task's `od_step` tag as a step: a built-in kind, or `c_<n>` for a custom step. */
  private ref(tagKind: string): Ref | null {
    if (CUSTOM_KEY.test(tagKind)) return { kind: 'custom', key: tagKind }
    if (OP_KEY.test(tagKind)) return { kind: 'op', key: tagKind }
    return tagKind !== 'custom' && STEP_KINDS.has(tagKind) ? { kind: tagKind as StepKind, key: tagKind } : null
  }

  /** The host a run's tasks belong to; null for a release-level run. */
  private runHost(run: string): string | null {
    const dep = this.depByRun.get(run)
    if (dep) return dep.hostId
    return run.startsWith('host:') ? run.slice(5) : null
  }

  /** True when the result came from another host than the one the task's run belongs to (a multi-host play). */
  private foreign(e: ResultEvent, run: string): boolean {
    const own = this.runHost(run)
    const alias = own === null ? undefined : this.hostById.get(own)?.alias
    return alias !== undefined && e.host !== undefined && e.host !== alias
  }

  private describe(r: Ref, run: string): Desc {
    const { kind } = r
    // a version tag is a release-level step: its failure never fails the deployment that is already up
    if (kind === 'version') return { ...r, stepId: 'release:version', hostId: null, deploymentRunId: null, name: STEP_LABEL.version, expected: this.versionTasks }
    const dep = this.depByRun.get(run)
    const label = kind === 'custom' || kind === 'op' ? this.labelOf(run, r.key) : STEP_LABEL[kind]
    if (dep) {
      const expected = kind === 'health' || kind === 'rb_health' ? Math.max(1, dep.urls.length) : kind === 'up' ? (this.ups.get(run) ?? 1) : 1
      return { ...r, stepId: `${run}:${r.key}`, hostId: dep.hostId, deploymentRunId: run, name: kind === 'custom' ? label : `${label} ${dep.name}`, expected }
    }
    if (run.startsWith('host:')) {
      const hostId = run.slice(5)
      return { ...r, stepId: `${run}:${r.key}`, hostId, deploymentRunId: null, name: `${label} ${this.hostById.get(hostId)?.label ?? hostId}`, expected: 1 }
    }
    return { ...r, stepId: `release:${r.key}`, hostId: null, deploymentRunId: null, name: label, expected: 1 }
  }

  /** A custom step's own name (the PlanStep label); its key when the plan has no such step. */
  private labelOf(run: string, key: string): string {
    return this.customLabel.get(`${run}:${key}`) ?? key
  }

  private akey(d: Desc): string {
    return `${d.hostId ?? ''}|${d.stepId}`
  }

  /** The lock task's mkdir/touch helper is part of the lock step, not a step of its own. */
  private internal(name: string): boolean {
    return isHelperTask(name)
  }

  private taskStart(name: string, tags: string[]): RunEventBody[] {
    this.taskBegan.set(name, this.o.now())
    const t = this.tagsOf(tags)
    const r = t ? this.ref(t.kind) : null
    if (!t || !r) {
      if (t) this.currentStep.delete(this.runHost(t.run) ?? '')
      this.lastStep = null
      return []
    }
    const d = this.describe(r, t.run)
    this.currentStep.set(d.hostId ?? '', d.stepId)
    this.lastStep = d.stepId
    // A build's async launch starts the build step (its time counts) but never settles it: its async_status poll does.
    if (this.internal(name) && !name.startsWith('build launch ')) return []
    const out: RunEventBody[] = []
    this.begin(d, out)
    return out
  }

  private begin(d: Desc, out: RunEventBody[]): Active {
    const known = this.active.get(this.akey(d))
    if (known) return known
    const a: Active = { startedAt: this.o.now(), stepId: d.stepId, kind: d.kind, key: d.key, deploymentRunId: d.deploymentRunId, hostId: d.hostId, seen: 0, expected: d.expected, done: false }
    this.active.set(this.akey(d), a)
    out.push({ type: 'step.started', stepId: d.stepId, kind: d.kind, name: d.kind === 'custom' ? this.line(d.name) : d.name, hostId: d.hostId, deploymentRunId: d.deploymentRunId })
    // A release run starts at its record step; an operation's at its first step.
    const opFirst = this.o.plan.kind === 'operation' && d.deploymentRunId !== null && !this.opStarted.has(d.deploymentRunId)
    if (d.deploymentRunId && (d.kind === 'record' || d.kind === 'rb_checkout' || opFirst)) {
      this.opStarted.add(d.deploymentRunId)
      out.push({ type: 'deployment.updated', deploymentRunId: d.deploymentRunId, status: 'running' })
    }
    return a
  }

  /** A task's result: what it means for its step, then the task's own row (helper and untagged tasks have none). */
  private result(e: ResultEvent): RunEventBody[] {
    const t = this.tagsOf(e.tags)
    const stray = this.stray(e)
    if (t && this.foreign(e, t.run)) return stray
    // a result from a host is the point by which the tap has had a task round trip to deliver a held step's marker
    // (a result with no host, or from an alias the plan does not have, is no host's round trip: it flushes nothing)
    const hostId = e.host ? this.hostByAlias.get(e.host)?.hostId : undefined
    const before = hostId === undefined ? [] : this.flush(hostId)
    const out = [...stray, ...before, ...this.stepResult(e)]
    const r = t ? this.ref(t.kind) : null
    const name = e.task ?? ''
    if (!t || !r || this.internal(name)) return out
    const d = this.describe(r, t.run)
    const began = this.taskBegan.get(name)
    const state: TaskState =
      e.event === 'skipped' ? 'skipped' : e.event === 'unreachable' || (e.event === 'failed' && e.ignored !== true) ? 'failed' : e.changed === true ? 'changed' : 'ok'
    // the task ends before its step does
    const at = out.findIndex((x) => x.type === 'step.done' || x.type === 'step.failed')
    out.splice(at < 0 ? out.length : at, 0, {
      type: 'task.done',
      stepId: d.stepId,
      task: this.line(name),
      hostId: (e.host ? this.hostByAlias.get(e.host)?.hostId : undefined) ?? d.hostId,
      state,
      rc: typeof e.rc === 'number' ? e.rc : null,
      attempts: typeof e.attempts === 'number' ? e.attempts : null,
      durationMs: began === undefined ? 0 : this.o.now() - began,
    })
    return out
  }

  /** A result from a host the plan has no alias for is dropped, but said once, so a misnamed host is never silent. */
  private stray(e: ResultEvent): RunEventBody[] {
    if (e.host === undefined || this.hostByAlias.has(e.host) || this.strangers.has(e.host)) return []
    this.strangers.add(e.host)
    return [this.ansibleLog(`ansible reported a result for ${e.host}, a host this run does not have (task ${e.task ?? 'unnamed'}); its results are ignored`)]
  }

  private stepResult(e: ResultEvent): RunEventBody[] {
    const t = this.tagsOf(e.tags)
    const r = t ? this.ref(t.kind) : null
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
      if (t && r) return this.failStep(r, t.run, error, out)
      out.push(this.ansibleLog(error))
      return out
    }
    if (!t) {
      // untagged: the rescue bookkeeping tasks. Only worth a line when it carries text.
      if (msg && e.event === 'failed') out.push(this.ansibleLog(msg))
      return out
    }
    if (t.kind === 'preflight') {
      const error = this.collectPreflight(t.run, e)
      if (error !== null) out.push(this.ansibleLog(`${hostLabel}: ${e.task ?? 'preflight'} failed: ${error}`))
      return out
    }
    if (!r) return out
    const { kind } = r
    const d = this.describe(r, t.run)
    const prep = this.internal(e.task ?? '')
    const a = prep ? null : this.begin(d, out)
    const key = this.akey(d)

    const lines = hidden ? [] : this.splitOutput(e, d, out)
    const rc = typeof e.rc === 'number' ? e.rc : null
    const note = this.stepNotes.get(key)
    if (e.event === 'skipped' || (kind === 'custom' && note?.state === 'skipped')) {
      if (a) this.settle(a, { state: 'skipped' }, out)
      return out
    }
    if ((kind === 'tag' || kind === 'rb_tag') && a) {
      // best effort: the playbook never fails on tagging, so a failure arrives as the OD-TAG marker or a non-zero rc
      const tagged = this.tagNotes.get(key)
      this.tagNotes.delete(key)
      const tagRc = tagged !== undefined ? Number(/rc=(\d+)/.exec(tagged)?.[1] ?? 1) : rc
      if (tagged !== undefined || (e.event === 'ok' && rc !== null && rc !== 0)) {
        a.done = true
        const text = this.errorText(kind, d.name, tagRc, msg, lines.slice(-ERROR_CONTEXT_LINES), hidden)
        out.push({ type: 'step.done', stepId: d.stepId, state: 'warn', durationMs: this.o.now() - a.startedAt, message: text })
        this.onDone(a, out)
        return out
      }
    }
    if (kind === 'restore' && a) {
      // the restore never fails the host: a failed checkout arrives as OD-RESTORE failed, one that could not run as no marker
      const said = this.restoreNotes.get(key) ?? ''
      this.restoreNotes.delete(key)
      if (said === 'first') {
        this.settle(a, { state: 'ok', message: RESTORE_FIRST_NOTE }, out)
        return out
      }
      if (!said.startsWith('ok')) {
        const failedRc = Number(/rc=(\d+)/.exec(said)?.[1] ?? rc ?? 1)
        return this.failStep(r, t.run, this.errorText(kind, d.name, failedRc, msg, lines.slice(-ERROR_CONTEXT_LINES), hidden), out, lines, failedRc)
      }
    }
    if (e.event === 'failed' && e.ignored !== true) {
      const ctx = lines.slice(-ERROR_CONTEXT_LINES)
      return this.failStep(r, t.run, this.errorText(kind, d.name, rc, msg, ctx, hidden), out, lines, rc)
    }
    if (kind === 'custom' && a) {
      // a step set to continue reports OD-STEP rc=<n> (on stdout, or only as a stream line under no_log); a non-zero rc says the same
      const failedRc = note?.state === 'warn' ? note.rc : rc !== null && rc !== 0 ? rc : null
      if (failedRc !== null) {
        a.done = true
        this.stepNotes.delete(key)
        out.push({ type: 'step.done', stepId: d.stepId, state: 'warn', durationMs: this.o.now() - a.startedAt, message: hidden ? this.line(`${d.name} failed with exit code ${failedRc} (output hidden)`) : this.errorText(kind, d.name, failedRc, msg, lines.slice(-ERROR_CONTEXT_LINES), hidden) })
        this.onDone(a, out)
        return out
      }
    }
    if (kind === 'custom' && a && hidden && e.event === 'ok' && rc === 0 && this.hasWhen.has(`${t.run}:${r.key}`) && !a.done) {
      // under no_log the OD-SKIP of a `when` that found nothing changed may still be on its way through the tap
      this.pending.push(a)
      return out
    }
    if (a) this.settle(a, { state: 'ok', message: this.prevNote(kind, t.run) }, out)
    return out
  }

  /** Settles the held steps of a host (or of every host when null) with whatever marker has arrived by now. */
  private flush(hostId: string | null): RunEventBody[] {
    const out: RunEventBody[] = []
    for (const a of [...this.pending]) {
      if (hostId !== null && a.hostId !== hostId) continue
      this.pending.splice(this.pending.indexOf(a), 1)
      const note = this.stepNotes.get(`${a.hostId ?? ''}|${a.stepId}`)
      this.settle(a, note?.state === 'skipped' ? { state: 'skipped' } : { state: 'ok' }, out)
    }
    return out
  }

  private prevNote(kind: StepKind, run: string): string | undefined {
    return kind === 'record' && this.unknownPrevious.has(run) ? 'The previous commit could not be read from origin' : undefined
  }

  /** Counts a finished task toward its step; the step closes once all its tasks are in. */
  private settle(a: Active, r: { state: 'ok' | 'skipped'; message?: string }, out: RunEventBody[]): void {
    if (a.done) return
    a.seen++
    if (a.seen < a.expected && r.state === 'ok') return
    a.done = true
    this.stepNotes.delete(`${a.hostId ?? ''}|${a.stepId}`)
    const warn = r.state === 'ok' && r.message !== undefined
    out.push({ type: 'step.done', stepId: a.stepId, state: warn ? 'warn' : r.state, durationMs: this.o.now() - a.startedAt, ...(r.message ? { message: this.line(r.message) } : {}) })
    this.onDone(a, out)
  }

  /**
   * The deployment succeeds when the last step of its block finishes (a skipped or warned last step counts), not on
   * `tag`: a custom step after the tag is part of the release. A rollback's last step makes it rolled back.
   */
  private onDone(a: Active, out: RunEventBody[]): void {
    if (!a.deploymentRunId || this.failedRuns.has(a.deploymentRunId)) return
    const last = this.lastKey.get(a.deploymentRunId)
    const isLast = last !== undefined ? last === a.key : a.key === 'tag' || a.key === 'rb_tag'
    if (!isLast) return
    const back = this.o.plan.kind === 'rollback' || a.key.startsWith('rb_')
    out.push({ type: 'deployment.updated', deploymentRunId: a.deploymentRunId, status: back ? 'rolled_back' : 'succeeded' })
  }

  private markFailed(a: Active, out: RunEventBody[]): void {
    this.sawFailure = true
    if (!a.deploymentRunId) return
    this.failedRuns.add(a.deploymentRunId)
    out.push({ type: 'deployment.updated', deploymentRunId: a.deploymentRunId, status: a.key.startsWith('rb_') ? 'rollback_failed' : 'failed' })
  }

  private failStep(r: Ref, run: string, error: string, out: RunEventBody[], lines: string[] = [], rc: number | null = null): RunEventBody[] {
    const { kind } = r
    const d = this.describe(r, run)
    const a = this.active.get(this.akey(d)) ?? this.begin(d, out)
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
  private splitOutput(e: ResultEvent, d: Desc, out: RunEventBody[]): string[] {
    const ctx: string[] = []
    const task = e.task ? { task: this.line(e.task) } : {}
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
        out.push({ type: 'log', stepId: d.stepId, hostId: d.hostId, stream, line: this.line(l), ...task })
      }
    }
    emit('out', e.stdout)
    emit('err', e.stderr)
    if (e.truncated?.length) out.push({ type: 'log', stepId: d.stepId, hostId: d.hostId, stream: 'ansible', line: `Output of this step was cut (${e.truncated.join(', ')})`, ...task })
    return ctx
  }

  /**
   * Returns true when the marker was consumed (no log line). A marker counts only in the step that prints it: a custom
   * step's output never sets a commit, a backup file or a tag note.
   */
  private marker(mark: string, rest: string, d: Desc, out: RunEventBody[]): boolean {
    const run = d.deploymentRunId
    if (mark === MARK.PREV && run && d.key === 'record') {
      const p = parsePrev(rest)
      if (p?.kind === 'sha') out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', previousCommit: p.sha })
      else if (p?.kind === 'unknown') this.unknownPrevious.add(run)
      return true
    }
    if (mark === MARK.HEAD && run && (d.key === 'checkout' || d.key === 'rb_checkout')) {
      const sha = rest.trim()
      if (/^[0-9a-f]{40}$/.test(sha) && d.key === 'checkout') out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', deployedCommit: sha })
      return true
    }
    if (mark === MARK.BACKUP && run && d.key === 'backup') {
      const file = rest.trim()
      if (file) out.push({ type: 'deployment.updated', deploymentRunId: run, status: 'running', backupFile: this.red(file) })
      return true
    }
    if (mark === MARK.TAG && (d.key === 'tag' || d.key === 'rb_tag')) {
      this.tagNotes.set(this.akey(d), rest)
      return true
    }
    if (mark === MARK.RESTORE && d.key === 'restore') {
      this.restoreNotes.set(this.akey(d), rest.trim())
      return true
    }
    if (d.kind === 'custom' && (mark === MARK.STEP || mark === MARK.SKIP)) {
      this.noteStep(this.akey(d), mark, rest)
      return true
    }
    // lock lines carry the holder; the busy one is read from the failed result
    return mark === MARK.LOCK && (d.key === 'lock' || d.key === 'unlock')
  }

  /** Records what a custom step reported. Setting (not counting) the same note from stdout and from the stream line is harmless. */
  private noteStep(key: string, mark: string, rest: string): void {
    if (mark === MARK.SKIP) this.stepNotes.set(key, { state: 'skipped' })
    else {
      const rc = /^rc=(\d+)$/.exec(rest.trim())?.[1]
      if (rc !== undefined) this.stepNotes.set(key, { state: 'warn', rc: Number(rc) })
    }
  }

  /**
   * A line of a run's stream.log (the live tap). Under no_log a custom step's `OD-SKIP` and `OD-STEP rc=<n>` reach
   * the app only here; the note settles the step when its result arrives. A step that has already settled keeps its state.
   */
  observeStreamLine(line: string): void {
    const s = parseStreamLine(line)
    const dep = s ? this.depByRun.get(s.runId) : undefined
    if (!s || !dep || !CUSTOM_KEY.test(s.kind)) return
    const m = parseMarker(s.text)
    if (!m || (m.mark !== MARK.STEP && m.mark !== MARK.SKIP)) return
    const key = `${dep.hostId}|${s.runId}:${s.kind}`
    if (this.active.get(key)?.done) return
    this.noteStep(key, m.mark, m.rest)
  }

  // ---- preflight
  /** Keeps a preflight task's stdout for parsePreflight; returns the error of a task that failed outright, if any. */
  private collectPreflight(run: string, e: ResultEvent): string | null {
    if (e.no_log) return null
    // only the commit list reads the cut flag, so a cut in another check (the deps config can be large)
    // must not mark it; a task whose check can't be read counts as possibly the commits one
    const check = /^preflight (\S+)/.exec(e.task ?? '')?.[1]
    if (e.truncated?.includes('stdout') && (check === undefined || check === 'commits')) this.pfCut.add(run)
    if (e.event === 'skipped') {
      const skipped = this.pfSkip.get(run) ?? new Set<string>()
      skipped.add(check ?? '')
      this.pfSkip.set(run, skipped)
      return null
    }
    if (typeof e.stdout === 'string' && e.stdout) {
      const list = this.pf.get(run) ?? []
      list.push(e.stdout)
      this.pf.set(run, list)
    }
    // failed_when: false turns a shell that could not run (no bash, a bad chdir, a module crash) into "ok":
    // a check that printed no marker but carries an error failed all the same
    const broken = e.event === 'failed' ? e.ignored !== true : e.event === 'ok' && !/(^|\n)OD-PF /.test(e.stdout ?? '') && (Boolean(e.msg) || Boolean(e.stderr?.trim()) || (typeof e.rc === 'number' && e.rc !== 0))
    if (!broken) return null
    const error = this.line(failureText(e))
    const errs = this.pfErr.get(run) ?? new Map<string, string>()
    if (!errs.has(check ?? '')) errs.set(check ?? '', error)
    this.pfErr.set(run, errs)
    return error
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
    // A one-shot dependency (a migrations job) has exited by design, so it never counts as not running.
    const names = Array.isArray(dep)
      ? dep.filter((x): x is string => typeof x === 'string')
      : isObj(dep)
        ? Object.keys(dep).filter((n) => !(isObj(dep[n]) && dep[n].condition === 'service_completed_successfully'))
        : []
    // Names come from the host's compose file; anything that isn't a service name is dropped.
    const missing = names.filter((n) => COMPOSE_SERVICE.test(n) && !running.has(n) && !chosen.has(n))
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

const FAILURE_MAX = 300

/** What a module written for Python 3.8+ (ansible-core 2.17 and newer) dies of on an older python, and what to do. */
const OLD_PYTHON = /future feature annotations is not defined/
export const OLD_PYTHON_HINT =
  "the server's Python is older than 3.8, which this Ansible needs (ansible-core 2.17 and newer). Install ansible-core 2.16 on this Mac (pipx install 'ansible-core<2.17'), or Python 3.8 or newer on the server"

/**
 * One line for a task that failed outright: ansible's message, and for a module failure (no python, a crash)
 * the last line of stderr (else of stdout, where a shell profile or sudo may have spoken), which says why.
 * That line replaces ansible's own detail ("No start of json char found"), which only says the output wasn't JSON.
 */
function failureText(e: ResultEvent): string {
  const first = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  // ssh's own goodbye says nothing about the failure.
  const last = (s: string | undefined) =>
    (s ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Shared connection to \S+ closed\.$/.test(l)).at(-1) ?? ''
  const msg = first(typeof e.msg === 'string' ? e.msg : undefined)
  const moduleFailure = msg.startsWith('MODULE FAILURE')
  const why = moduleFailure || !msg ? last(e.stderr) || last(e.stdout) : ''
  if (OLD_PYTHON.test(why)) return OLD_PYTHON_HINT
  const head = moduleFailure && why ? 'MODULE FAILURE' : msg
  const text = [head, why].filter(Boolean).join(': ') || 'the task failed without a message'
  return text.length > FAILURE_MAX ? `${text.slice(0, FAILURE_MAX - 1)}…` : text
}

export interface ParsePreflightOptions {
  now: number
  /** Run keys whose output the callback plugin cut (EventTranslator.preflightCut()). */
  cut?: string[]
  secrets?: string[]
  /** Errors of check tasks that failed outright (EventTranslator.preflightErrors()), named instead of "no result". */
  errors?: Record<string, Record<string, string>>
  /** Checks whose task ansible skipped (EventTranslator.preflightSkipped()), named instead of "no result". */
  skipped?: Record<string, string[]>
  /** Why ansible may have run nothing (no hosts matched, its exit code): added to every "no result". */
  reason?: string | null
}

/**
 * Builds the preflight report from the OD-PF lines of each run's stdout. A check whose lines are missing is
 * never reported as clean: a missing repo blocks, and anything else that printed nothing blocks as "no result".
 */
/** A check whose task is named differently: the branch check is printed by the fetch task. */
const TASK_OF: Record<string, string> = { branch: 'fetch' }

export function parsePreflight(plan: DeployPlan, stdoutByRun: Record<string, string>, o: ParsePreflightOptions): RunnerPreflight {
  const checks: PreflightCheck[] = []
  const commits: PreflightReport['commits'] = {}
  const dockerModes: Record<string, DockerMode> = {}
  const composeServices: PreflightReport['composeServices'] = Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, null]))
  const checkouts: Record<string, string> = {}
  const locks: PreflightReport['locks'] = {}
  const red = (s: string): string => redact(s, o.secrets ?? [])
  const cutRuns = new Set(o.cut ?? [])
  const hostById = new Map(plan.hosts.map((h) => [h.hostId, h]))
  const because = o.reason ? ` (${o.reason})` : ''

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
    const noResult = (id: string, what: string): void => {
      const task = TASK_OF[id] ?? id
      const error = o.errors?.[d.runId]?.[task]
      if (error) add(id, 'block', `${what} failed on ${hl}: ${error}`)
      else if (o.skipped?.[d.runId]?.includes(task)) add(id, 'block', `${what} was skipped on ${hl}`)
      else add(id, 'block', `${what} gave no result on ${hl}${because}`)
    }

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
      if (repo.root !== undefined && REPO_PATH.test(repo.root)) checkouts[d.deploymentId] = repo.root
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
      else if (cp.exists !== '1') add('compose', 'block', d.composeFile === '' ? `no compose file found in ${d.repoPath}` : `compose file ${d.composeFile} not found in ${d.repoPath}`)
      else {
        add('compose', 'ok', d.composeFile === '' ? 'compose file found' : `${d.composeFile} exists`)
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
      const tagCommit = tag?.exists === '1' && tag.commit && /^[0-9a-f]{40}$/.test(tag.commit) ? tag.commit : null
      // Only a head this preflight fetched: after a failed fetch it is the last fetched copy, which may be stale.
      const fetched = get('branch')?.fetched === '1'
      const reported = fetched && cm && typeof cm.origin_head === 'string' && /^[0-9a-f]{40}$/.test(cm.origin_head) ? cm.origin_head : null
      // A checkout reported twice (two hosts) has a head only when both agree.
      const prev = commits[d.deploymentId]
      const originHead = prev === undefined || prev.originHead === reported ? reported : null
      commits[d.deploymentId] = { commits: list, hiddenPairs: hidden, truncated, firstDeploy, head: newest, tagCommit, originHead }
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
      const error = o.errors?.[`host:${h.hostId}`]?.lock
      if (error) add('block', `The lock check failed on ${h.label}: ${error}`)
      else if (o.skipped?.[`host:${h.hostId}`]?.includes('lock')) add('block', `The lock check was skipped on ${h.label}`)
      else add('block', `the lock check gave no result on ${h.label}${because}`)
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
      add('block', `${red(lockHolderText(holder, o.now))}${stale ? LOCK_STALE_NOTE : ''}`)
    }
  }

  return { checks, commits, dockerModes, composeServices, locks, checkouts, commitsTotal, blocked: checks.some((c) => c.level === 'block') }
}
