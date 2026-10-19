import { randomUUID } from 'node:crypto'
import type { AuditInput } from '../../shared/audit'
import type { EnvironmentMeta } from '../../shared/inventory'
import {
  CONTAINER_ACTIONS,
  CONTAINER_REF,
  CONTAINER_STATES,
  LOG_TAIL_MAX,
  MAX_CONTAINERS,
  MAX_LOG_FOLLOWS,
  OUTPUT_FLUSH_CHARS,
  OUTPUT_FLUSH_MS,
  RUN_OUTPUT_CHARS,
  type ContainerAction,
  type ContainerList,
  type ContainerLogEvent,
  type ContainerMeta,
} from '../../shared/ops'
import { PROMPT_TIMEOUT_MS, type SessionError } from '../../shared/ssh'
import { VAULT_LOCKED } from '../../shared/vault'
import { redact } from '../security/redact'
import { realTimers, type Timers } from '../tunnels/forward'
import { ExecFailure, type ExecLinks, type Lease } from './exec-links'
import { execOnce, type ExecResult } from './exec'
import { OutputRing } from './output-ring'
import { ProtectError, checkConfirm, confirmNeeded, protectionFor } from './protect'
import { shJoin } from './quote'

/**
 * How long a list, logs, action or follow waits for its lease. It outlasts an unanswered prompt, so a
 * first dial that asks about a host key still gets its answer, but a host whose channels stay busy
 * (runs, follows) can't hang the call for ever.
 */
export const CONTAINER_LEASE_TIMEOUT_MS = PROMPT_TIMEOUT_MS + 30_000
/** How long one docker command (list, logs, start, stop, restart) may run; `stop` alone waits 10 s by default. */
export const CONTAINER_EXEC_TIMEOUT_MS = 120_000
const MAX_ERROR_CHARS = 200
/** Stderr kept to explain a failure: the head for list and actions, the tail for logs. */
const MAX_ERR_KEPT = 4096
/** A `docker ps` line longer than this is skipped unparsed. */
const MAX_PS_LINE = 65_536
const QUITTING = 'OpsDeck is quitting'
const EXEC_SHELL = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'

/** A container exec tab's command; `SessionManager` sends it with a pty. */
export const containerExecArgv = (ref: string): string[] => ['docker', 'exec', '-it', ref, 'sh', '-c', EXEC_SHELL]
const LIST_ARGV = ['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}']
const logsArgv = (ref: string, tail: number, follow: boolean): string[] => [
  'docker',
  'logs',
  '--timestamps',
  '--tail',
  String(tail),
  ...(follow ? ['--follow'] : []),
  ref,
]

/** Defence in depth: the ref is also one quoted word, but nothing that isn't a container name gets that far. */
export function checkContainerRef(ref: unknown): string {
  if (typeof ref !== 'string' || !CONTAINER_REF.test(ref)) throw new Error('container must be a container name or id')
  return ref
}

function checkTail(tail: unknown): number {
  if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 0 || tail > LOG_TAIL_MAX) {
    throw new Error(`tail must be a whole number from 0 to ${LOG_TAIL_MAX}`)
  }
  return tail
}

const FULL_ID = /^[0-9a-f]{64}$/
/** A full container id reads as its 12-char short id, the way docker shows it. */
export const shortRef = (ref: string): string => (FULL_ID.test(ref) ? ref.slice(0, 12) : ref)
/** The audit `containerId`: only a full id is a verified id, so a name or short id gives none. */
export const containerAuditId = (ref: string): { containerId?: string } => (FULL_ID.test(ref) ? { containerId: ref.slice(0, 12) } : {})

/** Plain words for the errors an operator can fix; otherwise docker's first stderr line, redacted and capped. */
export function dockerError(label: string, exitCode: number | null, stderr: string): string {
  if (exitCode === 127 || /command not found|docker: not found/i.test(stderr)) return `Docker isn't installed on ${label}`
  if (/permission denied/i.test(stderr) && stderr.includes('docker.sock')) {
    return `Docker needs permission on ${label} (add the user to the docker group)`
  }
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (line) return redact(line).slice(0, MAX_ERROR_CHARS)
  return exitCode === null ? `docker was stopped by a signal on ${label}` : `docker exited with code ${exitCode} on ${label}`
}

