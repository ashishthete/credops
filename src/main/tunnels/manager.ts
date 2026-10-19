import type { Server } from 'node:net'
import type { Client } from 'ssh2'
import type { AuditInput } from '../../shared/audit'
import type { EventContract } from '../../shared/ipc'
import type { IdentityRef, ResolvedHost } from '../../shared/inventory'
import type { PromptAnswer } from '../../shared/ssh'
import {
  DEFAULT_MAX_FAILURES,
  MAX_RUNNING_TUNNELS,
  PROBE_INTERVAL_MS,
  STABLE_MS,
  STATS_MS,
  TUNNEL_KEEPALIVE_SEC,
  TUNNEL_LIMIT,
  isLoopback,
  type TunnelError,
  type TunnelEvent,
  type TunnelMeta,
  type TunnelRuntime,
  type TunnelStopReason,
} from '../../shared/tunnels'
import { VAULT_LOCKED } from '../../shared/vault'
import { redact } from '../security/redact'
import type { AuthPlan } from '../ssh/auth'
import { describeError, hopsOf } from '../ssh/connect'
import type { ConnectDeps, HopTarget, connectChain } from '../ssh/connect'
import type { KnownHostStore } from '../ssh/known-hosts'
import { verifyWithStore, type PromptBody, type PromptBroker } from '../ssh/prompts'
import { backoffMs, isRetryable } from './backoff'
import { BindError } from './bind'
import {
  Counter,
  ForwardError,
  ProbeTokens,
  realTimers,
  startLocal,
  startRemote,
  type ForwardHandle,
  type ForwardOut,
  type Timers,
} from './forward'
import { startDynamic } from './socks5'
import type { TunnelStore } from './tunnel-store'

type ForwardOutCallback = (err: Error | undefined, channel: Parameters<NonNullable<Parameters<Client['forwardOut']>[4]>>[1]) => void
type TunnelPush = 'tunnel:state' | 'tunnel:stats' | 'tunnel:event'
type Trigger = 'user' | 'auto'

export interface TunnelEngines {
  startLocal: typeof startLocal
  startRemote: typeof startRemote
  startDynamic: typeof startDynamic
}

export interface TunnelManagerDeps {
  store: Pick<TunnelStore, 'list' | 'get'>
  resolve(hostId: string, environmentId?: string): ResolvedHost
  hostInfo(hostId: string): { label: string; keepaliveSec: number | null }
  connect: typeof connectChain
  plan(identity: IdentityRef): Promise<AuthPlan>
  knownHosts: Pick<KnownHostStore, 'check' | 'trust' | 'recordMismatch'>
  prompts: PromptBroker
  isLocked(): boolean
  /** `bind.listen` bound with the real `whoHolds`; the manager supplies the check for its own tunnels. */
  listen(address: string, port: number, deps: { inUseBy(address: string, port: number): string | null }): Promise<Server>
  audit: { append(input: AuditInput): unknown }
  emit<K extends TunnelPush>(event: K, payload: EventContract[K]): void
  /** Backoff, probe and stable timers. */
  timers?: Timers
  /** The stats loop's own timers, so stepping one never fires the other; defaults to `timers`. */
  statsTimers?: Timers
  now?: () => Date
  maxFailures?: number
  /** Test seam: wrap the real engines to stub a probe. */
  engines?: TunnelEngines
}

export class TunnelLimitError extends Error {
  readonly code = 'limit' as const
  constructor() {
    super(TUNNEL_LIMIT)
    this.name = 'TunnelLimitError'
  }
}

const LOCKED: TunnelError = { code: 'locked', message: 'Waiting for unlock' }

/** Changing any of these on a running tunnel restarts it; a label or flag change doesn't. */
const RESTART_FIELDS = ['hostId', 'environmentId', 'type', 'bindAddress', 'bindPort', 'targetHost', 'targetPort'] as const

/** How a failure is handled: `stage` says what has to be redone, `locked` pauses instead of counting. */
interface Failure {
  error: TunnelError
  retryable: boolean
  locked: boolean
  stage: 'link' | 'open' | 'probe'
}

/** A dial that failed, as every subscriber waiting on it sees it. */
class LinkFailure extends Error {
  constructor(readonly failure: Omit<Failure, 'stage'>) {
    super(failure.error.message)
    this.name = 'LinkFailure'
  }
}

