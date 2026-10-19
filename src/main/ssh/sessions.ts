import { randomUUID } from 'node:crypto'
import type { Client, ClientChannel } from 'ssh2'
import type { AuditInput } from '../../shared/audit'
import type { EventContract, EventName } from '../../shared/ipc'
import type { IdentityRef, ResolvedHost } from '../../shared/inventory'
import {
  DEFAULT_KEEPALIVE_SEC,
  FLUSH_CHARS,
  FLUSH_MS,
  MAX_SESSIONS,
  SCROLLBACK_CHARS,
  SESSION_LIMIT,
  type OpenLocalRequest,
  type OpenSshRequest,
  type PromptAnswer,
  type SessionError,
  type SessionMeta,
} from '../../shared/ssh'
import { VAULT_LOCKED } from '../../shared/vault'
import { checkContainerRef, containerAuditId, containerExecArgv, shortRef } from '../ops/containers'
import { shJoin } from '../ops/quote'
import { redact } from '../security/redact'
import type { AuthPlan } from './auth'
import { describeError, hopsOf } from './connect'
import type { ConnectDeps, HopTarget, connectChain } from './connect'
import type { KnownHostStore } from './known-hosts'
import { verifyWithStore, type PromptBody, type PromptBroker } from './prompts'

/** The SSH shell stream and node-pty both adapt to this. */
export interface Pty {
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(cb: (chunk: Buffer | string) => void): void
  onExit(cb: (info: { code: number | null }) => void): void
  kill(): void
}

export type CloseReason = 'user' | 'remote' | 'error' | 'quit' | 'reset'
type AuthAudit = AuthPlan['kind'] | 'prompt'

export interface SessionManagerDeps {
  resolve(hostId: string, environmentId?: string): ResolvedHost
  hostInfo(hostId: string): { label: string; keepaliveSec: number | null; envVars: Record<string, string> }
  envColor(environmentId: string): string | null
  connect: typeof connectChain
  plan(identity: IdentityRef, hop: HopTarget): Promise<AuthPlan>
  knownHosts: Pick<KnownHostStore, 'check' | 'trust' | 'recordMismatch'>
  /** Shared with tunnels; `session:answer` and `session:prompts` go to it directly. */
  prompts: PromptBroker
  /** Spawns the local shell; absent when it isn't available. */
  openLocal?: (req: OpenLocalRequest) => Pty
  audit: { append(input: AuditInput): unknown }
  /** While locked, no connect starts and no prompt is raised. */
  isLocked(): boolean
  emit<K extends EventName>(event: K, payload: EventContract[K]): void
  now?: () => Date
  ids?: () => string
}

export class SessionLimitError extends Error {
  readonly code = 'limit' as const
  constructor() {
    super(SESSION_LIMIT)
    this.name = 'SessionLimitError'
  }
}

const RECONNECTED = '\r\n\x1b[2m── reconnected ──\x1b[0m\r\n'
const LOCAL_LABEL = 'Local shell'

/** Keeps the last SCROLLBACK_CHARS of output, trimmed from the front. */
class Scrollback {
  private chunks: string[] = []
  private size = 0

  append(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    while (this.size - this.chunks[0].length >= SCROLLBACK_CHARS) this.size -= this.chunks.shift()!.length
    if (this.size > SCROLLBACK_CHARS) {
      let first = this.chunks[0].slice(this.size - SCROLLBACK_CHARS)
      // Never start on the second half of a surrogate pair.
      if (/^[\uDC00-\uDFFF]/.test(first)) first = first.slice(1)
      this.size -= this.chunks[0].length - first.length
      this.chunks[0] = first
    }
  }

  text(): string {
    const all = this.chunks.join('')
    this.chunks = all ? [all] : []
    return all
  }
}

/** One connect attempt, or one local shell: what a close or a lock has to cancel. */
interface Attempt {
  readonly abort: AbortController
  /** The broker group of the prompts this attempt raised. */
  readonly prompts: Set<string>
  /** The hop being dialled, then the one that failed: the one a dial error names. */
  hop: number
  failedHop: number | null
  auth: AuthAudit
  /** Ends every client of the chain; idempotent. */
  close: (() => void) | null
  /** SSH only, while dialling: fails the attempt as if the dial had thrown `err`. */
  fail: ((err: unknown) => void) | null
}