/** Docker's own error lines, as the CLI prints them; nothing a container logs is shown otherwise. */
const DOCKER_OWN_ERROR = /^(?:Error response from daemon|Error: No such container): /
const DOCKER_SOCKET_DENIED = /^permission denied while trying to connect to the Docker daemon socket/

/**
 * `docker logs` relays the container's own stderr on its stderr, so app log lines (which may hold
 * anything) never become error text: only the last stderr line, and only when it is docker's own
 * error, else the exit code alone.
 */
export function logsError(label: string, exitCode: number | null, stderrTail: string): string {
  if (exitCode === 127) return `Docker isn't installed on ${label}`
  const last = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .findLast((l) => l !== '')
  if (last !== undefined && DOCKER_OWN_ERROR.test(last)) return redact(last).slice(0, MAX_ERROR_CHARS)
  if (last !== undefined && DOCKER_SOCKET_DENIED.test(last)) return `Docker needs permission on ${label} (add the user to the docker group)`
  return exitCode === null ? `docker logs was stopped by a signal on ${label}` : `docker logs exited with code ${exitCode} on ${label}`
}

/** Keeps the first (or, for logs, the last) `MAX_ERR_KEPT` chars of stderr. */
class StderrKept {
  text = ''
  /** `docker logs`: keep the tail and read it with `logsError`. */
  constructor(readonly isLogs: boolean) {}

  push(chunk: string): void {
    if (this.isLogs) this.text = (this.text + chunk).slice(-MAX_ERR_KEPT)
    else if (this.text.length < MAX_ERR_KEPT) this.text += chunk
  }
}

/** Null when docker exited 0. A cancelled exec is the caller's to handle. */
function exitError(label: string, r: ExecResult, stderr: StderrKept): SessionError | null {
  if (r.exitCode === 0 && r.signal === null) return null
  if (r.exitCode === null && r.signal === null) {
    return { code: 'closed', message: `The connection to ${label} dropped before docker finished` }
  }
  const message = stderr.isLogs ? logsError(label, r.exitCode, stderr.text) : dockerError(label, r.exitCode, stderr.text)
  return { code: 'unknown', message }
}

const errorOf = (err: unknown): SessionError =>
  err instanceof ExecFailure
    ? { ...err.error }
    : { code: 'unknown', message: redact(err instanceof Error ? err.message : String(err)) }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** F18: `State` when docker sends it, else read from `Status` as older daemons only send that. */
function stateOf(state: unknown, status: string): ContainerMeta['state'] {
  if (typeof state === 'string' && state !== '') {
    const s = state.toLowerCase()
    return (CONTAINER_STATES as readonly string[]).includes(s) ? (s as ContainerMeta['state']) : 'unknown'
  }
  if (/^Up\b.*\(Paused\)/.test(status)) return 'paused'
  if (/^Up\b/.test(status)) return 'running'
  if (/^Restarting\b/.test(status)) return 'restarting'
  if (/^(?:Exited|Created|Dead)\b/.test(status)) return 'exited'
  return 'unknown'
}

/** `k=v,k=v`, split on the first `=` only; values may hold `=` (not `,`, which docker doesn't escape). */
function labelsOf(raw: unknown): Map<string, string> {
  const labels = new Map<string, string>()
  if (typeof raw === 'string') {
    for (const pair of raw.split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0) labels.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') labels.set(k, v)
  }
  return labels
}

/** One `docker ps` JSON object, or null when it isn't a container OpsDeck could act on. */
function containerOf(o: unknown): ContainerMeta | null {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const id = str(r['ID'])
  // A container with links lists every name; the first is its own.
  const name = str(r['Names']).split(',')[0] ?? ''
  if (!CONTAINER_REF.test(id) || !CONTAINER_REF.test(name)) return null
  const status = str(r['Status'])
  const labels = labelsOf(r['Labels'])
  return {
    id,
    name,
    image: str(r['Image']),
    state: stateOf(r['State'], status),
    status,
    ports: str(r['Ports']),
    createdAt: str(r['CreatedAt']),
    project: labels.get('com.docker.compose.project') || null,
    service: labels.get('com.docker.compose.service') || null,
  }
}

/** Parses `docker ps` output as it streams, holding at most one line and `max` containers. */
class PsParser {
  readonly containers: ContainerMeta[] = []
  skipped = 0
  truncated = false
  private rest = ''
  private overlong = false

  constructor(private readonly max: number) {}