/** Resolve and auth-plan errors: the saved config is wrong, so retrying can't help. */
class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** One SSH connection per `hostId|environmentId`, shared by the tunnels running over it. */
interface HostLink {
  key: string
  label: string
  state: 'dialing' | 'ready' | 'down'
  client: Client | null
  close: (() => void) | null
  ready: Promise<void>
  subscribers: Set<Run>
  /** The broker group for this dial's prompts; cancelled only when the last subscriber leaves. */
  prompts: Set<string>
  /** The tunnel that triggered the dial, shown as the prompts' owner. */
  owner: string
  abort: AbortController
  /** The vault locked while this dial was in flight, so its failure pauses. */
  lockedDuringDial: boolean
  hop: number
  failedHop: number | null
}

interface Run {
  meta: TunnelMeta
  key: string
  trigger: Trigger
  rt: TunnelRuntime
  /** Bumped by every attempt, failure and release, so a late async result can tell it is stale. */
  gen: number
  released: boolean
  link: HostLink | null
  handle: ForwardHandle | null
  /** An `L`/`D` listener being opened, shared so two attempts never bind twice. */
  opening: Promise<ForwardHandle> | null
  counter: Counter
  tokens: ProbeTokens
  retryTimer: unknown
  probeTimer: unknown
  stableTimer: unknown
  probing: boolean
  paused: boolean
  everUp: boolean
  firstUpMs: number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const sameAddress = (a: string, b: string): boolean => {
  const norm = (s: string): string => (s.trim().toLowerCase() === 'localhost' ? '127.0.0.1' : s.trim().toLowerCase())
  return norm(a) === norm(b)
}
const cloneRuntime = (rt: TunnelRuntime): TunnelRuntime => ({ ...rt, error: rt.error ? { ...rt.error } : null })

/**
 * Runs saved tunnels: shared host links, per-tunnel liveness, retry with backoff, the vault lock
 * policy (pause, never fail) and auto-start on the first unlock.
 */
export class TunnelManager {
  private readonly runs = new Map<string, Run>()
  /** Runtimes of tunnels that failed, kept until they are started or stopped again. */
  private readonly last = new Map<string, TunnelRuntime>()
  private readonly links = new Map<string, HostLink>()
  private readonly listeners = new Set<(e: TunnelEvent) => void>()
  private readonly timers: Timers
  private readonly statsTimers: Timers
  private readonly now: () => Date
  private readonly maxFailures: number
  private readonly engines: TunnelEngines
  private statsTimer: unknown = null
  private autoStarted = false

  constructor(private readonly deps: TunnelManagerDeps) {
    this.timers = deps.timers ?? realTimers
    this.statsTimers = deps.statsTimers ?? this.timers
    this.now = deps.now ?? ((): Date => new Date())
    this.maxFailures = deps.maxFailures ?? DEFAULT_MAX_FAILURES
    this.engines = deps.engines ?? { startLocal, startRemote, startDynamic }
  }

  /** Returns at once in `connecting`; a tunnel that is already running is returned as it is. */
  start(id: string, trigger: Trigger = 'user'): TunnelRuntime {
    if (this.deps.isLocked()) throw new Error(VAULT_LOCKED)
    const running = this.runs.get(id)
    if (running) return cloneRuntime(running.rt)
    if (this.runs.size >= MAX_RUNNING_TUNNELS) throw new TunnelLimitError()
    const meta = this.deps.store.get(id)
    this.last.delete(id)
    const run: Run = {
      meta,
      key: `${meta.hostId}|${meta.environmentId ?? ''}`,
      trigger,
      rt: { ...this.stoppedRuntime(id), state: 'connecting', startedAt: this.now().toISOString() },
      gen: 0,
      released: false,
      link: null,
      handle: null,
      opening: null,
      counter: new Counter(() => this.now().getTime()),
      tokens: new ProbeTokens(),
      retryTimer: null,
      probeTimer: null,
      stableTimer: null,
      probing: false,
      paused: false,
      everUp: false,
      firstUpMs: 0,
    }
    this.runs.set(id, run)
    this.publish(run.rt)
    this.event(run, { type: 'connecting', trigger })
    this.syncStats()
    const snapshot = cloneRuntime(run.rt)
    void this.attempt(run)
    return snapshot
  }

