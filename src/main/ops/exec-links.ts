import type { Client } from 'ssh2'
import type { IdentityRef, ResolvedHost } from '../../shared/inventory'
import { LINK_IDLE_MS, MAX_CHANNELS_PER_LINK, MAX_EXEC_LINKS } from '../../shared/ops'
import { DEFAULT_KEEPALIVE_SEC, type PromptAnswer, type SessionError } from '../../shared/ssh'
import { redact } from '../security/redact'
import type { AuthPlan } from '../ssh/auth'
import { describeError, hopsOf } from '../ssh/connect'
import type { ConnectDeps, HopTarget, connectChain } from '../ssh/connect'
import type { KnownHostStore } from '../ssh/known-hosts'
import { verifyWithStore, type PromptBody, type PromptBroker } from '../ssh/prompts'
import { realTimers, type Timers } from '../tunnels/forward'

export interface ExecLinksDeps {
  resolve(hostId: string, environmentId?: string): ResolvedHost
  hostInfo(hostId: string): { label: string; keepaliveSec: number | null; envVars: Record<string, string> }
  connect: typeof connectChain
  plan(identity: IdentityRef): Promise<AuthPlan>
  knownHosts: Pick<KnownHostStore, 'check' | 'trust' | 'recordMismatch'>
  prompts: PromptBroker
  isLocked(): boolean
  /** The idle-close timers. */
  timers?: Timers
  /** Test seams; default `MAX_EXEC_LINKS` and `MAX_CHANNELS_PER_LINK`. */
  maxLinks?: number
  maxChannels?: number
}

/** One exec channel's slot on a ready link. `release` is idempotent. */
export interface Lease {
  client: Client
  label: string
  envVars: Record<string, string>
  release(): void
}

/** Why a lease failed, as a `SessionError`: dial errors carry the failing hop's label. */
export class ExecFailure extends Error {
  readonly code: SessionError['code']
  constructor(readonly error: SessionError) {
    super(error.message)
    this.name = 'ExecFailure'
    this.code = error.code
  }
}

/** Resolve and auth-plan errors: the saved config is wrong. */
class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const LOCKED: SessionError = { code: 'locked', message: 'Unlock the vault to connect' }
const CANCELLED: SessionError = { code: 'closed', message: 'The connection was cancelled' }
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A waiter in a FIFO queue: called with no argument to proceed, with an error to fail. */
type Turn = (err?: ExecFailure) => void

/** One SSH connection per `hostId|environmentId`, shared by the exec channels on it. */
interface Link {
  key: string
  label: string
  envVars: Record<string, string>
  state: 'dialing' | 'ready' | 'down'
  client: Client | null
  close: (() => void) | null
  ready: Promise<void>
  /** The broker group for this dial's prompts; cancelled only when the last waiter leaves. */
  prompts: Set<string>
  /** The first waiter's id, shown as the prompts' owner. */
  owner: string
  abort: AbortController
  lockedDuringDial: boolean
  hop: number
  failedHop: number | null
  /** `lease` calls waiting on this link's dial or for a channel slot. */
  waiters: number
  /** Leases holding a channel slot. */
  leases: number
  channelQueue: Turn[]
  idleTimer: unknown
}

/**
 * Pooled SSH connections for one-shot execs (runs and containers). A link stays open while it has
 * a lease and closes `LINK_IDLE_MS` after the last one is released. Leases past the link or channel
 * limits wait in FIFO order instead of failing. The dial mirrors `TunnelManager`'s lock handling.
 */
export class ExecLinks {
  private readonly links = new Map<string, Link>()
  private readonly slotQueue: Turn[] = []
  private readonly timers: Timers
  private readonly maxLinks: number
  private readonly maxChannels: number
  /** Set by `closeAll`: no lease is served after quit. */
  private closed = false