  push(chunk: string): void {
    let start = 0
    for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
      this.endLine(chunk.slice(start, nl))
      start = nl + 1
    }
    this.add(chunk.slice(start))
  }

  finish(): void {
    if (this.rest !== '' || this.overlong) this.endLine('')
  }

  private add(text: string): void {
    if (this.overlong) return
    this.rest += text
    if (this.rest.length > MAX_PS_LINE) {
      this.overlong = true
      this.rest = ''
    }
  }

  private endLine(text: string): void {
    this.add(text)
    if (this.overlong) this.skipped++
    else this.line(this.rest.trim())
    this.rest = ''
    this.overlong = false
  }

  private line(text: string): void {
    if (text === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.skipped++
      return
    }
    const c = containerOf(parsed)
    if (!c) this.skipped++
    else if (this.containers.length >= this.max) this.truncated = true
    else this.containers.push(c)
  }
}

export interface ContainerServiceDeps {
  links: Pick<ExecLinks, 'lease'>
  environments(): EnvironmentMeta[]
  /** Throws for an unknown host. */
  hostLabel(id: string): string
  isLocked(): boolean
  audit: { append(i: AuditInput): unknown }
  emit(event: 'containers:logs', payload: ContainerLogEvent): void
  now?: () => Date
  ids?: () => string
  /** The lease and exec timeouts and the follow flush timer. */
  timers?: Timers
  /** Test seams; default the constants above, `RUN_OUTPUT_CHARS`, `MAX_CONTAINERS` and `MAX_LOG_FOLLOWS`. */
  leaseTimeoutMs?: number
  execTimeoutMs?: number
  outputCap?: number
  maxContainers?: number
  maxFollows?: number
}

interface Follow {
  id: string
  hostId: string
  label: string
  /** Aborts the lease wait, then the exec. */
  abort: AbortController
  pending: string
  flushTimer: unknown
  stderr: StderrKept
  ended: boolean
}

/**
 * Docker on a host over pooled exec links: list, start/stop/restart, log tails and follows. Every
 * command is an argv joined with `shJoin`, and every ref is checked against `CONTAINER_REF` first.
 * Each call needs an unlocked vault; follows already open keep streaming through a lock. A stopped
 * follow gets `INT` and its channel closes, but `docker logs -f` has no pty, so it may keep running
 * on the host. Actions are audited as `container.*` by `<container>@<host label>`; list and logs are
 * read-only and not audited. Output, stderr and addresses never reach audit.
 */
export class ContainerService {
  private readonly follows = new Map<string, Follow>()
  /** Container names by host and full id from the last list, so audit can name what an id refers to. */
  private readonly names = new Map<string, Map<string, string>>()
  /** The aborts of one-shot commands still running, for quit. */
  private readonly inFlight = new Set<AbortController>()
  private readonly now: () => Date
  private readonly ids: () => string
  private readonly timers: Timers
  private readonly leaseTimeoutMs: number
  private readonly execTimeoutMs: number
  private readonly outputCap: number
  private readonly maxContainers: number
  private readonly maxFollows: number
  /** Set by `closeAll`: nothing starts after quit. */
  private closed = false

  constructor(private readonly deps: ContainerServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
    this.timers = deps.timers ?? realTimers
    this.leaseTimeoutMs = deps.leaseTimeoutMs ?? CONTAINER_LEASE_TIMEOUT_MS
    this.execTimeoutMs = deps.execTimeoutMs ?? CONTAINER_EXEC_TIMEOUT_MS
    this.outputCap = deps.outputCap ?? RUN_OUTPUT_CHARS
    this.maxContainers = deps.maxContainers ?? MAX_CONTAINERS
    this.maxFollows = deps.maxFollows ?? MAX_LOG_FOLLOWS
  }

  async list(hostId: string, environmentId: string | null): Promise<ContainerList> {
    this.assertOpen()
    const label = this.deps.hostLabel(hostId)
    this.assertUnlocked()
    const parser = new PsParser(this.maxContainers)
    await this.runOnce(hostId, environmentId, label, LIST_ARGV, (chunk, stream) => stream === 'out' && parser.push(chunk))
    parser.finish()
    this.names.set(hostId, new Map(parser.containers.map((c) => [c.id, c.name])))
    return { containers: parser.containers, truncated: parser.truncated, skipped: parser.skipped, fetchedAt: this.now().toISOString() }
  }