  stop(id: string, reason: TunnelStopReason = 'user'): void {
    const run = this.runs.get(id)
    if (!run) {
      // Clearing a failed tunnel back to stopped.
      if (this.last.delete(id)) this.publish(this.stoppedRuntime(id))
      return
    }
    this.release(run)
    this.runs.delete(id)
    if (run.everUp) this.auditStop(run, reason)
    this.publish(this.stoppedRuntime(id))
    this.event(run, { type: 'stopped', reason })
    this.syncStats()
  }

  stopAll(reason: TunnelStopReason): void {
    for (const id of [...this.runs.keys()]) this.stop(id, reason)
    this.last.clear()
  }

  stopForHost(hostId: string, reason: TunnelStopReason): void {
    for (const run of [...this.runs.values()]) if (run.meta.hostId === hostId) this.stop(run.meta.id, reason)
  }

  /** One runtime per saved tunnel, `stopped` for the idle ones. */
  status(): TunnelRuntime[] {
    return this.deps.store.list().map((m) => this.runtime(m.id))
  }

  runtime(id: string): TunnelRuntime {
    const rt = this.runs.get(id)?.rt ?? this.last.get(id)
    return rt ? cloneRuntime(rt) : this.stoppedRuntime(id)
  }

  onEvent(fn: (e: TunnelEvent) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Runs before the broker cancels every prompt, so a dial that loses its prompt pauses instead of failing. */
  vaultLocked(): void {
    for (const link of this.links.values()) if (link.state === 'dialing') link.lockedDuringDial = true
  }

  /** Resumes paused tunnels; the first unlock of the app run also starts the `autoStart` tunnels. */
  vaultUnlocked(): void {
    for (const run of [...this.runs.values()]) if (run.paused) void this.attempt(run)
    if (this.autoStarted) return
    this.autoStarted = true
    for (const meta of this.deps.store.list()) {
      if (!meta.autoStart) continue
      try {
        this.start(meta.id, 'auto')
      } catch (err) {
        this.warn('Auto-start failed', err)
        if (err instanceof TunnelLimitError) break
      }
    }
  }

  /** Store delete hook. It runs inside the store's write path, so it never throws. */
  removed(id: string): void {
    try {
      this.stop(id, 'deleted')
      this.last.delete(id)
    } catch (err) {
      this.warn('Stopping a deleted tunnel failed', err)
    }
  }

  /** Store update hook: a running tunnel whose connection details changed restarts. Never throws. */
  changed(_before: TunnelMeta, after: TunnelMeta): void {
    try {
      const run = this.runs.get(after.id)
      if (!run) return
      if (!RESTART_FIELDS.some((k) => run.meta[k] !== after[k])) {
        run.meta = after
        return
      }
      this.stop(after.id, 'edited')
      this.start(after.id, run.trigger)
    } catch (err) {
      this.warn('Restarting an edited tunnel failed', err)
    }
  }

  // --- the per-tunnel loop ---

  /** Redoes only what is missing: the link, then the listener or remote listen, then the probe. */
  private async attempt(run: Run): Promise<void> {
    const gen = ++run.gen
    this.clearTimer(run, 'retryTimer')
    run.paused = false
    const live = (): boolean => run.gen === gen && !run.released
    try {
      if (!run.link) {
        if (this.deps.isLocked()) return this.pause(run)
        run.link = this.subscribe(run)
      }
      await run.link.ready
      if (!live()) return
      if (!run.handle) {
        const handle = await this.openHandle(run, live)
        if (!handle) return
        run.handle = handle
        if (!live()) return
      }
      const liveness = await run.handle.probe()
      if (!live()) return
      this.up(run, liveness)
    } catch (err) {
      if (!live()) return
      this.fail(run, this.classify(run, err))
    }
  }

  /** Null when the result came back stale (it is then closed, or kept for a listener that is still wanted). */
  private async openHandle(run: Run, live: () => boolean): Promise<ForwardHandle | null> {
    if (run.meta.type === 'R') {
      const handle = await this.openRemote(run)
      if (live()) return handle
      void handle.close().catch(() => {})
      return null
    }
    const opening = (run.opening ??= this.openListener(run).finally(() => {
      run.opening = null
    }))
    const handle = await opening
    if (run.released) {
      void handle.close().catch(() => {})
      return null
    }
    // A listener is kept across a failure that raced it: it stays bound while retrying.
    run.handle ??= handle
    return live() ? handle : null
  }

  private openRemote(run: Run): Promise<ForwardHandle> {
    const { meta } = run
    return this.engines.startRemote(run.link!.client!, {
      bindAddress: meta.bindAddress,
      bindPort: meta.bindPort,
      targetHost: meta.targetHost!,
      targetPort: meta.targetPort!,
      counter: run.counter,
      tokens: run.tokens,
      timers: realTimers,
    })
  }

  private async openListener(run: Run): Promise<ForwardHandle> {
    const { meta } = run
    const server = await this.deps.listen(meta.bindAddress, meta.bindPort, {
      inUseBy: (address, port) => this.inUseBy(run, address, port),
    })
    server.on('error', () => {})
    const shared = { server, counter: run.counter, tokens: run.tokens, timers: realTimers }
    try {
      return meta.type === 'L'
        ? this.engines.startLocal(this.via(run), { ...shared, targetHost: meta.targetHost!, targetPort: meta.targetPort! })
        : this.engines.startDynamic(this.via(run), shared)
    } catch (err) {
      server.close()
      throw err
    }
  }

  /** `L`/`D` listeners outlive a link, so their forwards go over whichever link is ready now. */
  private via(run: Run): ForwardOut {
    const via = {
      forwardOut: (srcIP: string, srcPort: number, dstIP: string, dstPort: number, cb: ForwardOutCallback) => {
        const client = run.link?.state === 'ready' ? run.link.client : null
        if (!client) {
          cb(new Error('The connection is down'), undefined as never)
          return via
        }
        client.forwardOut(srcIP, srcPort, dstIP, dstPort, cb)
        return via
      },
    }
    return via as unknown as ForwardOut
  }

  /** The label of another running tunnel listening on `address:port`. */
  private inUseBy(self: Run, address: string, port: number): string | null {
    for (const run of this.runs.values()) {
      if (run === self || run.meta.type === 'R') continue
      const bound = run.handle?.address
      if (bound && bound.port === port && sameAddress(bound.address, address)) return run.meta.label
      if (run.opening && run.meta.bindPort === port && sameAddress(run.meta.bindAddress, address)) return run.meta.label
    }
    return null
  }

  private up(run: Run, liveness: 'probe' | 'keepalive'): void {
    const handle = run.handle!
    handle.setAccepting(true)
    const now = this.now()
    const recovered = run.everUp
    Object.assign(run.rt, {
      state: 'up',
      error: null,
      retryAt: null,
      liveness,
      boundAddress: handle.address.address,
      boundPort: handle.address.port,
      upAt: now.toISOString(),
      lastProbeAt: now.toISOString(),
    })
    if (!run.everUp) {
      run.everUp = true
      run.firstUpMs = now.getTime()
      this.audit({ action: 'tunnel.start', outcome: 'success', ...this.auditTarget(run), details: this.startDetails(run) })
    }
    if (liveness === 'probe') run.probeTimer = this.timers.setInterval(() => this.probeTick(run), PROBE_INTERVAL_MS)
    run.stableTimer = this.timers.setTimeout(() => {
      run.stableTimer = null
      if (run.rt.failures === 0) return
      run.rt.failures = 0
      this.publish(run.rt)
    }, STABLE_MS)
    this.publish(run.rt)
    this.event(run, { type: 'up', recovered })
  }

  private probeTick(run: Run): void {
    const handle = run.handle
    if (run.probing || !handle) return
    run.probing = true
    const gen = run.gen
    handle.probe().then(
      () => {
        if (run.gen !== gen || run.released) return
        run.probing = false
        run.rt.lastProbeAt = this.now().toISOString()
      },
      (err: unknown) => {
        if (run.gen !== gen || run.released) return
        run.probing = false
        this.fail(run, this.classify(run, err))
      },
    )
  }

  private classify(run: Run, err: unknown): Failure {
    if (err instanceof LinkFailure) return { ...err.failure, stage: 'link' }
    if (err instanceof BindError) return { error: { code: err.code, message: redact(err.message) }, retryable: false, locked: false, stage: 'open' }
    if (err instanceof ForwardError) {
      const message =
        err.code === 'remote-refused'
          ? `${run.link?.label ?? run.meta.label} refused to listen on port ${run.meta.bindPort} (it may be in use, or remote forwarding is disabled)`
          : err.message
      return {
        error: { code: err.code, message: redact(message) },
        retryable: isRetryable(err.code),
        locked: false,
        stage: err.code === 'probe-failed' ? 'probe' : 'open',
      }
    }
    return { error: { code: 'unknown', message: redact(messageOf(err)) }, retryable: true, locked: false, stage: 'open' }
  }

  private fail(run: Run, f: Failure): void {
    run.gen++
    this.clearTimers(run)
    run.probing = false
    run.handle?.setAccepting(false)
    if (f.stage === 'link') this.unsubscribe(run)
    // An R listen lives on the server: a dead link took it, and a failed probe re-requests it.
    if (run.meta.type === 'R' && run.handle) {
      void run.handle.close().catch(() => {})
      run.handle = null
    }
    if (f.locked) return this.pause(run)
    if (!f.retryable || !run.meta.autoReconnect) return this.finishFailed(run, f.error)
    run.rt.failures += 1
    if (run.rt.failures >= this.maxFailures) return this.finishFailed(run, f.error)
    const wait = backoffMs(run.rt.failures)
    run.retryTimer = this.timers.setTimeout(() => {
      run.retryTimer = null
      void this.attempt(run)
    }, wait)
    Object.assign(run.rt, { state: 'retrying', error: f.error, retryAt: new Date(this.now().getTime() + wait).toISOString() })
    this.publish(run.rt)
    this.event(run, { type: 'retrying', failures: run.rt.failures, retryInMs: wait, error: f.error })
  }

  /** Waits for unlock: no timer, and it doesn't count as a failure. */
  private pause(run: Run): void {
    run.paused = true
    Object.assign(run.rt, { state: 'retrying', error: { ...LOCKED }, retryAt: null })
    this.publish(run.rt)
    this.event(run, { type: 'retrying', failures: run.rt.failures, retryInMs: null, error: { ...LOCKED } })
  }

  private finishFailed(run: Run, error: TunnelError): void {
    this.release(run)
    this.runs.delete(run.meta.id)
    Object.assign(run.rt, { state: 'failed', error, retryAt: null })
    this.last.set(run.meta.id, run.rt)
    if (run.everUp) this.auditStop(run, 'failed')
    else
      this.audit({
        action: 'tunnel.start',
        outcome: 'failure',
        ...this.auditTarget(run),
        details: { ...this.startDetails(run), code: error.code },
      })
    this.publish(run.rt)
    this.event(run, { type: 'failed', error, wasUp: run.everUp })
    this.syncStats()
  }

  /** Clears every timer, closes the listener (or remote listen) and leaves the link. */
  private release(run: Run): void {
    run.released = true
    run.gen++
    this.clearTimers(run)
    run.probing = false
    run.paused = false
    const handle = run.handle
    run.handle = null
    if (handle) void handle.close().catch(() => {})
    this.unsubscribe(run)
  }

  private clearTimers(run: Run): void {
    this.clearTimer(run, 'retryTimer')
    this.clearTimer(run, 'stableTimer')
    if (run.probeTimer !== null) this.timers.clearInterval(run.probeTimer)
    run.probeTimer = null
  }

  private clearTimer(run: Run, which: 'retryTimer' | 'stableTimer'): void {
    if (run[which] !== null) this.timers.clearTimeout(run[which])
    run[which] = null
  }

  // --- host links ---

  private subscribe(run: Run): HostLink {
    let link = this.links.get(run.key)
    if (!link || link.state === 'down') link = this.dial(run)
    link.subscribers.add(run)
    return link
  }

  /** The last subscriber out cancels the link's prompts and ends the dial or the connection. */
  private unsubscribe(run: Run): void {
    const link = run.link
    if (!link) return
    run.link = null
    link.subscribers.delete(run)
    if (link.subscribers.size > 0) return
    link.state = 'down'
    if (this.links.get(link.key) === link) this.links.delete(link.key)
    this.deps.prompts.cancel(link.prompts)
    link.abort.abort()
    link.close?.()
  }

  private dial(run: Run): HostLink {
    let resolveReady!: () => void
    let rejectReady!: (err: LinkFailure) => void
    const link: HostLink = {
      key: run.key,
      label: run.meta.label,
      state: 'dialing',
      client: null,
      close: null,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      }),
      subscribers: new Set(),
      prompts: new Set(),
      owner: run.meta.id,
      abort: new AbortController(),
      lockedDuringDial: false,
      hop: 0,
      failedHop: null,
    }
    // Every subscriber awaits `ready`; this keeps a dial nobody waits on from being an unhandled rejection.
    link.ready.catch(() => {})
    const settle = (err: unknown, hops: HopTarget[]): void => {
      link.state = 'down'
      if (this.links.get(link.key) === link) this.links.delete(link.key)
      rejectReady(new LinkFailure(this.linkFailure(link, hops, err)))
    }

