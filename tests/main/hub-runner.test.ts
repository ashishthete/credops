import { describe, expect, it, vi } from 'vitest'
import type { ReleaseSummary } from '../../src/shared/deploy'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import { createServiceHandlers } from '../../src/main/ipc/handlers/services'
import { HubError } from '../../src/main/hub/client'
import { HUB_OFFLINE_NOTICE, HubRunner, RoutingReleases, type ReleaseApi } from '../../src/main/hub/runner'

const HUB_ENV = 'e1111111-1111-4111-8111-111111111111'
const LOCAL_ENV = 'e2222222-2222-4222-8222-222222222222'

const summary = (id: string, environmentId: string, createdAt: string): ReleaseSummary => ({
  id,
  environmentId,
  environmentName: environmentId === HUB_ENV ? 'prod' : 'dev',
  kind: 'release',
  status: 'succeeded',
  version: null,
  previousVersion: null,
  redeploy: false,
  rollbackOf: null,
  triggeredBy: 'bob@example.com@Test Hub',
  createdAt,
  startedAt: null,
  finishedAt: null,
  deploymentCount: 1,
  hostCount: 1,
  serviceIds: [],
  serviceCount: 1,
  error: null,
  operation: null,
  playbookSource: 'generated',
})

const PREFLIGHT = { environmentId: HUB_ENV, serviceIds: [], bump: 'none' as const, options: { backup: false, notify: false, qa: false } }

/** A ReleaseApi whose every method is a spy. */
function stub(over: Partial<ReleaseApi> = {}): { [K in keyof ReleaseApi]: ReturnType<typeof vi.fn> } & ReleaseApi {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of ['preflight', 'previewPlaybook', 'start', 'cancel', 'rollback', 'breakLock', 'discard', 'retryVersion', 'setNotes', 'list', 'listActive', 'detail', 'events', 'runMeta']) {
    fns[k] = vi.fn(async () => undefined)
  }
  fns.hasActive = vi.fn(() => false)
  fns.onEvent = vi.fn(() => () => undefined)
  return { ...fns, ...over } as never
}

function rig(opts: { posts?: (path: string, body: unknown) => unknown; gets?: (path: string) => unknown } = {}) {
  const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = []
  const client = {
    get: async (path: string, query?: unknown) => {
      calls.push(query === undefined ? { method: 'GET', path } : { method: 'GET', path, query })
      return opts.gets?.(path)
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body })
      return opts.posts?.(path, body)
    },
  }
  const audits: unknown[] = []
  const ids = new Set<string>()
  const runner = new HubRunner({
    client: () => client as never,
    audit: { append: (e: unknown) => void audits.push(e) } as never,
    ids,
    envName: (id) => (id === HUB_ENV ? 'prod' : undefined),
    feed: { onEvent: () => () => undefined },
  })
  const local = stub()
  const notices: string[] = []
  let active = true
  const routing = new RoutingReleases({
    local,
    hub: runner,
    isHubEnv: (id) => id === HUB_ENV,
    hubReleaseIds: ids,
    hubActive: () => active,
    notice: (m) => void notices.push(m),
  })
  return { calls, audits, ids, runner, local, routing, notices, setActive: (v: boolean) => (active = v) }
}