interface Session {
  meta: SessionMeta
  cols: number
  rows: number
  scrollback: Scrollback
  pending: string
  /** Chars ever appended to the scrollback, pending ones included; never shrinks on trim. */
  end: number
  flushTimer: NodeJS.Timeout | null
  pty: Pty | null
  /** Set while connecting or ready. */
  attempt: Attempt | null
  readyAtMs: number
  /** The host's own label: `meta.label` reads `<ref>@<host>` on a container tab, the ssh.* audit keeps the host. */
  hostLabel: string
}

interface DialTarget {
  hops: HopTarget[]
  /** Parallel to `hops`. */
  hostIds: string[]
  label: string
  environmentId: string | null
  color: string | null
  keepaliveSec: number
  envVars: Record<string, string>
}

const snapshot = (m: SessionMeta): SessionMeta => ({
  ...m,
  hops: m.hops.map((h) => ({ ...h })),
  error: m.error ? structuredClone(m.error) : null,
})

const once = (fn: () => void): (() => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/** A container tab reads `<ref>@<host>`, a full id as its 12-char short id. */
const tabLabel = (container: string | null, hostLabel: string): string =>
  container === null ? hostLabel : `${shortRef(container)}@${hostLabel}`

/** A drop after ready: never the dial-time "didn't answer within 20 s" text. */
function lostError(label: string, err: unknown): SessionError {
  const e = (err ?? {}) as { level?: unknown; message?: unknown }
  if (e.level === 'client-timeout') {
    return { code: 'closed', message: `The connection to ${label} was lost: the server stopped answering keepalives` }
  }
  const why = typeof e.message === 'string' && e.message ? `: ${redact(e.message)}` : ''
  return { code: 'closed', message: `The connection to ${label} was lost${why}` }
}

function shellPty(stream: ClientChannel): Pty {
  // A channel error is followed by 'close'; the reason comes from the client's 'error'.
  stream.on('error', () => {})
  return {
    write: (data) => void stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    onData: (cb) => {
      stream.on('data', cb)
      stream.stderr.on('data', cb)
    },
    onExit: (cb) => {
      let code: number | null = null
      stream.on('exit', (c: unknown) => {
        code = typeof c === 'number' ? c : null
      })
      stream.once('close', () => cb({ code }))
    },
    kill: () => stream.close(),
  }
}

/**
 * Open terminal sessions: SSH over a hop chain, or a local shell. Owns each session's scrollback,
 * batches its output into `session:data` events, and raises the prompts a connect needs.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private localCount = 0
  private readonly now: () => Date
  private readonly ids: () => string

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? ((): Date => new Date())
    this.ids = deps.ids ?? randomUUID
  }

  openSsh(req: OpenSshRequest): SessionMeta {
    this.assertUnlocked()
    this.assertRoom()
    const container = req.container === undefined ? null : checkContainerRef(req.container)
    const target = this.target(req.hostId, req.environmentId)
    const s = this.create('ssh', req, tabLabel(container, target.label), req.hostId, target)
    s.meta.container = container
    this.dial(s, target)
    return snapshot(s.meta)
  }

  openLocal(req: OpenLocalRequest): SessionMeta {
    if (!this.deps.openLocal) throw new Error("The local shell isn't available")
    this.assertRoom()
    const pty = this.deps.openLocal(req)
    // Counts every local shell this run has opened, so closing one never reuses a number.
    const n = ++this.localCount
    const s = this.create('local', req, n === 1 ? LOCAL_LABEL : `${LOCAL_LABEL} ${n}`, null, null)
    const attempt = this.newAttempt(s)
    this.ready(s, attempt, pty, () => this.finish(s, attempt, 'remote', null))
    return snapshot(s.meta)
  }

  /** SSH only, from `closed` or `failed`: the same tab dials again. */
  reconnect(id: string): SessionMeta {
    const s = this.get(id)
    if (s.meta.kind !== 'ssh' || !s.meta.hostId) throw new Error("A local shell can't be reconnected; open a new one")
    if (s.meta.state !== 'closed' && s.meta.state !== 'failed') throw new Error('Only a closed or failed session can be reconnected')
    this.assertUnlocked()
    this.assertRoom()
    const target = this.target(s.meta.hostId, s.meta.environmentId ?? undefined)
    s.hostLabel = target.label
    Object.assign(s.meta, {
      label: tabLabel(s.meta.container, target.label),
      color: target.color,
      state: 'connecting',
      error: null,
      readyAt: null,
      closedAt: null,
      attempt: s.meta.attempt + 1,
    })
    this.dial(s, target)
    return snapshot(s.meta)
  }

  /** Dropped silently unless the session is ready. */
  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s?.meta.state === 'ready') s.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.cols = cols
    s.rows = rows
    if (s.meta.state === 'ready') s.pty?.resize(cols, rows)
  }

  /** Ends the session and forgets it. */
  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.attempt) this.finish(s, s.attempt, 'user', null)
    this.forget(s)
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => snapshot(s.meta))
  }

  /** `end` is the stream offset the buffer reaches; later session:data events carry theirs. */
  attach(id: string): { meta: SessionMeta; buffer: string; end: number } {
    const s = this.get(id)
    return { meta: snapshot(s.meta), buffer: s.scrollback.text(), end: s.end }
  }

  /**
   * On vault lock: every SSH connect still dialling fails as locked, cancelling its prompts, so
   * nothing asks behind the lock screen. Ready sessions keep running. The broker's other prompts
   * are the lock hook's to cancel.
   */
  vaultLocked(): void {
    for (const s of [...this.sessions.values()]) {
      if (s.meta.state === 'connecting') s.attempt?.fail?.(new Error(VAULT_LOCKED))
    }
  }

  /** Ends and forgets every session, SSH and local, scrollback included: on quit and on a vault reset. */
  closeAll(reason: 'quit' | 'reset'): void {
    for (const s of [...this.sessions.values()]) {
      if (s.attempt) this.finish(s, s.attempt, reason, null)
      this.forget(s)
    }
  }

  private get(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error('session not found')
    return s
  }

  private assertUnlocked(): void {
    if (this.deps.isLocked()) throw new Error(VAULT_LOCKED)
  }

  private assertRoom(): void {
    let open = 0
    for (const s of this.sessions.values()) if (s.meta.state === 'connecting' || s.meta.state === 'ready') open++
    if (open >= MAX_SESSIONS) throw new SessionLimitError()
  }

  private target(hostId: string, environmentId?: string): DialTarget {
    const resolved = this.deps.resolve(hostId, environmentId)
    const info = this.deps.hostInfo(hostId)
    return {
      hops: hopsOf(resolved, info.label),
      hostIds: [...resolved.chain.map((h) => h.hostId), hostId],
      label: info.label,
      environmentId: resolved.environmentId,
      color: resolved.environmentId ? this.deps.envColor(resolved.environmentId) : null,
      keepaliveSec: info.keepaliveSec ?? DEFAULT_KEEPALIVE_SEC,
      envVars: info.envVars,
    }
  }

  private create(
    kind: SessionMeta['kind'],
    size: { cols: number; rows: number },
    label: string,
    hostId: string | null,
    target: DialTarget | null,
  ): Session {
    const s: Session = {
      meta: {
        id: this.ids(),
        kind,
        hostId,
        environmentId: target?.environmentId ?? null,
        label,
        color: target?.color ?? null,
        state: 'connecting',
        hops: [],
        error: null,
        openedAt: this.now().toISOString(),
        readyAt: null,
        closedAt: null,
        attempt: 1,
        container: null,
      },
      cols: size.cols,
      rows: size.rows,
      scrollback: new Scrollback(),
      pending: '',
      end: 0,
      flushTimer: null,
      pty: null,
      attempt: null,
      readyAtMs: 0,
      hostLabel: target?.label ?? label,
    }
    this.sessions.set(s.meta.id, s)
    return s
  }

  private forget(s: Session): void {
    this.flush(s)
    this.sessions.delete(s.meta.id)
  }

  private newAttempt(s: Session): Attempt {
    const attempt: Attempt = { abort: new AbortController(), prompts: new Set(), hop: 0, failedHop: null, auth: 'default', close: null, fail: null }
    s.attempt = attempt
    return attempt
  }

  private isLive(s: Session, attempt: Attempt): boolean {
    return s.attempt === attempt && this.sessions.get(s.meta.id) === s
  }

  private dial(s: Session, target: DialTarget): void {
    s.meta.hops = target.hops.map((h) => ({ label: h.label, state: 'pending' }))
    const attempt = this.newAttempt(s)
    attempt.fail = (err) => {
      attempt.abort.abort()
      this.dialFailed(s, attempt, target, err)
    }
    this.publish(s)
    const targetHop = target.hops.at(-1)
    const deps: ConnectDeps = {
      plan: async (identity, hop) => {
        const plan = await this.deps.plan(identity, hop)
        if (attempt.hop === target.hops.length - 1) attempt.auth = plan.kind
        return plan
      },
      verifyHostKey: (hop, keyType, keyBase64) =>
        verifyWithStore(this.deps.knownHosts, this.deps.prompts, {
          ownerId: s.meta.id,
          group: attempt.prompts,
          hop,
          hostId: target.hostIds[target.hops.indexOf(hop)] ?? null,
          keyType,
          keyBase64,
          isLive: () => this.isLive(s, attempt),
          onLocked: () => attempt.fail?.(new Error(VAULT_LOCKED)),
        }),
      askPassword: async (hop, username) => {
        const a = await this.ask(s, attempt, { kind: 'password', hopLabel: hop.label, username })
        const password = a?.kind === 'password' ? a.password : null
        if (password !== null && hop === targetHop) attempt.auth = 'prompt'
        return password
      },
      askKeyboard: async (hop, name, instructions, prompts) => {
        const a = await this.ask(s, attempt, { kind: 'keyboard', hopLabel: hop.label, name, instructions, prompts })
        return a?.kind === 'keyboard' ? a.responses : null
      },
      onHop: (i, state) => {
        if (!this.isLive(s, attempt)) return
        if (state === 'connecting') attempt.hop = i
        if (state === 'failed') attempt.failedHop = i
        s.meta.hops[i] = { ...s.meta.hops[i], state }
        this.publish(s)
      },
      keepaliveSec: target.keepaliveSec,
    }
    this.deps
      .connect(target.hops, deps, attempt.abort.signal)
      .then(
        (chain) => this.openShell(s, attempt, target, chain),
        (err: unknown) => this.dialFailed(s, attempt, target, err),
      )
      .catch((err: unknown) => console.error('Session bookkeeping failed:', redact(err instanceof Error ? err.message : String(err))))
  }

  private openShell(s: Session, attempt: Attempt, target: DialTarget, chain: { client: Client; close(): void }): void {
    attempt.close = once(() => chain.close())
    if (!this.isLive(s, attempt)) return attempt.close()
    const { client } = chain
    let lastError: unknown = null
    client.on('error', (err) => {
      lastError = err
    })
    // The target closing on its own (or a jump under it): end the rest of the chain too.
    client.on('close', () => {
      if (!this.isLive(s, attempt)) return
      if (s.meta.state === 'ready') this.finish(s, attempt, 'error', lostError(target.label, lastError))
      else this.dialFailed(s, attempt, target, lastError ?? new Error('The server closed the connection'))
    })
    const onShell = (err: Error | undefined, stream: ClientChannel): void => {
      if (err) {
        if (this.isLive(s, attempt)) this.auditExec(s, 'failure')
        return this.dialFailed(s, attempt, target, err)
      }
      if (!this.isLive(s, attempt)) {
        stream.close()
        return attempt.close?.()
      }
      this.auditExec(s, 'success')
      let exited = false
      stream.once('exit', () => {
        exited = true
      })
      const pty = shellPty(stream)
      // A resize while the shell request was in flight was only stored; apply it now.
      if (s.cols !== sent.cols || s.rows !== sent.rows) pty.resize(s.cols, s.rows)
      this.ready(s, attempt, pty, () =>
        exited ? this.finish(s, attempt, 'remote', null) : this.finish(s, attempt, 'error', lostError(target.label, lastError)),
      )
    }
    const sent = { cols: s.cols, rows: s.rows }
    try {
      // A server may refuse the env vars; ssh2 doesn't wait for a reply, so that is ignored.
      const { container } = s.meta
      if (container === null) client.shell({ term: 'xterm-256color', ...sent }, { env: target.envVars }, onShell)
      // A container tab: `docker exec -it` on a pty in place of the login shell, again on each reconnect.
      else client.exec(shJoin(containerExecArgv(container)), { pty: { term: 'xterm-256color', ...sent }, env: target.envVars }, onShell)
    } catch (err) {
      this.dialFailed(s, attempt, target, err)
    }
  }

  private ready(s: Session, attempt: Attempt, pty: Pty, onExit: () => void): void {
    s.pty = pty
    const decoder = new TextDecoder('utf-8')
    if (s.meta.attempt > 1) this.output(s, RECONNECTED)
    pty.onData((chunk) => {
      if (s.pty !== pty) return
      this.output(s, typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
    })
    pty.onExit(() => onExit())
    const now = this.now()
    s.readyAtMs = now.getTime()
    s.meta.state = 'ready'
    s.meta.readyAt = now.toISOString()
    this.publish(s)
    this.auditOpen(s, 'success', { hops: s.meta.hops.length, auth: attempt.auth })
  }

  private dialFailed(s: Session, attempt: Attempt, target: DialTarget, err: unknown): void {
    if (!this.isLive(s, attempt)) return
    s.attempt = null
    this.cancelAttemptPrompts(attempt)
    attempt.close?.()
    const hop = target.hops[attempt.failedHop ?? attempt.hop] ?? null
    const error =
      err instanceof Error && err.message === VAULT_LOCKED
        ? { code: 'locked' as const, message: 'Unlock the vault to connect', ...(hop ? { hopLabel: hop.label } : {}) }
        : describeError(err, hop)
    Object.assign(s.meta, { state: 'failed', error, closedAt: this.now().toISOString() })
    this.publish(s)
    this.auditOpen(s, 'failure', { hops: s.meta.hops.length, code: error.code })
  }

  /** Ends a connecting or ready attempt. Only a ready one audits a close. */
  private finish(s: Session, attempt: Attempt, reason: CloseReason, error: SessionError | null): void {
    if (s.attempt !== attempt) return
    s.attempt = null
    attempt.abort.abort()
    this.cancelAttemptPrompts(attempt)
    const wasReady = s.meta.state === 'ready'
    s.pty?.kill()
    s.pty = null
    attempt.close?.()
    const now = this.now()
    Object.assign(s.meta, { state: error ? 'failed' : 'closed', error, closedAt: now.toISOString() })
    this.publish(s)
    if (!wasReady) return
    this.audit({
      action: s.meta.kind === 'ssh' ? 'ssh.close' : 'shell.close',
      outcome: 'info',
      ...this.auditTarget(s),
      details: {
        ...(s.meta.environmentId ? { environmentId: s.meta.environmentId } : {}),
        ...(s.meta.container ? { container: s.meta.container } : {}),
        durationSec: Math.round((now.getTime() - s.readyAtMs) / 1000),
        reason,
      },
    })
  }

  private auditOpen(s: Session, outcome: 'success' | 'failure', details: Record<string, unknown>): void {
    this.audit({
      action: s.meta.kind === 'ssh' ? 'ssh.open' : 'shell.open',
      outcome,
      ...this.auditTarget(s),
      details: {
        ...(s.meta.environmentId ? { environmentId: s.meta.environmentId } : {}),
        ...(s.meta.container ? { container: s.meta.container } : {}),
        ...(s.meta.kind === 'ssh' ? details : {}),
      },
    })
  }

  /** Runs inside ssh2 callbacks, so a failing audit write must not throw out of them. */
  private audit(entry: AuditInput): void {
    try {
      this.deps.audit.append(entry)
    } catch (err) {
      console.warn(`Session audit write failed (${entry.action}):`, redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** Once per container tab attempt: when the exec channel is accepted, or refused. */
  private auditExec(s: Session, outcome: 'success' | 'failure'): void {
    const ref = s.meta.container
    if (ref === null) return
    this.audit({
      action: 'container.exec',
      outcome,
      targetType: 'container',
      targetLabel: s.meta.label,
      details: {
        hostId: s.meta.hostId,
        environmentId: s.meta.environmentId,
        ...containerAuditId(ref),
      },
    })
  }

  private auditTarget(s: Session): Pick<AuditInput, 'targetType' | 'targetId' | 'targetLabel'> {
    return s.meta.kind === 'ssh'
      ? { targetType: 'host', targetId: s.meta.hostId ?? undefined, targetLabel: s.hostLabel }
      : { targetType: 'shell', targetLabel: LOCAL_LABEL }
  }

  /** Never asks while locked: the attempt fails as locked instead of waiting on a hidden prompt. */
  private async ask(s: Session, attempt: Attempt, body: PromptBody): Promise<PromptAnswer | null> {
    if (!this.isLive(s, attempt)) return null
    const answer = await this.deps.prompts.ask(s.meta.id, attempt.prompts, body)
    if (answer !== 'locked') return answer
    attempt.fail?.(new Error(VAULT_LOCKED))
    return null
  }

  private cancelAttemptPrompts(attempt: Attempt): void {
    this.deps.prompts.cancel(attempt.prompts)
  }

  private output(s: Session, text: string): void {
    if (!text) return
    s.scrollback.append(text)
    s.end += text.length
    s.pending += text
    if (s.pending.length >= FLUSH_CHARS) this.flush(s)
    else s.flushTimer ??= setTimeout(() => this.flush(s), FLUSH_MS)
  }

  private flush(s: Session): void {
    if (s.flushTimer) clearTimeout(s.flushTimer)
    s.flushTimer = null
    if (!s.pending) return
    const data = s.pending
    s.pending = ''
    this.deps.emit('session:data', { id: s.meta.id, data, end: s.end })
  }

  /** Pending output goes first, so a state change never overtakes the data before it. */
  private publish(s: Session): void {
    this.flush(s)
    this.deps.emit('session:state', snapshot(s.meta))
  }
}