    let target: { hops: HopTarget[]; hostIds: string[]; keepaliveSec: number }
    try {
      const { hostId, environmentId } = run.meta
      const resolved = this.deps.resolve(hostId, environmentId ?? undefined)
      const info = this.deps.hostInfo(hostId)
      link.label = info.label
      target = {
        hops: hopsOf(resolved, info.label),
        hostIds: [...resolved.chain.map((h) => h.hostId), hostId],
        // A host's "off" never turns tunnel keepalives off: liveness depends on them.
        keepaliveSec: info.keepaliveSec && info.keepaliveSec > 0 ? info.keepaliveSec : TUNNEL_KEEPALIVE_SEC,
      }
    } catch (err) {
      settle(new ConfigError(messageOf(err)), [])
      return link
    }
    this.links.set(link.key, link)

    const dialing = (): boolean => link.state === 'dialing' && !link.abort.signal.aborted
    const deps: ConnectDeps = {
      plan: async (identity) => {
        try {
          return await this.deps.plan(identity)
        } catch (err) {
          throw new ConfigError(messageOf(err))
        }
      },
      verifyHostKey: (hop, keyType, keyBase64) =>
        verifyWithStore(this.deps.knownHosts, this.deps.prompts, {
          ownerId: link.owner,
          group: link.prompts,
          hop,
          hostId: target.hostIds[target.hops.indexOf(hop)] ?? null,
          keyType,
          keyBase64,
          isLive: dialing,
          onLocked: () => this.lockedDial(link),
        }),
      askPassword: async (hop, username) => {
        const a = await this.ask(link, { kind: 'password', hopLabel: hop.label, username })
        return a?.kind === 'password' ? a.password : null
      },
      askKeyboard: async (hop, name, instructions, prompts) => {
        const a = await this.ask(link, { kind: 'keyboard', hopLabel: hop.label, name, instructions, prompts })
        return a?.kind === 'keyboard' ? a.responses : null
      },
      onHop: (i, state) => {
        if (state === 'connecting') link.hop = i
        if (state === 'failed') link.failedHop = i
      },
      keepaliveSec: target.keepaliveSec,
    }
    this.deps
      .connect(target.hops, deps, link.abort.signal)
      .then(
        (chain) => {
          if (!dialing()) {
            chain.close()
            return settle(new Error('The connection was closed before it was ready'), target.hops)
          }
          link.client = chain.client
          link.close = chain.close
          link.state = 'ready'
          chain.client.on('close', () => this.dropped(link))
          resolveReady()
          this.kick(link)
        },
        (err: unknown) => settle(err, target.hops),
      )
      .catch((err: unknown) => this.warn('Tunnel link bookkeeping failed', err))
    return link
  }

