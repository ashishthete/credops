import { describe, expect, it, vi } from 'vitest'
import { localAllowAll } from '../../src/main/deploy/access'
import { HubError } from '../../src/main/hub/client'
import { HubAccess, RoutingAccess } from '../../src/main/hub/access'
import type { HubDecision, HubStatus } from '../../src/shared/hub'

const actor = { osUser: 'u', machine: 'm' }
const signedIn: HubStatus = {
  linked: true, url: 'http://127.0.0.1:1', hubId: 'h', hubName: 'H', signedIn: true, signingIn: false,
  online: true, user: null, sessionExpiresAt: null,
}

function setup(get: (path: string, query?: Record<string, unknown>) => Promise<unknown>, status: HubStatus = signedIn) {
  const listeners: (() => void)[] = []
  const clock = { t: 1_000 }
  const conn = {
    status: () => status,
    client: () => ({ get }),
    onState: (fn: () => void) => void listeners.push(fn),
  }
  const access = new HubAccess(conn as never, { now: () => clock.t })
  return { access, clock, fire: () => listeners.forEach((l) => l()) }
}

const ALLOW: HubDecision = { allowed: true, via: { role: 'admin', groupId: null, groupName: null } }

describe('HubAccess', () => {
  it('maps a Hub denial to its reason', async () => {
    const get = vi.fn(async () => ({ allowed: false, code: 'no_grant', reason: 'No group grants this' }))
    const { access } = setup(get)
    expect(await access.check(actor, 'release.start', { environmentId: 'e', deploymentIds: ['a', 'b'] })).toEqual({
      allowed: false,
      reason: 'No group grants this',
    })
    expect(get).toHaveBeenCalledWith('/api/v1/access', { action: 'release.start', environmentId: 'e', deploymentIds: ['a', 'b'] })
  })

  it('allows when the Hub allows', async () => {
    const { access } = setup(async () => ALLOW)
    expect(await access.check(actor, 'deploy.view', { environmentId: 'e' })).toEqual({ allowed: true })
  })

  it('caches for 30 s and clears on state change', async () => {
    const get = vi.fn(async () => ALLOW)
    const { access, clock, fire } = setup(get)
    const t = { environmentId: 'e', deploymentIds: ['a'] }
    await access.check(actor, 'deploy.view', t)
    await access.check(actor, 'deploy.view', t)
    expect(get).toHaveBeenCalledTimes(1)
    await access.check(actor, 'deploy.edit', t)
    expect(get).toHaveBeenCalledTimes(2)
    clock.t += 29_999
    await access.check(actor, 'deploy.view', t)
    expect(get).toHaveBeenCalledTimes(2)
    clock.t += 2
    await access.check(actor, 'deploy.view', t)
    expect(get).toHaveBeenCalledTimes(3)
    fire()
    await access.check(actor, 'deploy.view', t)
    expect(get).toHaveBeenCalledTimes(4)
  })

  it('Hub unreachable denies with a reason and is not cached', async () => {
    const get = vi.fn(async () => {
      throw new HubError('network', "Can't reach the Hub")
    })
    const { access } = setup(get)
    const r = { allowed: false, reason: 'Hub unreachable' }
    expect(await access.check(actor, 'deploy.view', { environmentId: 'e' })).toEqual(r)
    expect(await access.check(actor, 'deploy.view', { environmentId: 'e' })).toEqual(r)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('denies without a Hub call when signed out', async () => {
    const get = vi.fn()
    const { access } = setup(get, { ...signedIn, signedIn: false })
    const r = await access.check(actor, 'deploy.view', { environmentId: 'e' })
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/Sign in/)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('RoutingAccess', () => {
  it('routes hub-linked environments to the Hub and others to local allow-all', async () => {
    const hub = { check: vi.fn(async () => ({ allowed: false, reason: 'nope' })) }
    const local = { check: vi.fn(localAllowAll.check) }
    const routing = new RoutingAccess({ local, hub, isHubTarget: (id) => id === 'linked' })
    expect(await routing.check(actor, 'release.start', { environmentId: 'linked' })).toEqual({ allowed: false, reason: 'nope' })
    expect(await routing.check(actor, 'release.start', { environmentId: 'other' })).toEqual({ allowed: true })
    expect(hub.check).toHaveBeenCalledTimes(1)
    expect(local.check).toHaveBeenCalledTimes(1)
  })
})
