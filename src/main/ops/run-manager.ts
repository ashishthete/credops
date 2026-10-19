import { randomUUID } from 'node:crypto'
import type { AuditInput } from '../../shared/audit'
import type { EnvironmentMeta, HostMeta } from '../../shared/inventory'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RUN_TIMEOUT_SEC,
  MAX_ACTIVE_RUNS,
  MAX_CONCURRENCY,
  MAX_RUN_TARGETS,
  MAX_RUN_TIMEOUT_SEC,
  MAX_RUNS_KEPT,
  OUTPUT_FLUSH_CHARS,
  OUTPUT_FLUSH_MS,
  RUN_OUTPUT_CHARS,
  RUN_OUTPUT_TOTAL_CHARS,
  type AuditedRunCommand,
  type RunEvent,
  type RunHostMeta,
  type RunHostState,
  type RunOutput,
  type RunRequest,
  type RunSummary,
} from '../../shared/ops'
import type { SessionError } from '../../shared/ssh'
import { VAULT_LOCKED } from '../../shared/vault'
import { redact } from '../security/redact'
import { realTimers, type Timers } from '../tunnels/forward'
import { ExecFailure, type ExecLinks } from './exec-links'
import { execOnce, type ExecResult } from './exec'
import { OutputRing } from './output-ring'
import { ProtectError, checkConfirm, confirmNeeded, isDestructive, protectionFor } from './protect'
import { parseTemplate, renderTemplate } from './quote'
import type { SnippetStore } from './snippet-store'

/** A host stopped while its command ran: without a pty the server need not kill it. */
export const CANCELLED_RUNNING = 'Cancelled (the command may still be running on the host)'
const CANCELLED: SessionError = { code: 'closed', message: 'Cancelled' }
const HOST_NOT_FOUND: SessionError = { code: 'unknown', message: 'Host not found' }
const LOCKED: SessionError = { code: 'locked', message: 'The vault was locked before this host ran' }
const NO_HOSTS = 'No hosts match this target'
const MAX_TITLE = 60
const MAX_PROGRAM = 64

export interface RunManagerDeps {
  links: Pick<ExecLinks, 'lease'>
  snippets: Pick<SnippetStore, 'get'>
  environments(): EnvironmentMeta[]
  hosts(): HostMeta[]
  isLocked(): boolean
  audit: { append(i: AuditInput): unknown }
  emit(event: 'run:event', payload: RunEvent): void
  now?: () => Date
  ids?: () => string
  /** The flush timer and each exec's timeout. */
  timers?: Timers
  /** Test seams; default `RUN_OUTPUT_TOTAL_CHARS` and `RUN_OUTPUT_CHARS`. */
  outputBudget?: number
  outputCap?: number
}

interface Host {
  meta: RunHostMeta
  ring: OutputRing
  /** Output not yet emitted, in order; consecutive chunks of one stream are joined. */
  pending: { stream: 'out' | 'err'; text: string; end: number }[]
  pendingChars: number
  /** Aborts the lease, then the exec: a cancel, or a lock while it dials. */
  abort: AbortController
  lockStop: boolean
  /** Not in the inventory at start (a stale id): it fails alone at its turn, labelled by its id. */
  missing: boolean
}

interface Run {
  id: string
  state: RunSummary['state']
  title: string
  command: string
  environmentId: string | null
  environmentName: string | null
  concurrency: number
  timeoutSec: number
  startedAt: string
  endedAt: string | null
  outputDropped: boolean
  hosts: Host[]
  active: number
  flushTimer: unknown
  audit: { targetType: 'environment' | 'hosts'; targetId?: string; targetLabel: string }
  finished: Promise<void>
  resolveFinished(): void
}

interface Target {
  context: EnvironmentMeta | null
  hosts: { id: string; label: string; missing: boolean }[]
  audit: Run['audit']
}

const FINAL: ReadonlySet<RunHostState> = new Set(['ok', 'failed', 'cancelled', 'timeout'])
const isFinal = (h: Host): boolean => FINAL.has(h.meta.state)
const clamp = (n: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Math.trunc(n ?? fallback), 1), max)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The first non-blank line, at most `MAX_TITLE` chars. It stays in memory: never audited or toasted. */
function titleOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
}

/**
 * What audit keeps of a typed command: its program, size and line count, never the text. The program
 * is the first word that isn't an assignment, cut at the first character a plain command name doesn't use.
 */
function auditedText(text: string): AuditedRunCommand {
  const word = text.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''
  const program = (/^[A-Za-z0-9_./+-]*/.exec(word)?.[0] ?? '').slice(0, MAX_PROGRAM)
  return { kind: 'text', program: redact(program), chars: text.length, lines: text.split('\n').length }
}