  private linkFailure(link: HostLink, hops: HopTarget[], err: unknown): Omit<Failure, 'stage'> {
    // Any dial failure seen while locked (a cancelled prompt included) pauses.
    if (link.lockedDuringDial || this.deps.isLocked()) return { error: { ...LOCKED }, retryable: false, locked: true }
    if (err instanceof ConfigError) return { error: { code: 'unknown', message: redact(err.message) }, retryable: false, locked: false }
    const { code, message, hopLabel } = describeError(err, hops[link.failedHop ?? link.hop] ?? null)
    return { error: { code, message, ...(hopLabel ? { hopLabel } : {}) }, retryable: isRetryable(code), locked: false }
  }

  /** Never asks while locked: the dial is abandoned and its subscribers pause. */
  private async ask(link: HostLink, body: PromptBody): Promise<PromptAnswer | null> {
    if (link.state !== 'dialing' || link.abort.signal.aborted) return null
    const answer = await this.deps.prompts.ask(link.owner, link.prompts, body)
    if (answer !== 'locked') return answer
    this.lockedDial(link)
    return null
  }

  private lockedDial(link: HostLink): void {
    link.lockedDuringDial = true
    link.abort.abort()
  }

  /** The connection closed after it was ready: every tunnel on it leaves `up`. */
  private dropped(link: HostLink): void {
    if (link.state !== 'ready') return
    link.state = 'down'
    if (this.links.get(link.key) === link) this.links.delete(link.key)
    link.close?.()
    const error: TunnelError = { code: 'dropped', message: `The connection to ${link.label} dropped` }
    for (const run of [...link.subscribers]) this.fail(run, { error, retryable: true, locked: false, stage: 'link' })
  }

