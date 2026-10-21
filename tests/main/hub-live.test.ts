import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseSummary, RunEvent } from '../../src/shared/deploy'
import type { HubLiveMessage } from '../../src/shared/hub'
import { HubClient } from '../../src/main/hub/client'
import { LiveFeed } from '../../src/main/hub/live'

const REL = '99999999-9999-4999-8999-999999999999'
const OTHER = '88888888-8888-4888-8888-888888888888'

const ev = (releaseId: string, seq: number): RunEvent =>
  ({ id: `ev-${releaseId}-${seq}`, runId: releaseId, seq, at: '2026-10-20T10:00:00.000Z', type: 'log', stepId: null, hostId: null, stream: 'ansible', line: `line ${seq}` }) as RunEvent

const summary = (id: string, status: ReleaseSummary['status'], triggeredBy = 'bob@example.com@Test Hub'): ReleaseSummary => ({
  id,
  environmentId: 'e1111111-1111-4111-8111-111111111111',
  environmentName: 'prod',
  kind: 'release',
  status,
  version: 'v1.0.1',
  previousVersion: 'v1.0.0',
  redeploy: false,
  rollbackOf: null,
  triggeredBy,
  createdAt: '2026-10-20T10:00:00.000Z',
  startedAt: '2026-10-20T10:00:00.000Z',
  finishedAt: status === 'running' ? null : '2026-10-20T10:01:30.000Z',
  deploymentCount: 1,
  hostCount: 1,
  serviceIds: [],
  serviceCount: 1,
  error: null,
})

const frame = (m: HubLiveMessage): string => `event: ${m.type}\ndata: ${JSON.stringify(m)}\n\n`
const batch = (releaseId: string, from: number, to: number): HubLiveMessage => ({
  type: 'deploy.events',
  environmentId: 'e1111111-1111-4111-8111-111111111111',
  events: Array.from({ length: to - from + 1 }, (_, i) => ev(releaseId, from + i)),
})

interface Script {
  /** What the nth /live connection does; an object answers with a plain status. */
  live: ((res: ServerResponse) => void | Promise<void>)[]
  active: () => ReleaseSummary[]
  /** The Hub's event log per release. */
  log: Map<string, RunEvent[]>
  /** GET /releases/:id */
  detail?: Map<string, ReleaseSummary>
  /** Releases whose events and detail answer 403, as after a revoked grant. */
  forbidden?: Set<string>
}

let server: Server | undefined
let feed: LiveFeed | undefined
afterEach(async () => {
  feed?.stop()
  await new Promise<void>((r) => (server ? server.closeAllConnections() : undefined, server ? server.close(() => r()) : r()))
  server = undefined
})

async function start(script: Script) {
  const seen = { live: 0, active: 0, events: [] as string[], auth: [] as (string | undefined)[] }
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/api/v1/live') {
      seen.auth.push(req.headers.authorization)
      const step = script.live[seen.live++] ?? ((r: ServerResponse) => void r.destroy())
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': live\n\n')
      void step(res)
      return
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/v1/releases/active') {
      seen.active++
      res.end(JSON.stringify(script.active()))
      return
    }
    const rel = /^\/api\/v1\/releases\/([^/]+)/.exec(url.pathname)
    if (rel && script.forbidden?.has(rel[1]!)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: { code: 'forbidden', message: 'No access' } }))
      return
    }
    const one = /^\/api\/v1\/releases\/([^/]+)$/.exec(url.pathname)
    if (one && script.detail?.has(one[1]!)) {
      res.end(JSON.stringify(script.detail.get(one[1]!)))
      return
    }
    const m = /^\/api\/v1\/releases\/([^/]+)\/events$/.exec(url.pathname)
    if (m) {
      seen.events.push(url.search)
      const after = Number(url.searchParams.get('afterSeq') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 1000)
      res.end(JSON.stringify((script.log.get(m[1]!) ?? []).filter((e) => e.seq > after).slice(0, limit)))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { seen, base: `http://127.0.0.1:${port}` }
}

function make(base: string, over: Partial<ConstructorParameters<typeof LiveFeed>[0]> = {}) {
  const pushed = { events: [] as RunEvent[], states: [] as ReleaseSummary[], locks: 0, catalog: 0 }
  const shown: { facts: unknown; route: string }[] = []
  const client = new HubClient({ baseUrl: base, fetch, token: () => 'tok', renew: async () => false, knownSecrets: () => [] })
  feed = new LiveFeed({
    client: () => client,
    renew: async () => false,
    backoff: () => 0,
    sleep: async () => undefined,
    push: {
      events: (b) => void pushed.events.push(...b),
      state: (s) => void pushed.states.push(s),
      locks: () => void pushed.locks++,
      catalog: () => void pushed.catalog++,
    },
    isMine: (s) => s.triggeredBy === 'bob@example.com@Test Hub',
    notifier: { show: (facts, route) => void shown.push({ facts, route }) },
    now: () => new Date('2026-10-20T10:02:00.000Z'),
    ...over,
  })
  return { feed, pushed, shown }
}