const errorOf = (err: unknown): SessionError =>
  err instanceof ExecFailure
    ? { ...err.error }
    : { code: 'unknown', message: redact(err instanceof Error ? err.message : String(err)) }

/**
 * Runs one command (typed, or a rendered snippet) on many hosts over pooled exec links. A run's hosts
 * go `queued → connecting → running → ok | failed | cancelled | timeout`, at most `concurrency` at a
 * time. Host state events are emitted at once, after that host's pending output; output is batched
 * per host by one run-level timer. Protection is taken from the target hosts' environments (G9).
 * Audit gets `run.start` (or `denied`) and one `run.finish`, with host labels, never output, values
 * or addresses.
 */
export class RunManager {
  private readonly runs = new Map<string, Run>()
  private readonly now: () => Date
  private readonly ids: () => string
  private readonly timers: Timers
  private readonly budget: number
  private readonly cap: number
  /** Buffered chars across every run. */
  private total = 0
  /** Set by `closeAll`: no run starts after quit. */
  private closed = false

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
    this.timers = deps.timers ?? realTimers
    this.budget = deps.outputBudget ?? RUN_OUTPUT_TOTAL_CHARS
    this.cap = deps.outputCap ?? RUN_OUTPUT_CHARS
  }

  /** Validates, resolves the targets, checks the confirmation, audits `run.start` and starts the queue. Returns with every host queued. */
  start(req: RunRequest): RunSummary {
    if (this.closed) throw new Error('OpsDeck is quitting')
    if (this.deps.isLocked()) {
      this.deps.audit.append({ action: 'run.start', outcome: 'denied', ...this.lockedTarget(req.target), details: { reason: 'locked' } })
      throw new Error(VAULT_LOCKED)
    }
    const active = [...this.runs.values()].filter((r) => r.state === 'running').length
    if (active >= MAX_ACTIVE_RUNS) throw new Error(`too many runs at once (${MAX_ACTIVE_RUNS}); wait for one to finish`)

    const target = this.resolveTarget(req.target)
    const { command, title, destructive, audited } = this.resolveCommand(req.command)
    const labels = target.hosts.map((h) => h.label)
    let confirmed = false
    try {
      const memberships = this.deps.environments().filter((e) => e.hosts.some((m) => target.hosts.some((h) => h.id === m.hostId)))
      const env = protectionFor(target.context, memberships)
      const needed = confirmNeeded(env, target.hosts.length, isDestructive(command, destructive))
      checkConfirm(needed, req.confirm)
      confirmed = needed !== null
    } catch (err) {
      if (err instanceof ProtectError) {
        this.deps.audit.append({
          action: 'run.start',
          outcome: 'denied',
          ...target.audit,
          details: { hosts: labels, command: audited, reason: err.code },
        })
      }
      throw err
    }

    let resolveFinished!: () => void
    const run: Run = {
      id: this.ids(),
      state: 'running',
      title,
      command,
      environmentId: target.context?.id ?? null,
      environmentName: target.context?.name ?? null,
      concurrency: clamp(req.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
      timeoutSec: clamp(req.timeoutSec, DEFAULT_RUN_TIMEOUT_SEC, MAX_RUN_TIMEOUT_SEC),
      startedAt: this.now().toISOString(),
      endedAt: null,
      outputDropped: false,
      hosts: target.hosts.map((h) => ({
        meta: {
          hostId: h.id,
          label: h.label,
          state: 'queued',
          exitCode: null,
          signal: null,
          error: null,
          startedAt: null,
          endedAt: null,
          truncated: false,
        },
        ring: new OutputRing(this.cap),
        pending: [],
        pendingChars: 0,
        abort: new AbortController(),
        lockStop: false,
        missing: h.missing,
      })),
      active: 0,
      flushTimer: null,
      audit: target.audit,
      finished: new Promise<void>((resolve) => (resolveFinished = resolve)),
      resolveFinished: () => resolveFinished(),
    }
    this.runs.set(run.id, run)
    this.deps.audit.append({
      action: 'run.start',
      outcome: 'success',
      ...run.audit,
      details: {
        runId: run.id,
        hosts: labels,
        concurrency: run.concurrency,
        timeoutSec: run.timeoutSec,
        command: audited,
        ...(confirmed ? { confirmed: true } : {}),
      },
    })
    const summary = this.summary(run)
    this.deps.emit('run:event', { runId: run.id, kind: 'run', run: summary })
    for (const h of run.hosts) this.emitHost(run, h)
    this.pump(run)
    return summary
  }

  /** Skips queued hosts, aborts dials and interrupts running commands; resolves once the run has ended. A finished run is returned as is. */
  async cancel(runId: string): Promise<RunSummary> {
    const run = this.run(runId)
    if (run.state === 'running') {
      for (const h of run.hosts) {
        if (h.meta.state === 'queued') this.endHost(run, h, 'cancelled', { error: { ...CANCELLED } })
        else if (!isFinal(h)) h.abort.abort()
      }
      this.maybeFinish(run)
      await run.finished
    }
    return this.summary(run)
  }

  /** Newest first. */
  list(): RunSummary[] {
    return [...this.runs.values()].reverse().map((r) => this.summary(r))
  }

  get(runId: string): { run: RunSummary; output: RunOutput[] } {
    const run = this.run(runId)
    const output = run.outputDropped
      ? []
      : run.hosts.map((h) => {
          const before = h.ring.length
          const { text, errRanges } = h.ring.snapshot()
          this.total -= before - text.length
          return { hostId: h.meta.hostId, text, errRanges, total: h.ring.total }
        })
    return { run: this.summary(run), output }
  }

  /** Finished runs only. */
  dismiss(runId: string): void {
    const run = this.run(runId)
    if (run.state === 'running') throw new Error('the run is still running')
    this.drop(run)
  }

  /** Hosts still queued or dialing end `cancelled` with `locked`; running hosts finish. A run never resumes on unlock. */
  vaultLocked(): void {
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue
      for (const h of run.hosts) {
        if (h.meta.state === 'queued') this.endHost(run, h, 'cancelled', { error: { ...LOCKED } })
        else if (h.meta.state === 'connecting') {
          h.lockStop = true
          h.abort.abort()
        }
      }
      this.maybeFinish(run)
    }
  }

  /**
   * Quit: every unfinished host ends `cancelled` now and its command gets its `INT`, so each run's
   * `run.finish` is written before the app's own quit row. Nothing new starts afterwards.
   */
  closeAll(): void {
    this.closed = true
    for (const run of this.runs.values()) this.endNow(run)
  }

  /**
   * Vault reset: every unfinished run ends as on quit, then every run, finished ones too, is
   * forgotten with its output, so nothing from before the reset can be read after it. Unlike
   * `closeAll`, runs start again once the vault is set up. One run failing never skips the rest.
   */
  vaultReset(): void {
    for (const run of [...this.runs.values()]) {
      try {
        this.endNow(run)
      } catch (err) {
        console.warn('Run cancel failed:', redact(err instanceof Error ? err.message : String(err)))
      }
      try {
        this.drop(run)
      } catch (err) {
        console.warn('Run drop failed:', redact(err instanceof Error ? err.message : String(err)))
        this.runs.delete(run.id)
      }
    }
  }

  /** Every unfinished host ends `cancelled` now and its command gets its `INT`; the run finishes. */
  private endNow(run: Run): void {
    if (run.state !== 'running') return
    for (const h of run.hosts) {
      if (isFinal(h)) continue
      const running = h.meta.state === 'running'
      h.abort.abort()
      this.endHost(run, h, 'cancelled', { error: running ? { code: 'closed', message: CANCELLED_RUNNING } : { ...CANCELLED } })
    }
    this.maybeFinish(run)
  }

  private run(runId: string): Run {
    const run = this.runs.get(runId)
    if (!run) throw new Error('run not found')
    return run
  }

  /** The audit target of a start refused while locked: no protected lookups, just the environment's name or the host count. */
  private lockedTarget(t: RunRequest['target']): Run['audit'] {
    if (t.kind === 'hosts') return { targetType: 'hosts', targetLabel: plural(new Set(t.hostIds).size, 'host') }
    const name = this.deps.environments().find((e) => e.id === t.environmentId)?.name ?? 'unknown environment'
    return { targetType: 'environment', targetId: t.environmentId, targetLabel: name }
  }

  private resolveTarget(t: RunRequest['target']): Target {
    const hosts = this.deps.hosts()
    const envOf = (id: string): EnvironmentMeta => {
      const env = this.deps.environments().find((e) => e.id === id)
      if (!env) throw new Error('environment not found')
      return env
    }
    let picked: Target['hosts']
    let context: EnvironmentMeta | null = null
    if (t.kind === 'environment') {
      context = envOf(t.environmentId)
      const members = new Set(context.hosts.filter((m) => t.role === undefined || m.role === t.role).map((m) => m.hostId))
      // hosts() is in label order.
      picked = hosts.filter((h) => members.has(h.id)).map((h) => ({ id: h.id, label: h.label, missing: false }))
    } else {
      const ids = [...new Set(t.hostIds)]
      if (ids.length > MAX_RUN_TARGETS) throw new Error(`too many hosts (${MAX_RUN_TARGETS} at most)`)
      if (t.environmentId !== undefined) context = envOf(t.environmentId)
      const byId = new Map(hosts.map((h) => [h.id, h]))
      // A stale id (a host deleted since the renderer listed it) fails alone rather than sinking the run.
      picked = ids.map((id) => {
        const h = byId.get(id)
        return h ? { id, label: h.label, missing: false } : { id, label: id, missing: true }
      })
    }
    if (picked.length === 0) throw new Error(NO_HOSTS)
    if (picked.length > MAX_RUN_TARGETS) throw new Error(`too many hosts (${MAX_RUN_TARGETS} at most)`)
    const audit: Run['audit'] =
      t.kind === 'environment'
        ? { targetType: 'environment', targetId: context!.id, targetLabel: context!.name }
        : { targetType: 'hosts', targetLabel: plural(picked.length, 'host') }
    return { context, hosts: picked, audit }
  }

  private resolveCommand(c: RunRequest['command']): {
    command: string
    title: string
    destructive: boolean
    audited: AuditedRunCommand
  } {
    if (c.kind === 'text') return { command: c.text, title: titleOf(c.text), destructive: false, audited: auditedText(c.text) }
    const s = this.deps.snippets.get(c.snippetId)
    const defaults: Record<string, string | null> = Object.create(null)
    for (const v of s.variables) defaults[v.name] = v.default
    const command = renderTemplate(parseTemplate(s.script), c.values, defaults)
    return {
      command,
      title: s.label,
      destructive: s.destructive,
      audited: { kind: 'snippet', snippetId: s.id, label: s.label, variables: s.variables.map((v) => v.name) },
    }
  }

  /** Starts queued hosts while fewer than `concurrency` are active. */
  private pump(run: Run): void {
    while (run.state === 'running' && run.active < run.concurrency) {
      const h = run.hosts.find((x) => x.meta.state === 'queued')
      if (!h) return
      run.active++
      this.setState(run, h, 'connecting', { startedAt: this.now().toISOString() })
      void this.runHost(run, h)
        .catch((err: unknown) => this.endHost(run, h, 'failed', { error: errorOf(err) }))
        .finally(() => {
          run.active--
          this.pump(run)
          this.maybeFinish(run)
        })
    }
  }

  /** Leases a channel, runs the command and releases the lease once it has ended. */
  private async runHost(run: Run, h: Host): Promise<void> {
    const signal = h.abort.signal
    const stopped = (): void => this.endHost(run, h, 'cancelled', { error: h.lockStop ? { ...LOCKED } : { ...CANCELLED } })
    if (h.missing) return this.endHost(run, h, 'failed', { error: { ...HOST_NOT_FOUND } })
    let lease
    try {
      lease = await this.deps.links.lease(h.meta.hostId, run.environmentId, { id: `runs:${run.id}` }, signal)
    } catch (err) {
      // A cancelled lease and a dropped link both reject `closed`; only our own signal tells them apart.
      return signal.aborted ? stopped() : this.endHost(run, h, 'failed', { error: errorOf(err) })
    }
    try {
      if (signal.aborted) return stopped()
      this.setState(run, h, 'running')
      const result = await execOnce(lease.client, run.command, {
        env: lease.envVars,
        signal,
        timeoutMs: run.timeoutSec * 1000,
        timers: this.timers,
        onData: (chunk, stream) => this.output(run, h, chunk, stream),
      })
      this.endExec(run, h, result)
    } catch (err) {
      if (signal.aborted) this.endHost(run, h, 'cancelled', { error: { code: 'closed', message: CANCELLED_RUNNING } })
      else this.endHost(run, h, 'failed', { error: errorOf(err) })
    } finally {
      lease.release()
    }
  }

  private endExec(run: Run, h: Host, r: ExecResult): void {
    const codes = { exitCode: r.exitCode, signal: r.signal }
    if (r.cancelled) return this.endHost(run, h, 'cancelled', { ...codes, error: { code: 'closed', message: CANCELLED_RUNNING } })
    if (r.timedOut) {
      const message = `Timed out after ${run.timeoutSec}s (the command may still be running on the host)`
      return this.endHost(run, h, 'timeout', { ...codes, error: { code: 'timeout', message } })
    }
    if (r.exitCode === 0 && r.signal === null) return this.endHost(run, h, 'ok', codes)
    const lost = r.exitCode === null && r.signal === null
    const error: SessionError | null = lost ? { code: 'closed', message: 'The connection closed before the command finished' } : null
    this.endHost(run, h, 'failed', { ...codes, error })
  }

  private output(run: Run, h: Host, chunk: string, stream: 'out' | 'err'): void {
    // A host ended by closeAll may still deliver text; it never follows the final state.
    if (isFinal(h) || run.outputDropped) return
    const before = h.ring.length
    h.ring.append(chunk, stream)
    this.total += h.ring.length - before
    const last = h.pending.at(-1)
    if (last?.stream === stream) {
      last.text += chunk
      last.end = h.ring.total
    } else h.pending.push({ stream, text: chunk, end: h.ring.total })
    h.pendingChars += chunk.length
    if (h.pendingChars >= OUTPUT_FLUSH_CHARS) this.flushHost(run, h)
    else if (run.flushTimer === null) run.flushTimer = this.timers.setTimeout(() => this.flush(run), OUTPUT_FLUSH_MS)
    this.enforceBudget()
  }

  private flush(run: Run): void {
    if (run.flushTimer !== null) this.timers.clearTimeout(run.flushTimer)
    run.flushTimer = null
    for (const h of run.hosts) this.flushHost(run, h)
  }

  private flushHost(run: Run, h: Host): void {
    if (h.ring.truncated && !h.meta.truncated) h.meta.truncated = true
    for (const p of h.pending.splice(0)) {
      this.deps.emit('run:event', {
        runId: run.id,
        kind: 'output',
        hostId: h.meta.hostId,
        chunk: p.text,
        end: p.end,
        ...(p.stream === 'err' ? { stream: 'err' as const } : {}),
      })
    }
    h.pendingChars = 0
  }

  private setState(run: Run, h: Host, state: RunHostState, patch: Partial<RunHostMeta> = {}): void {
    this.flushHost(run, h)
    Object.assign(h.meta, patch, { state })
    this.emitHost(run, h)
  }

  /** The host's final state, once; later calls (a host closeAll already ended) are ignored. */
  private endHost(run: Run, h: Host, state: RunHostState, patch: Partial<RunHostMeta>): void {
    if (isFinal(h)) return
    this.setState(run, h, state, { ...patch, endedAt: this.now().toISOString() })
  }

  private emitHost(run: Run, h: Host): void {
    this.deps.emit('run:event', { runId: run.id, kind: 'host', host: { ...h.meta } })
  }

  /** Ends the run once every host has: the last output, the run event, then `run.finish` once. */
  private maybeFinish(run: Run): void {
    if (run.state !== 'running' || !run.hosts.every(isFinal)) return
    this.flush(run)
    const count = (s: RunHostState): number => run.hosts.filter((h) => h.meta.state === s).length
    run.state = count('cancelled') > 0 ? 'cancelled' : 'done'
    run.endedAt = this.now().toISOString()
    this.deps.emit('run:event', { runId: run.id, kind: 'run', run: this.summary(run) })
    const ok = count('ok')
    this.deps.audit.append({
      action: 'run.finish',
      outcome: ok === run.hosts.length ? 'success' : run.state === 'cancelled' ? 'info' : 'failure',
      ...run.audit,
      details: {
        runId: run.id,
        ok,
        failed: count('failed'),
        cancelled: count('cancelled'),
        timeout: count('timeout'),
        results: run.hosts.map((h) => ({ host: h.meta.label, state: h.meta.state, exitCode: h.meta.exitCode })),
      },
    })
    run.resolveFinished()
    const finished = [...this.runs.values()].filter((r) => r.state !== 'running')
    for (const old of finished.slice(0, Math.max(finished.length - MAX_RUNS_KEPT, 0))) this.drop(old)
    this.enforceBudget()
  }

  /** Past the total budget, the oldest finished runs lose their output; their summaries stay. */
  private enforceBudget(): void {
    if (this.total <= this.budget) return
    for (const run of this.runs.values()) {
      if (this.total <= this.budget) return
      if (run.state === 'running' || run.outputDropped) continue
      this.dropOutput(run)
      run.outputDropped = true
    }
  }

  private dropOutput(run: Run): void {
    for (const h of run.hosts) {
      this.total -= h.ring.length
      h.ring = new OutputRing(this.cap)
    }
  }

  private drop(run: Run): void {
    this.dropOutput(run)
    this.runs.delete(run.id)
  }

  private summary(run: Run): RunSummary {
    return {
      id: run.id,
      state: run.state,
      title: run.title,
      environmentId: run.environmentId,
      environmentName: run.environmentName,
      concurrency: run.concurrency,
      hosts: run.hosts.map((h) => ({ ...h.meta, error: h.meta.error && { ...h.meta.error } })),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      outputDropped: run.outputDropped,
    }
  }
}