  /** A ready link takes along the tunnels on its host that are waiting to retry, so one redial serves all. */
  private kick(link: HostLink): void {
    for (const run of [...this.runs.values()]) {
      if (run.key !== link.key || run.link || this.deps.isLocked()) continue
      if (run.retryTimer !== null || run.paused) void this.attempt(run)
    }
  }

  // --- output ---

  private stoppedRuntime(id: string): TunnelRuntime {
    return {
      id,
      state: 'stopped',
      error: null,
      failures: 0,
      maxFailures: this.maxFailures,
      retryAt: null,
      boundAddress: null,
      boundPort: null,
      liveness: 'probe',
      startedAt: null,
      upAt: null,
      lastProbeAt: null,
    }
  }

  private publish(rt: TunnelRuntime): void {
    this.deps.emit('tunnel:state', cloneRuntime(rt))
  }

  private event(run: Run, e: DistributiveOmit<TunnelEvent, 'tunnelId' | 'label' | 'at'>): void {
    const full = { ...e, tunnelId: run.meta.id, label: run.meta.label, at: this.now().toISOString() } as TunnelEvent
    for (const fn of [...this.listeners]) {
      try {
        fn(full)
      } catch (err) {
        this.warn('Tunnel event listener failed', err)
      }
    }
    this.deps.emit('tunnel:event', full)
  }