const seqs = (events: RunEvent[], id = REL): number[] => events.filter((e) => e.runId === id).map((e) => e.seq)

describe('hub live feed', () => {
  it('reconnect backfills without duplicates', async () => {
    // The Hub is at seq 9 when the first stream drops after seq 5; it then streams 9 again, then 10 to 12.
    const log = new Map([[REL, Array.from({ length: 9 }, (_, i) => ev(REL, i + 1))]])
    const { seen, base } = await start({
      log,
      active: () => [summary(REL, 'running')],
      live: [
        (res) => {
          res.write(frame(batch(REL, 1, 3)))
          res.write(frame(batch(REL, 4, 5)))
          setTimeout(() => res.destroy(), 20)
        },
        (res) => {
          res.write(frame(batch(REL, 9, 9)))
          log.set(REL, Array.from({ length: 12 }, (_, i) => ev(REL, i + 1)))
          res.write(frame(batch(REL, 10, 12)))
        },
      ],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(seqs(pushed.events)).toHaveLength(12))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(seen.live).toBe(2)
    expect(seen.active).toBe(2)
    // The catch-up asked only for what was missed.
    expect(seen.events[0]).toContain('afterSeq=5')
    expect(seen.auth).toEqual(['Bearer tok', 'Bearer tok'])
  })

  it('a gap triggers a backfill', async () => {
    const log = new Map([[REL, Array.from({ length: 5 }, (_, i) => ev(REL, i + 1))]])
    const { seen, base } = await start({
      log,
      active: () => [],
      live: [
        (res) => {
          res.write(frame(batch(REL, 1, 2)))
          // 3 and 4 never arrive on the stream.
          res.write(frame(batch(REL, 5, 5)))
        },
      ],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(seqs(pushed.events)).toHaveLength(5))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4, 5])
    expect(seen.events.filter((q) => q.includes('afterSeq=2'))).toHaveLength(1)
  })

  it('own terminal release notifies once, others and running ones do not', async () => {
    const { base } = await start({
      log: new Map(),
      active: () => [],
      live: [
        (res) => {
          res.write(frame({ type: 'release.state', summary: summary(REL, 'running') }))
          res.write(frame({ type: 'release.state', summary: summary(OTHER, 'succeeded', 'ann@example.com@Test Hub') }))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'succeeded') }))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'succeeded') }))
          res.write(frame({ type: 'lock.updated', environmentId: 'e1111111-1111-4111-8111-111111111111', lock: null }))
          res.write(frame({ type: 'catalog.updated' }))
        },
      ],
    })
    const tracked: string[] = []
    const { feed, pushed, shown } = make(base, { track: (id) => void tracked.push(id) })
    feed.start()
    await vi.waitFor(() => expect(pushed.catalog).toBe(2))
    await feed.idle()
    expect(pushed.states.map((s) => `${s.id}:${s.status}`)).toHaveLength(4)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      route: `/deployments/release/${REL}`,
      facts: { status: 'succeeded', version: 'v1.0.1', durationSec: 90, environment: { name: 'prod' } },
    })
    expect(pushed.locks).toBe(1)
    expect(new Set(tracked)).toEqual(new Set([REL, OTHER]))
  })

  it('a tracked release that finished while the stream was down gets its terminal state', async () => {
    const log = new Map([[REL, Array.from({ length: 4 }, (_, i) => ev(REL, i + 1))]])
    const { base } = await start({
      log,
      active: () => [],
      detail: new Map([[REL, summary(REL, 'succeeded')]]),
      live: [
        (res) => {
          res.write(frame(batch(REL, 1, 2)))
          setTimeout(() => res.destroy(), 20)
        },
        () => undefined,
      ],
    })
    const { feed, pushed, shown } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['succeeded']))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4])
    expect(shown).toHaveLength(1)
  })

  it('a release whose grant was revoked is dropped and the feed keeps going', async () => {
    const forbidden = new Set<string>()
    const log = new Map([
      [REL, Array.from({ length: 4 }, (_, i) => ev(REL, i + 1))],
      [OTHER, Array.from({ length: 4 }, (_, i) => ev(OTHER, i + 1))],
    ])
    const { base } = await start({
      log,
      forbidden,
      active: () => [summary(OTHER, 'running')],
      live: [
        (res) => {
          res.write(frame(batch(REL, 1, 2)))
          res.write(frame(batch(OTHER, 1, 2)))
          setTimeout(() => (forbidden.add(REL), res.destroy()), 20)
        },
        (res) => void res.write(frame({ type: 'catalog.updated' })),
      ],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.catalog).toBeGreaterThan(0))
    await feed.idle()
    expect(seqs(pushed.events, OTHER)).toEqual([1, 2, 3, 4])
    expect(seqs(pushed.events)).toEqual([1, 2])
  })

  it('events that straggle in after the terminal state are not pushed twice', async () => {
    const log = new Map([[REL, Array.from({ length: 4 }, (_, i) => ev(REL, i + 1))]])
    const { base } = await start({
      log,
      active: () => [],
      live: [
        (res) => {
          res.write(frame(batch(REL, 1, 2)))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'succeeded') }))
          res.write(frame(batch(REL, 3, 4)))
        },
      ],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['succeeded']))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4])
  })

  it('a retried release is live again: its events and terminal state are shown and notified', async () => {
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => ev(REL, i + 1))
    const log = new Map([[REL, upTo(2)]])
    const { base } = await start({
      log,
      active: () => [],
      live: [
        async (res) => {
          res.write(frame(batch(REL, 1, 2)))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'failed') }))
          await new Promise((r) => setTimeout(r, 40))
          // retry-version: the same release id runs again and its log grows.
          log.set(REL, upTo(6))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'running') }))
          res.write(frame(batch(REL, 3, 6)))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'succeeded') }))
        },
      ],
    })
    const { feed, pushed, shown } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['failed', 'running', 'succeeded']))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4, 5, 6])
    // Each terminal state of the person's own release notifies once.
    expect(shown).toHaveLength(2)
  })

  it('a retry that starts while the stream is down is caught up without duplicates', async () => {
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => ev(REL, i + 1))
    const log = new Map([[REL, upTo(4)]])
    let running = false
    const { base } = await start({
      log,
      active: () => (running ? [summary(REL, 'running')] : []),
      live: [
        async (res) => {
          res.write(frame(batch(REL, 1, 2)))
          // The failed state backfills 3-4 from the Hub's log.
          res.write(frame({ type: 'release.state', summary: summary(REL, 'failed') }))
          await new Promise((r) => setTimeout(r, 40))
          log.set(REL, upTo(6))
          running = true
          res.destroy()
        },
        (res) => {
          res.write(frame(batch(REL, 5, 6)))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'succeeded') }))
        },
      ],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['failed', 'running', 'succeeded']))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a retry that starts and finishes while the stream is down shows succeeded after reconnect', async () => {
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => ev(REL, i + 1))
    const log = new Map([[REL, upTo(2)]])
    const detail = new Map<string, ReleaseSummary>()
    const { base } = await start({
      log,
      detail,
      active: () => [],
      live: [
        async (res) => {
          res.write(frame(batch(REL, 1, 2)))
          res.write(frame({ type: 'release.state', summary: summary(REL, 'failed') }))
          await new Promise((r) => setTimeout(r, 40))
          // While the stream is down the retry runs and succeeds.
          log.set(REL, upTo(4))
          detail.set(REL, summary(REL, 'succeeded'))
          res.destroy()
        },
        () => undefined,
      ],
    })
    const { feed, pushed, shown } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['failed', 'succeeded']))
    await feed.idle()
    expect(seqs(pushed.events)).toEqual([1, 2, 3, 4])
    // The failure and the retry's success each notify once.
    expect(shown).toHaveLength(2)
  })

  it('a terminal state for a release this client never tracked fetches no events', async () => {
    const log = new Map([[OTHER, Array.from({ length: 50 }, (_, i) => ev(OTHER, i + 1))]])
    const { base, seen } = await start({
      log,
      active: () => [],
      live: [(res) => void res.write(frame({ type: 'release.state', summary: summary(OTHER, 'failed') }))],
    })
    const { feed, pushed } = make(base)
    feed.start()
    await vi.waitFor(() => expect(pushed.states.map((s) => s.status)).toEqual(['failed']))
    await feed.idle()
    expect(seen.events).toEqual([])
    expect(pushed.events).toEqual([])
  })

  it('401 renews once, then signs out', async () => {
    // A server whose first /live answers 401 session_expired; the retry streams.
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x')
      if (url.pathname === '/api/v1/live') {
        calls.push(req.headers.authorization ?? '')
        if (calls.length === 1 || always) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'session_expired', message: 'Your session expired' }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(frame({ type: 'catalog.updated' }))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end('[]')
    })
    const calls: string[] = []
    let always = false
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    let token = 'old'
    const renew = vi.fn(async () => {
      token = 'new'
      return true
    })
    const signedOut = vi.fn()
    const client = new HubClient({ baseUrl: base, fetch, token: () => token, renew: async () => false, knownSecrets: () => [] })
    const first = make(base, { client: () => client, renew, onSignedOut: signedOut })
    first.feed.start()
    await vi.waitFor(() => expect(first.pushed.catalog).toBe(1))
    expect(renew).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['Bearer old', 'Bearer new'])
    expect(signedOut).not.toHaveBeenCalled()
    first.feed.stop()

    // A renewed session that is refused again ends the feed: one renewal, then signed out.
    always = true
    calls.length = 0
    renew.mockClear()
    const second = make(base, { client: () => client, renew, onSignedOut: signedOut })
    second.feed.start()
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1))
    expect(renew).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(second.feed.running()).toBe(false)

    // A renewal that says "sign in again" ends it at once.
    calls.length = 0
    signedOut.mockClear()
    const third = make(base, { client: () => client, renew: async () => false, onSignedOut: signedOut })
    third.feed.start()
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1))
    expect(calls).toHaveLength(1)
  })
})
