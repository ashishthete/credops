import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubStore, loadHub, loadHubAudit, connectHub, resetHub, startHubSync, refreshAdmin } from '../../src/renderer/src/hub/store'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { HubStatus, HubUser } from '../../src/shared/hub'
import { emitBridgeEvent, mockBridge } from './helpers'

const STAMP = '2026-10-16T09:00:00.000Z'
export const hubUser = (over: Partial<HubUser> = {}): HubUser => ({
  oid: 'o-alice',
  upn: 'alice@corp.example',
  name: 'Alice',
  role: 'maintainer',
  status: 'active',
  groupIds: ['g1'],
  createdAt: STAMP,
  lastSeenAt: null,
  ...over,
})
const linked = (over: Partial<Extract<HubStatus, { linked: true }>> = {}): HubStatus => ({
  linked: true,
  url: 'https://hub.corp.example',
  hubId: 'hub-1',
  hubName: 'Corp Hub',
  signedIn: true,
  signingIn: false,
  online: true,
  user: hubUser(),
  sessionExpiresAt: null,
  ...over,
})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const flush = () => act(async () => {})

describe('hub store', () => {
  beforeEach(() => resetHub())
  afterEach(() => {
    clearToasts()
    vi.restoreAllMocks()
  })

  it('loads the status and follows hub:state pushes', async () => {
    mockBridge({ 'hub:status': linked({ signedIn: false, user: null }) })
    const stop = startHubSync()
    await flush()
    expect(hubStore.get().status).toMatchObject({ linked: true, signedIn: false })
    expect(hubStore.get().statusLoaded).toBe(true)
    act(() => emitBridgeEvent('hub:state', linked({ signingIn: true })))
    expect(hubStore.get().status).toMatchObject({ signingIn: true })
    stop()
    act(() => emitBridgeEvent('hub:state', { linked: false }))
    expect(hubStore.get().status).toMatchObject({ signingIn: true })
  })

  it('connect stores the returned status; a failure toasts and leaves it alone', async () => {
    const invoke = mockBridge({ 'hub:connect': linked({ signedIn: false, user: null }) })
    await loadHub()
    await connectHub('https://hub.corp.example')
    expect(calls(invoke, 'hub:connect')[0]).toEqual(['hub:connect', 'https://hub.corp.example'])
    expect(hubStore.get().status).toMatchObject({ linked: true, hubName: 'Corp Hub' })

    resetHub()
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'hub:connect') throw new Error("Error invoking remote method 'hub:connect': Error: Can't reach the Hub")
      return null
    })
    const seen: string[] = []
    expect(await connectHub('https://nope', (m) => seen.push(m))).toBeUndefined()
    expect(seen).toEqual(["Can't reach the Hub"])
    expect(hubStore.get().status).toEqual({ linked: false })
  })

  it('loads people and groups for an admin only', async () => {
    const admin = linked({ user: hubUser({ role: 'admin' }) })
    const invoke = mockBridge({ 'hub:status': admin, 'hub:users': [hubUser()], 'hub:groups': [] })
    startHubSync()
    await flush()
    expect(hubStore.get().users).toHaveLength(1)
    expect(calls(invoke, 'hub:groups')).toHaveLength(1)

    resetHub()
    const inv2 = mockBridge({ 'hub:status': linked() })
    startHubSync()
    await flush()
    expect(calls(inv2, 'hub:users')).toHaveLength(0)
    await refreshAdmin()
    expect(calls(inv2, 'hub:users')).toHaveLength(0)
  })

  it('a slow audit reply for an older filter does not replace a newer one', async () => {
    const slow = { resolve: (_: unknown) => {} }
    const invoke = mockBridge()
    invoke.mockImplementation((async (ch: string, filter?: { limit?: number }) => {
      if (ch !== 'hub:audit') return null
      if (filter?.limit === 1) return new Promise((r) => (slow.resolve = r))
      return [{ id: 2 }]
    }) as never)
    const first = loadHubAudit({ limit: 1 })
    await loadHubAudit({ limit: 2 })
    slow.resolve([{ id: 1 }])
    await first
    expect(hubStore.get().audit).toEqual([{ id: 2 }])
    expect(hubStore.get().auditLoading).toBe(false)
  })

  it('signing out clears the admin data', async () => {
    mockBridge({ 'hub:status': linked({ user: hubUser({ role: 'admin' }) }), 'hub:users': [hubUser()], 'hub:groups': [] })
    startHubSync()
    await flush()
    act(() => emitBridgeEvent('hub:state', linked({ signedIn: false, user: null })))
    expect(hubStore.get().users).toEqual([])
  })
})