  /** `stop` and `restart` need the environment's name typed when the host serves a protected one (G9, F7). */
  async action(hostId: string, environmentId: string | null, ref: string, action: ContainerAction, confirm?: string): Promise<void> {
    this.assertOpen()
    checkContainerRef(ref)
    if (!(CONTAINER_ACTIONS as readonly string[]).includes(action)) throw new Error('action must be start, stop or restart')
    const label = this.deps.hostLabel(hostId)
    const details = { hostId, environmentId, ...containerAuditId(ref) }
    const audit = (outcome: AuditInput['outcome'], extra: Record<string, unknown> = {}): void =>
      void this.deps.audit.append({
        action: `container.${action}`,
        outcome,
        targetType: 'container',
        targetLabel: `${this.names.get(hostId)?.get(ref) ?? shortRef(ref)}@${label}`,
        details: { ...details, ...extra },
      })
    if (this.deps.isLocked()) {
      audit('denied', { reason: 'locked' })
      throw new Error(VAULT_LOCKED)
    }
    let confirmed = false
    try {
      const envs = this.deps.environments()
      const context = environmentId === null ? null : envs.find((e) => e.id === environmentId)
      if (context === undefined) {
        audit('denied', { reason: 'environment' })
        throw new Error('environment not found')
      }
      const memberships = envs.filter((e) => e.hosts.some((m) => m.hostId === hostId))
      const needed = confirmNeeded(protectionFor(context, memberships), 1, action !== 'start')
      checkConfirm(needed, confirm)
      confirmed = needed !== null
    } catch (err) {
      if (err instanceof ProtectError) audit('denied', { reason: err.code })
      throw err
    }
    try {
      await this.runOnce(hostId, environmentId, label, ['docker', action, ref])
    } catch (err) {
      audit('failure')
      throw err
    }
    audit('success', confirmed ? { confirmed: true } : {})
  }

  /** The last `tail` lines, stdout and stderr interleaved, capped at `RUN_OUTPUT_CHARS` from the end. */
  async logs(hostId: string, environmentId: string | null, ref: string, tail: number): Promise<string> {
    this.assertOpen()
    checkContainerRef(ref)
    checkTail(tail)
    const label = this.deps.hostLabel(hostId)
    this.assertUnlocked()
    const ring = new OutputRing(this.outputCap)
    await this.runOnce(hostId, environmentId, label, logsArgv(ref, tail, false), (chunk, stream) => ring.append(chunk, stream), true)
    return ring.snapshot().text
  }

  /**
   * Resolves with the follow's id once its lease is held; lines then arrive as `containers:logs`
   * events, batched like run output, and one `ended` event closes it. At most `MAX_LOG_FOLLOWS` per
   * host, so the link keeps channels for list and actions.
   */
  async follow(hostId: string, environmentId: string | null, ref: string, tail: number): Promise<string> {
    this.assertOpen()
    checkContainerRef(ref)
    checkTail(tail)
    const label = this.deps.hostLabel(hostId)
    this.assertUnlocked()
    const open = [...this.follows.values()].filter((f) => f.hostId === hostId).length
    if (open >= this.maxFollows) throw new Error(`${label} already has ${this.maxFollows} log follows open; stop one first`)
    const f: Follow = {
      id: this.ids(),
      hostId,
      label,
      abort: new AbortController(),
      pending: '',
      flushTimer: null,
      stderr: new StderrKept(true),
      ended: false,
    }
    this.follows.set(f.id, f)
    let lease: Lease
    try {
      lease = await this.lease(hostId, environmentId, label, f.abort)
    } catch (err) {
      this.follows.delete(f.id)
      throw err
    }
    void execOnce(lease.client, shJoin(logsArgv(ref, tail, true)), {
      env: lease.envVars,
      signal: f.abort.signal,
      timers: this.timers,
      onData: (chunk, stream) => this.followData(f, chunk, stream),
    })
      .then(
        (r) => this.endFollow(f, r.cancelled ? null : exitError(label, r, f.stderr)),
        (err: unknown) => this.endFollow(f, errorOf(err)),
      )
      .finally(() => lease.release())
      // Nothing awaits this chain; a failing emit (a closing window) must not become an unhandled rejection.
      .catch((err: unknown) => console.warn('Container log follow bookkeeping failed:', redact(err instanceof Error ? err.message : String(err))))
    return f.id
  }

