import type { ReleaseSummary, RunEvent } from '../../shared/deploy'
import type { HubEnvLock, HubLiveMessage } from '../../shared/hub'
import type { NotifyEventKey } from '../../shared/settings'
import type { NotificationFacts } from '../notify/teams'
import { HubError, type HubClient } from './client'

/** Events a catch-up asks for per request (the Hub allows 5000). */
const PAGE = 1000
/** A frame larger than this is a broken stream, not a message. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** Releases whose last seq is remembered; the oldest are forgotten first. */
const MAX_TRACKED = 200

const TERMINAL = new Set<ReleaseSummary['status']>(['succeeded', 'failed', 'rolled_back'])
const EVENT_OF: Record<string, NotifyEventKey> = { succeeded: 'release.succeeded', failed: 'release.failed', rolled_back: 'release.rolled_back' }

export interface LiveFeedDeps {
  client: () => Pick<HubClient, 'get' | 'stream'>
  /** Trades the refresh token for a new session; false when the person must sign in again. */
  renew: () => Promise<boolean>
  /** The wait before reconnect attempt number `failure` (1-based). */
  backoff: (failure: number) => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  push: {
    events(batch: RunEvent[]): void
    state(summary: ReleaseSummary): void
    locks(environmentId: string, lock: HubEnvLock | null): void
    catalog(): void
  }
  /** Whether the release was started by the signed-in person. */
  isMine: (summary: ReleaseSummary) => boolean
  notifier: { show(facts: NotificationFacts, route: string): void }
  /** Told of every release id the Hub mentions, so id calls can be routed to it. */
  track?: (releaseId: string) => void
  /** The feed gave up: the session is gone. */
  onSignedOut?: () => void
  now: () => Date
}

/** Splits an SSE byte stream into `{event, data}` frames. Comments (`: ping`) are dropped. */
export async function* sseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const onAbort = (): void => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', onAbort, { once: true })
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      if (buf.length > MAX_FRAME_BYTES) throw new Error('frame too large')
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * The Hub's live stream, kept open while signed in. Events reach the renderer exactly once and in order: the
 * last seq per release is remembered, so a reconnect (or a gap in the stream) is filled from the Hub's event
 * log before live delivery resumes.
 */
