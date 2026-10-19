import { LIVE_HEARTBEAT_MS, LIVE_MAX_STREAMS_PER_USER, type HubGroup, type HubLiveMessage, type HubUser } from '../../../src/shared/hub'
import { redact } from '../../../src/main/security/redact'
import { decide } from '../access/policy'
import type { Directory } from '../access/directory'

interface Sub {
  oid: string
  /** sha-256 of the session token, never the token. */
  sessionKey: string | null
  /** ms since epoch; null for no limit. */
  expiresAt: number | null
  write: (frame: string) => void
  close: () => void
}

export interface LiveBusOpts {
  directory: Pick<Directory, 'get' | 'listGroups'>
  /** Values that must never reach a client, on top of the pattern-based redaction. */
  knownSecrets: () => readonly string[]
  now?: () => Date
  /** Starts a repeating timer and returns its canceller; tests pass a manual clock. */
  every?: (fn: () => void, ms: number) => () => void
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms)
  t.unref()
  return () => clearInterval(t)
}

/**
 * Fans Hub state out to open SSE streams. Visibility is judged per subscriber, per message, at
 * publish time, so a revoked grant stops frames at once and a stream never outlives its person's access.
 */
export class LiveBus {
  private readonly subs = new Set<Sub>()
  private stopBeat: (() => void) | null = null

  constructor(private readonly opts: LiveBusOpts) {}

  subscribe(oid: string, write: (frame: string) => void, close: () => void, sessionKey: string | null = null, expiresAt: number | null = null): () => void {
    const mine = [...this.subs].filter((s) => s.oid === oid)
    // Past the cap the oldest stream goes; Set iteration is insertion order.
    for (const old of mine.slice(0, Math.max(0, mine.length - LIVE_MAX_STREAMS_PER_USER + 1))) this.drop(old)
    const sub: Sub = { oid, sessionKey, expiresAt, write, close }
    this.subs.add(sub)
    this.stopBeat ??= (this.opts.every ?? defaultEvery)(() => this.beat(), LIVE_HEARTBEAT_MS)
    return () => this.remove(sub)
  }

  size(): number {
    return this.subs.size
  }

  /** Ends every stream of a person (disabled, or all sessions revoked). */
  closeUser(oid: string): void {
    for (const s of [...this.subs]) if (s.oid === oid) this.drop(s)
  }

  /** Ends the streams of one session (sign-out). */
  closeSession(sessionKey: string): void {
    for (const s of [...this.subs]) if (s.sessionKey === sessionKey) this.drop(s)
  }

  closeAll(): void {
    for (const s of [...this.subs]) this.drop(s)
  }

  publish(msg: HubLiveMessage): void {
    if (this.subs.size === 0) return
    const users = new Map<string, HubUser | null>()
    let groups: HubGroup[] | null = null
    const frameFor = (): string => {
      const data = redact(msg, this.opts.knownSecrets())
      return `event: ${msg.type}\ndata: ${JSON.stringify(data)}\n\n`
    }
    let frame: string | null = null
    for (const sub of [...this.subs]) {
      if (this.expired(sub)) {
        this.drop(sub)
        continue
      }
      if (msg.type !== 'catalog.updated' && msg.type !== 'access.changed') {
        const environmentId = msg.type === 'release.state' ? msg.summary.environmentId : msg.environmentId
        if (!users.has(sub.oid)) users.set(sub.oid, this.opts.directory.get(sub.oid))
        const user = users.get(sub.oid)
        if (!user) {
          this.drop(sub)
          continue
        }
        groups ??= this.opts.directory.listGroups()
        if (!decide(user, groups, 'deploy.view', { environmentId }).allowed) continue
      }
      frame ??= frameFor()
      this.send(sub, frame)
    }
  }

  private beat(): void {
    for (const sub of [...this.subs]) {
      if (this.expired(sub)) this.drop(sub)
      else this.send(sub, ': ping\n\n')
    }
  }

  /** The authoritative expiry check: a session's stream never outlives the session. */
  private expired(sub: Sub): boolean {
    return sub.expiresAt !== null && (this.opts.now ?? (() => new Date()))().getTime() >= sub.expiresAt
  }

  /** Ends the streams whose session has expired; the route's timer calls this at the deadline. */
  closeExpired(): void {
    for (const s of [...this.subs]) if (this.expired(s)) this.drop(s)
  }

  private send(sub: Sub, frame: string): void {
    try {
      sub.write(frame)
    } catch {
      this.drop(sub)
    }
  }

  private drop(sub: Sub): void {
    this.remove(sub)
    try {
      sub.close()
    } catch {
      // Already gone.
    }
  }

  private remove(sub: Sub): void {
    this.subs.delete(sub)
    if (this.subs.size === 0 && this.stopBeat) {
      this.stopBeat()
      this.stopBeat = null
    }
  }
}