  constructor(private readonly deps: ExecLinksDeps) {
    this.timers = deps.timers ?? realTimers
    this.maxLinks = deps.maxLinks ?? MAX_EXEC_LINKS
    this.maxChannels = deps.maxChannels ?? MAX_CHANNELS_PER_LINK
  }

  /** Rejects with an `ExecFailure`: the dial's error, `locked`, or `closed` when `signal` aborts first or after `closeAll`. */
  async lease(hostId: string, environmentId: string | null, owner: { id: string }, signal: AbortSignal): Promise<Lease> {
    const key = `${hostId}|${environmentId ?? ''}`
    for (;;) {
      if (signal.aborted || this.closed) throw new ExecFailure(CANCELLED)
      if (this.deps.isLocked()) throw new ExecFailure(LOCKED)
      let link = this.links.get(key)
      if (!link && this.links.size >= this.maxLinks && !this.evictIdle()) {
        await waitTurn(this.slotQueue, signal)
        continue
      }
      link ??= this.dial(key, hostId, environmentId, owner.id)
      return await this.join(link, signal)
    }
  }

  /** Fails dials as `locked` and closes idle links; links with a lease stay up. */
  vaultLocked(): void {
    for (const link of [...this.links.values()]) {
      if (link.state === 'dialing') this.lockedDial(link)
      else if (link.leases === 0 && link.waiters === 0) this.closeLink(link)
    }
  }

  /** Quit: ends every dial and connection, and fails everything waiting. */
  closeAll(): void {
    this.closed = true
    for (const turn of this.slotQueue.splice(0)) turn(new ExecFailure(CANCELLED))
    for (const link of [...this.links.values()]) this.closeLink(link)
  }

  private async join(link: Link, signal: AbortSignal): Promise<Lease> {
    link.waiters++
    this.clearIdle(link)
    try {
      await abortable(link.ready, signal)
      while (link.state === 'ready' && link.leases >= this.maxChannels) await waitTurn(link.channelQueue, signal)
      if (link.state !== 'ready' || !link.client) throw new ExecFailure({ code: 'closed', message: `The connection to ${link.label} dropped` })
      if (signal.aborted) throw new ExecFailure(CANCELLED)
    } catch (err) {
      link.waiters--
      // A turn this waiter took but won't use goes to the next one.
      if (link.leases < this.maxChannels) link.channelQueue.shift()?.()
      this.leave(link)
      throw err
    }
    link.waiters--
    link.leases++
    let released = false
    return {
      client: link.client,
      label: link.label,
      envVars: { ...link.envVars },
      release: () => {
        if (released) return
        released = true
        link.leases--
        link.channelQueue.shift()?.()
        this.leave(link)
      },
    }
  }

  /** A link nobody uses any more: a dial is abandoned, a ready link idles (or goes now if a lease waits for a slot). */
  private leave(link: Link): void {
    if (link.leases > 0 || link.waiters > 0) return
    if (link.state === 'dialing') return this.closeLink(link)
    if (link.state !== 'ready') return
    if (this.slotQueue.length > 0) return this.closeLink(link)
    link.idleTimer = this.timers.setTimeout(() => this.closeLink(link), LINK_IDLE_MS)
  }

  private evictIdle(): boolean {
    const idle = [...this.links.values()].find((l) => l.state === 'ready' && l.leases === 0 && l.waiters === 0)
    if (idle) this.closeLink(idle)
    return idle !== undefined
  }

  private clearIdle(link: Link): void {
    if (link.idleTimer !== null) this.timers.clearTimeout(link.idleTimer)
    link.idleTimer = null
  }

  /** Cancels the link's prompts and ends its dial or connection; leases waiting for a link slot look again. */
  private closeLink(link: Link): void {
    this.clearIdle(link)
    link.state = 'down'
    this.unpool(link)
    this.deps.prompts.cancel(link.prompts)
    link.abort.abort()
    link.close?.()
    for (const turn of link.channelQueue.splice(0)) turn()
  }