  /**
   * Ends the follow at once (its `ended` event goes out now); an unknown or ended id is a no-op. The
   * follow stops counting toward `MAX_LOG_FOLLOWS` here, but its channel stays open for up to
   * `STOP_GRACE_MS` after the `INT`. So a quick stop-and-start can briefly hold one channel more
   * than the cap allows, and a list or action may queue behind it until the old channel closes.
   */
  unfollow(followId: string): void {
    const f = this.follows.get(followId)
    if (!f) return
    f.abort.abort()
    this.endFollow(f, null)
  }

  /** The renderer reloaded or crashed: its follows have no viewer left, so each is stopped and stops counting. */
  unfollowAll(): void {
    for (const f of [...this.follows.values()]) {
      f.abort.abort()
      this.endFollow(f, null)
    }
  }

  /** Quit: stops every follow and one-shot command; nothing starts afterwards. */
  closeAll(): void {
    this.closed = true
    for (const abort of this.inFlight) abort.abort()
    this.unfollowAll()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(QUITTING)
  }

  private assertUnlocked(): void {
    if (this.deps.isLocked()) throw new Error(VAULT_LOCKED)
  }

  /** A lease bounded by `leaseTimeoutMs`. A timeout, a quit and a dropped link all reject `closed`; only our own signal tells them apart. */
  private async lease(hostId: string, environmentId: string | null, label: string, abort: AbortController): Promise<Lease> {
    let timedOut = false
    const timer = this.timers.setTimeout(() => {
      timedOut = true
      abort.abort()
    }, this.leaseTimeoutMs)
    try {
      return await this.deps.links.lease(hostId, environmentId, { id: `containers:${hostId}` }, abort.signal)
    } catch (err) {
      if (timedOut) throw new Error(`Timed out waiting for a connection to ${label}`)
      if (abort.signal.aborted) throw new Error(QUITTING)
      throw err
    } finally {
      this.timers.clearTimeout(timer)
    }
  }

  /** Runs one docker command, holding its lease until the exec has ended; throws its error when docker didn't exit 0. */
  private async runOnce(
    hostId: string,
    environmentId: string | null,
    label: string,
    argv: string[],
    onData: (chunk: string, stream: 'out' | 'err') => void = () => {},
    isLogs = false,
  ): Promise<void> {
    const abort = new AbortController()
    this.inFlight.add(abort)
    try {
      const lease = await this.lease(hostId, environmentId, label, abort)
      const stderr = new StderrKept(isLogs)
      try {
        const r = await execOnce(lease.client, shJoin(argv), {
          env: lease.envVars,
          signal: abort.signal,
          timeoutMs: this.execTimeoutMs,
          timers: this.timers,
          onData: (chunk, stream) => {
            if (stream === 'err') stderr.push(chunk)
            onData(chunk, stream)
          },
        })
        if (r.cancelled) throw new Error(QUITTING)
        if (r.timedOut) {
          throw new Error(`docker didn't finish on ${label} within ${Math.round(this.execTimeoutMs / 1000)}s (it may still be running there)`)
        }
        const error = exitError(label, r, stderr)
        if (error) throw new Error(error.message)
      } finally {
        lease.release()
      }
    } finally {
      this.inFlight.delete(abort)
    }
  }

  private followData(f: Follow, chunk: string, stream: 'out' | 'err'): void {
    if (f.ended) return
    if (stream === 'err') f.stderr.push(chunk)
    f.pending += chunk
    if (f.pending.length >= OUTPUT_FLUSH_CHARS) this.flush(f)
    else if (f.flushTimer === null) f.flushTimer = this.timers.setTimeout(() => this.flush(f), OUTPUT_FLUSH_MS)
  }

  private flush(f: Follow): void {
    if (f.flushTimer !== null) this.timers.clearTimeout(f.flushTimer)
    f.flushTimer = null
    if (f.pending === '') return
    const chunk = f.pending
    f.pending = ''
    this.deps.emit('containers:logs', { followId: f.id, chunk })
  }

  /** Once: the pending lines, then `ended`. */
  private endFollow(f: Follow, error: SessionError | null): void {
    if (f.ended) return
    this.flush(f)
    f.ended = true
    this.follows.delete(f.id)
    this.deps.emit('containers:logs', { followId: f.id, ended: true, error })
  }
}