describe('hub runner and release routing', () => {
  it('the playbook preview of a Hub release is read from the Hub, unaudited; the hash goes with start', async () => {
    const preview = { playbook: '[]', sha256: 'a'.repeat(64) }
    const r = rig({ posts: () => ({ releaseId: 'h-1' }), gets: (path) => (path.endsWith('/playbook') ? preview : undefined) })
    r.local.previewPlaybook.mockResolvedValue({ playbook: '[1]', sha256: 'b'.repeat(64) })
    await r.routing.preflight(PREFLIGHT)
    expect(await r.routing.previewPlaybook('h-1')).toEqual(preview)
    await r.routing.start('h-1', { playbookSha256: preview.sha256 })
    expect(r.calls.slice(1)).toEqual([
      { method: 'GET', path: '/api/v1/releases/h-1/playbook' },
      { method: 'POST', path: '/api/v1/releases/h-1/start', body: { playbookSha256: preview.sha256 } },
    ])
    expect(r.audits.map((a) => (a as { details: { op: string } }).details.op)).toEqual(['preflight', 'start'])
    expect(await r.routing.previewPlaybook('l-1')).toEqual({ playbook: '[1]', sha256: 'b'.repeat(64) })
  })

  it('a preview with forced services asks the Hub with each id as a query value and the local service with them', async () => {
    const preview = { playbook: '[]', sha256: 'a'.repeat(64) }
    const r = rig({ posts: () => ({ releaseId: 'h-1' }), gets: () => preview })
    await r.routing.preflight(PREFLIGHT)
    await r.routing.previewPlaybook('h-1', undefined, ['s-1', 's-2'])
    await r.routing.previewPlaybook('h-1')
    expect(r.calls.slice(1).map((c) => c.path)).toEqual(['/api/v1/releases/h-1/playbook?forceServiceIds=s-1&forceServiceIds=s-2', '/api/v1/releases/h-1/playbook'])
    await r.routing.previewPlaybook('l-1', undefined, ['s-3'])
    expect(r.local.previewPlaybook).toHaveBeenCalledWith('l-1', undefined, ['s-3'])
  })

  it('routes hub environments to the Hub and others to local', async () => {
    const r = rig({ posts: () => ({ releaseId: 'h-1' }) })
    r.local.preflight.mockResolvedValue({ releaseId: 'l-1' })
    expect(await r.routing.preflight(PREFLIGHT)).toEqual({ releaseId: 'h-1' })
    expect(r.calls).toEqual([{ method: 'POST', path: '/api/v1/releases/preflight', body: PREFLIGHT }])
    expect(r.local.preflight).not.toHaveBeenCalled()
    expect(await r.routing.preflight({ ...PREFLIGHT, environmentId: LOCAL_ENV })).toEqual({ releaseId: 'l-1' })
    expect(r.calls).toHaveLength(1)
    expect(r.audits).toMatchObject([{ action: 'hub.release', outcome: 'success', details: { op: 'preflight', releaseId: 'h-1', environmentName: 'prod' } }])
  })

  it('id calls follow the release origin, audit locally and keep the Hub messages', async () => {
    const r = rig({
      posts: (path) => {
        if (path.endsWith('/preflight')) return { releaseId: 'h-1' }
        if (path.endsWith('/start')) throw new HubError('env_locked', 'Locked by Ann since 2026-10-20: a release is running', 409)
        if (path.endsWith('/rollback')) throw new HubError('confirm_required', 'Type the environment name "prod" to deploy to a protected environment', 400)
        return undefined
      },
    })
    await r.routing.preflight(PREFLIGHT)
    await expect(r.routing.start('h-1', { typedName: 'prod' })).rejects.toMatchObject({ code: 'env_locked', message: expect.stringContaining('Locked by Ann') })
    await expect(r.routing.rollback('h-1', {})).rejects.toMatchObject({ code: 'confirm_required', message: expect.stringContaining('Type the environment name') })
    await r.routing.cancel('h-1')
    await r.routing.breakLock('h-1', 'host-1', { typedLabel: 'web-1' })
    expect(r.calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/releases/h-1/start',
      'POST /api/v1/releases/h-1/rollback',
      'POST /api/v1/releases/h-1/cancel',
      'POST /api/v1/releases/h-1/break-lock',
    ])
    expect(r.calls[1]!.body).toEqual({ typedName: 'prod' })
    expect(r.calls[4]!.body).toEqual({ hostId: 'host-1', typedLabel: 'web-1' })
    expect(r.audits.map((a) => (a as { outcome: string; details: { op: string } }).outcome + ':' + (a as { details: { op: string } }).details.op)).toEqual([
      'success:preflight',
      'failure:start',
      'failure:rollback',
      'success:cancel',
      'success:break-lock',
    ])
    expect(r.audits[1]).toMatchObject({ action: 'hub.release', targetId: 'h-1', details: { op: 'start', releaseId: 'h-1', environmentName: 'prod', reason: 'env_locked' } })
    // A release the Hub never told us about is local.
    await r.routing.start('l-9', {})
    expect(r.local.start).toHaveBeenCalledWith('l-9', {})
    expect(r.calls).toHaveLength(5)
  })

  it('list merges local and hub, newest first, and learns the Hub ids', async () => {
    const hubRows = [summary('h-2', HUB_ENV, '2026-10-20T10:00:00.000Z')]
    const r = rig({ gets: () => hubRows })
    r.local.list.mockResolvedValue([summary('l-3', LOCAL_ENV, '2026-10-20T12:00:00.000Z'), summary('l-1', LOCAL_ENV, '2026-10-20T08:00:00.000Z')])
    expect((await r.routing.list({})).map((s) => s.id)).toEqual(['l-3', 'h-2', 'l-1'])
    expect(r.ids.has('h-2')).toBe(true)
    expect((await r.routing.list({ limit: 2 })).map((s) => s.id)).toEqual(['l-3', 'h-2'])
    // An environment filter asks only the side that owns the environment.
    r.local.list.mockClear()
    await r.routing.list({ environmentId: HUB_ENV })
    expect(r.local.list).not.toHaveBeenCalled()
    r.calls.length = 0
    await r.routing.list({ environmentId: LOCAL_ENV })
    expect(r.calls).toEqual([])
    r.local.listActive.mockResolvedValue([])
    expect((await r.routing.listActive()).map((s) => s.id)).toEqual(['h-2'])
  })

  it('the Hub runs no operations: operations "only" asks local alone, "exclude" keeps Hub releases and never sends the key', async () => {
    const hubRows = [summary('h-2', HUB_ENV, '2026-10-20T10:00:00.000Z')]
    const r = rig({ gets: () => hubRows })
    const op = { ...summary('l-op', LOCAL_ENV, '2026-10-20T11:00:00.000Z'), operation: { runbookId: 'rb', name: 'Restart', params: {}, readOnly: false, lock: true, targetServiceIds: [] } }
    r.local.list.mockResolvedValue([op])
    expect((await r.routing.list({ operations: 'only' })).map((s) => s.id)).toEqual(['l-op'])
    expect(r.calls).toEqual([])
    expect(await r.routing.list({ environmentId: HUB_ENV, operations: 'only' })).toEqual([])
    expect(r.calls).toEqual([])
    r.local.list.mockResolvedValue([summary('l-1', LOCAL_ENV, '2026-10-20T08:00:00.000Z')])
    expect((await r.routing.list({ operations: 'exclude' })).map((s) => s.id)).toEqual(['h-2', 'l-1'])
    expect(r.local.list).toHaveBeenLastCalledWith({ operations: 'exclude' })
    expect(r.calls).toEqual([{ method: 'GET', path: '/api/v1/releases', query: {} }])
  })

  it('offline Hub hides team releases once, local still works', async () => {
    const r = rig({
      gets: () => {
        throw new HubError('network', "Can't reach the Hub")
      },
    })
    r.local.list.mockResolvedValue([summary('l-1', LOCAL_ENV, '2026-10-20T08:00:00.000Z')])
    expect((await r.routing.list({})).map((s) => s.id)).toEqual(['l-1'])
    expect((await r.routing.list({})).map((s) => s.id)).toEqual(['l-1'])
    expect(r.notices).toEqual([HUB_OFFLINE_NOTICE])
    expect(HUB_OFFLINE_NOTICE).toBe('Hub offline — team releases hidden')
    await r.routing.start('l-1', {})
    expect(r.local.start).toHaveBeenCalled()
    // Signed out of the Hub is not an outage: no call and no notice.
    r.setActive(false)
    r.calls.length = 0
    await r.routing.list({})
    expect(r.calls).toEqual([])
    expect(r.notices).toHaveLength(1)
    // A real Hub error is not hidden.
    const bad = rig({
      gets: () => {
        throw new HubError('forbidden', 'No', 403)
      },
    })
    bad.local.list.mockResolvedValue([])
    await expect(bad.routing.list({})).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a proxied Hub that is down (5xx, unavailable, no status) is offline; 401 and 403 are not', async () => {
    for (const err of [new HubError('internal', 'Bad gateway', 502), new HubError('unavailable', 'Hub unavailable', 503), new HubError('internal', 'No status')]) {
      const r = rig({
        gets: () => {
          throw err
        },
      })
      r.local.list.mockResolvedValue([summary('l-1', LOCAL_ENV, '2026-10-20T08:00:00.000Z')])
      expect((await r.routing.list({})).map((s) => s.id)).toEqual(['l-1'])
      r.local.listActive.mockResolvedValue([])
      expect((await r.routing.listActive()).length).toBe(0)
      expect(r.notices).toEqual([HUB_OFFLINE_NOTICE])
    }
    const expired = rig({
      gets: () => {
        throw new HubError('session_expired', 'Your session expired', 401)
      },
    })
    expired.local.list.mockResolvedValue([])
    await expect(expired.routing.list({})).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('the wizard readers fall back to the Hub catalog for an environment with no local copy', async () => {
    const dep = { id: 'd1', name: 'web', environmentId: HUB_ENV, hostId: 'h1', repoPath: '/srv/web', defaultBranch: 'main', deployTag: 'web' }
    const env = { environment: { id: HUB_ENV, name: 'prod', protected: true, versioned: true, autoRollback: true, currentVersion: 'v1.2.3' }, deployments: [dep], services: [
      { id: 's1', name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: 'd1', hostId: 'h1', viaHostId: null },
      { id: 's2', name: 'pg', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: 'h1' },
    ] }
    const catalog = { get: (id: string) => (id === HUB_ENV ? env : undefined), list: () => [env] } as never
    const deploys = {
      list: vi.fn(() => []),
      settings: vi.fn(() => {
        throw new Error('environment not found')
      }),
    }
    const h = createDeployHandlers({ deploys: deploys as never, releases: stub(), tooling: async () => ({}) as never, catalog })
    expect((await h['deploy:list'](HUB_ENV)).map((d) => [d.id, d.vaultIds])).toEqual([['d1', []]])
    expect((await h['deploy:list'](undefined)).map((d) => d.id)).toEqual(['d1'])
    expect(await h['deploy:list'](LOCAL_ENV)).toEqual([])
    expect(await h['deploy:settings'](HUB_ENV)).toEqual({ environmentId: HUB_ENV, versioned: true, autoRollback: true, currentVersion: 'v1.2.3', parallelPrepare: true, prepareCap: 3, flow: null })
    await expect(Promise.resolve().then(() => h['deploy:settings'](LOCAL_ENV))).rejects.toThrow('environment not found')
    // An environment this desktop published reads its own row, the one its edits write.
    const own = createDeployHandlers({ deploys: { ...deploys, settings: vi.fn(() => ({ environmentId: HUB_ENV, versioned: false, autoRollback: false, currentVersion: null })) } as never, releases: stub(), tooling: async () => ({}) as never, catalog, published: (id) => id === HUB_ENV })
    expect(await own['deploy:settings'](HUB_ENV)).toMatchObject({ versioned: false })
    const sh = createServiceHandlers({ services: { list: () => [] } as never, copy: vi.fn(), deploys: {} as never, containers: {} as never, tunnels: {} as never, openExternal: async () => undefined, catalog })
    const services = await sh['service:list'](HUB_ENV)
    expect(services.map((x) => [x.id, x.kind])).toEqual([['s1', 'service']])
  })
})