  private dial(key: string, hostId: string, environmentId: string | null, owner: string): Link {
    let resolveReady!: () => void
    let rejectReady!: (err: ExecFailure) => void
    const link: Link = {
      key,
      label: hostId,
      envVars: {},
      state: 'dialing',
      client: null,
      close: null,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      }),
      prompts: new Set(),
      owner,
      abort: new AbortController(),
      lockedDuringDial: false,
      hop: 0,
      failedHop: null,
      waiters: 0,
      leases: 0,
      channelQueue: [],
      idleTimer: null,
    }
    // Every waiter awaits `ready`; this keeps a dial nobody waits on from being an unhandled rejection.
    link.ready.catch(() => {})
    const settle = (err: unknown, hops: HopTarget[]): void => {
      if (link.state === 'dialing') this.closeLink(link)
      rejectReady(new ExecFailure(this.failure(link, hops, err)))
    }

    let target: { hops: HopTarget[]; hostIds: string[]; keepaliveSec: number }
    try {
      const resolved = this.deps.resolve(hostId, environmentId ?? undefined)
      const info = this.deps.hostInfo(hostId)
      link.label = info.label
      link.envVars = info.envVars
      target = {
        hops: hopsOf(resolved, info.label),
        hostIds: [...resolved.chain.map((h) => h.hostId), hostId],
        keepaliveSec: info.keepaliveSec ?? DEFAULT_KEEPALIVE_SEC,
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
    this.deps.connect(target.hops, deps, link.abort.signal).then(
      (chain) => {
        if (!dialing()) {
          chain.close()
          return settle(new Error('The connection was closed before it was ready'), target.hops)
        }
        link.client = chain.client
        link.close = chain.close
        link.state = 'ready'
        chain.client.on('close', () => link.state === 'ready' && this.closeLink(link))
        resolveReady()
      },
      (err: unknown) => settle(err, target.hops),
    )
    return link
  }

  private failure(link: Link, hops: HopTarget[], err: unknown): SessionError {
    // Any dial failure seen while locked (a cancelled prompt included) is `locked`.
    if (link.lockedDuringDial || this.deps.isLocked()) return { ...LOCKED }
    if (err instanceof ConfigError) return { code: 'unknown', message: redact(err.message) }
    return describeError(err, hops[link.failedHop ?? link.hop] ?? null)
  }

  /** Never asks while locked: the dial is abandoned as `locked`. */
  private async ask(link: Link, body: PromptBody): Promise<PromptAnswer | null> {
    if (link.state !== 'dialing' || link.abort.signal.aborted) return null
    const answer = await this.deps.prompts.ask(link.owner, link.prompts, body)
    if (answer !== 'locked') return answer
    this.lockedDial(link)
    return null
  }

  /** The doomed dial leaves the pool at once, so a lease after unlock dials afresh instead of joining it. */
  private lockedDial(link: Link): void {
    link.lockedDuringDial = true
    this.unpool(link)
    this.deps.prompts.cancel(link.prompts)
    link.abort.abort()
  }

  /** Takes the link out of the pool; every lease waiting for a link slot looks again. */
  private unpool(link: Link): void {
    if (this.links.get(link.key) !== link) return
    this.links.delete(link.key)
    // Those that don't get the slot queue again.
    for (const turn of this.slotQueue.splice(0)) turn()
  }
}

/** Resolves when `p` does; rejects as cancelled when `signal` aborts first. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ExecFailure(CANCELLED))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ExecFailure(CANCELLED))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Joins `queue` and waits to be called. An abort leaves the queue at once, so a turn is never given
 * to a waiter that is gone; once called, the turn is the waiter's even if it aborts afterwards.
 */
function waitTurn(queue: Turn[], signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ExecFailure(CANCELLED))
    const onAbort = (): void => {
      const i = queue.indexOf(turn)
      if (i >= 0) queue.splice(i, 1)
      reject(new ExecFailure(CANCELLED))
    }
    const turn: Turn = (err) => {
      signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    queue.push(turn)
  })
}