export class LiveFeed {
  private ctl: AbortController | null = null
  private readonly last = new Map<string, number>()
  private readonly notified = new Set<string>()
  private readonly listeners = new Set<(batch: RunEvent[]) => void>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly d: LiveFeedDeps) {}

  running(): boolean {
    return this.ctl !== null
  }

  /** Batches as they are pushed to the renderer (what the release service's `onEvent` is for local runs). */
  onEvent(fn: (batch: RunEvent[]) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  start(): void {
    if (this.ctl) return
    const ctl = new AbortController()
    this.ctl = ctl
    void this.loop(ctl.signal).finally(() => {
      if (this.ctl === ctl) this.ctl = null
    })
  }

  stop(): void {
    this.ctl?.abort()
    this.ctl = null
    this.last.clear()
    this.notified.clear()
  }

  /** Resolves when everything received so far has been delivered. For tests. */
  idle(): Promise<void> {
    return this.chain
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0
    let renewed = false
    while (!signal.aborted) {
      try {
        const res = await this.d.client().stream('/api/v1/live', signal)
        await this.run(() => this.catchUp(signal))
        // Only a stream that got through its catch-up counts as healthy: a 401 there must not renew forever.
        renewed = false
        failures = 0
        for await (const frame of sseFrames(res.body!, signal)) {
          await this.run(() => this.frame(frame, signal))
        }
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof HubError && err.status === 401) {
          // One renewal per failure: a second 401 straight after means the session is really gone.
          if (renewed) {
            this.d.onSignedOut?.()
            return
          }
          const ok = await this.d.renew().then((r) => r, () => null)
          if (ok === true) {
            renewed = true
            continue
          }
          // null: the Hub could not be reached to renew; wait and retry like any other drop.
          if (ok === false) {
            this.d.onSignedOut?.()
            return
          }
        }
      }
      if (signal.aborted) return
      failures++
      await this.d.sleep(this.d.backoff(failures), signal).catch(() => undefined)
    }
  }

  /** Frames are handled one at a time, in order, so a backfill never interleaves with a later frame. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** After (re)connecting: current state of what is running, and the events missed since the last seq seen. */
  private async catchUp(signal: AbortSignal): Promise<void> {
    const active = await this.d.client().get<ReleaseSummary[]>('/api/v1/releases/active')
    for (const s of active) this.state(s)
    const running = new Set(active.map((s) => s.id))
    for (const id of [...this.last.keys()]) {
      if (signal.aborted) return
      await this.backfill(id, signal)
      if (running.has(id)) continue
      // It finished while the stream was down: its terminal state would otherwise never arrive.
      try {
        const done = await this.d.client().get<ReleaseSummary>(`/api/v1/releases/${id}`)
        if (!signal.aborted) this.state(done)
      } catch (err) {
        if (!(err instanceof HubError) || err.status !== 404) throw err
      }
    }
  }

  private async frame(frame: { event: string; data: string }, signal: AbortSignal): Promise<void> {
    let msg: HubLiveMessage
    try {
      msg = JSON.parse(frame.data) as HubLiveMessage
    } catch {
      return
    }
    if (signal.aborted) return
    switch (msg.type) {
      case 'deploy.events':
        await this.events(msg.events, signal)
        break
      case 'release.state':
        this.state(msg.summary)
        break
      case 'lock.updated':
        this.d.push.locks(msg.environmentId, msg.lock)
        this.d.push.catalog()
        break
      case 'catalog.updated':
      case 'access.changed':
        this.d.push.catalog()
        break
    }
  }

  private async events(batch: RunEvent[], signal: AbortSignal): Promise<void> {
    const out: RunEvent[] = []
    for (const e of batch) {
      const id = e.runId
      this.d.track?.(id)
      const last = this.last.get(id)
      if (last !== undefined && e.seq <= last) continue
      if (last !== undefined && e.seq > last + 1) {
        // A gap: the Hub's log has what was missed, this event included.
        this.flush(out)
        await this.backfill(id, signal)
        if (signal.aborted) return
        if (e.seq <= (this.last.get(id) ?? 0)) continue
      }
      this.accept(e, out)
    }
    this.flush(out)
  }

  /** A stopped session's backfill must not repopulate `last` or push events after `stop()`. */
  private async backfill(releaseId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return
      const after = this.last.get(releaseId) ?? 0
      const page = await this.d.client().get<RunEvent[]>(`/api/v1/releases/${releaseId}/events`, { afterSeq: after, limit: PAGE })
      if (signal.aborted) return
      const out: RunEvent[] = []
      for (const e of page) if (e.seq > (this.last.get(releaseId) ?? 0)) this.accept(e, out)
      this.flush(out)
      if (page.length < PAGE || out.length === 0) return
    }
  }

  private accept(e: RunEvent, out: RunEvent[]): void {
    this.last.delete(e.runId)
    this.last.set(e.runId, e.seq)
    if (this.last.size > MAX_TRACKED) this.last.delete(this.last.keys().next().value as string)
    out.push(e)
  }

  private flush(out: RunEvent[]): void {
    if (out.length === 0) return
    const batch = out.splice(0)
    this.d.push.events(batch)
    for (const fn of this.listeners) fn(batch)
  }

  private state(s: ReleaseSummary): void {
    this.d.track?.(s.id)
    this.d.push.state(s)
    if (!TERMINAL.has(s.status) || this.notified.has(s.id) || !this.d.isMine(s)) return
    this.notified.add(s.id)
    if (this.notified.size > MAX_TRACKED) this.notified.delete(this.notified.values().next().value as string)
    this.d.notifier.show(this.facts(s), `/deployments/release/${s.id}`)
  }

  private facts(s: ReleaseSummary): NotificationFacts {
    const started = s.startedAt ? Date.parse(s.startedAt) : NaN
    const finished = s.finishedAt ? Date.parse(s.finishedAt) : NaN
    return {
      event: EVENT_OF[s.status] ?? 'release.failed',
      title: s.kind === 'rollback' ? 'Rollback' : 'Release',
      environment: { name: s.environmentName, color: '', protected: false },
      product: null,
      deployment: null,
      hosts: [],
      status: s.status as 'succeeded' | 'failed' | 'rolled_back',
      version: s.version,
      durationSec: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 1000)) : null,
      urls: [],
      actor: s.triggeredBy,
      at: this.d.now().toISOString(),
    }
  }
}

/** A timer that ends early, resolving, when the signal aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = (): void => {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