  /** The stats loop runs only while a tunnel does. */
  private syncStats(): void {
    if (this.runs.size > 0 && this.statsTimer === null) {
      this.statsTimer = this.statsTimers.setInterval(() => {
        const stats = [...this.runs.values()].map((r) => ({ id: r.meta.id, ...r.counter.sample() }))
        this.deps.emit('tunnel:stats', stats)
      }, STATS_MS)
    } else if (this.runs.size === 0 && this.statsTimer !== null) {
      this.statsTimers.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  private startDetails(run: Run): Record<string, unknown> {
    const { type, bindPort, bindAddress } = run.meta
    return { type, bindPort, exposed: !isLoopback(bindAddress), trigger: run.trigger }
  }

  private auditStop(run: Run, reason: TunnelStopReason): void {
    this.audit({
      action: 'tunnel.stop',
      outcome: 'info',
      ...this.auditTarget(run),
      details: {
        reason,
        durationSec: Math.round((this.now().getTime() - run.firstUpMs) / 1000),
        failures: run.rt.failures,
      },
    })
  }

  /** The label only: never the target host or an address. */
  private auditTarget(run: Run): Pick<AuditInput, 'targetType' | 'targetId' | 'targetLabel'> {
    return { targetType: 'tunnel', targetId: run.meta.id, targetLabel: run.meta.label }
  }

  /** Runs inside ssh2 and store callbacks, so a failing audit write must not throw out of them. */
  private audit(entry: AuditInput): void {
    try {
      this.deps.audit.append(entry)
    } catch (err) {
      this.warn(`Tunnel audit write failed (${entry.action})`, err)
    }
  }

  private warn(what: string, err: unknown): void {
    console.warn(`${what}:`, redact(messageOf(err)))
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
