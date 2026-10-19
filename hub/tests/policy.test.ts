import { describe, expect, it } from 'vitest'
import type { GrantScope, HubAction, HubGroup, HubUser } from '../../src/shared/hub'
import { decide } from '../src/access/policy'

const E1 = 'e1111111-1111-4111-8111-111111111111'
const E2 = 'e2222222-2222-4222-8222-222222222222'
const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const D3 = 'd3333333-3333-4333-8333-333333333333'

let n = 0
const group = (id: string, name: string, scopes: GrantScope[], createdAt = '2026-01-01T00:00:00Z'): HubGroup => ({
  id,
  name,
  description: '',
  builtin: false,
  memberOids: [],
  grants: scopes.map((scope) => ({ id: `g${++n}`, groupId: id, scope, createdAt })),
  createdAt,
  updatedAt: createdAt,
})
const user = (over: Partial<HubUser> = {}): HubUser => ({
  oid: 'u1',
  upn: 'u@x.com',
  name: 'U',
  role: 'maintainer',
  status: 'active',
  groupIds: [],
  createdAt: '',
  lastSeenAt: null,
  ...over,
})

const DEFAULT = group('def', 'Default', [{ kind: 'all' }])
const ENV1 = group('g-e1', 'Payments-prod', [{ kind: 'environment', environmentId: E1 }], '2026-02-01T00:00:00Z')
const DEP1 = group('g-d1', 'D1 only', [{ kind: 'deployment', environmentId: E1, deploymentId: D1 }], '2026-03-01T00:00:00Z')
const DEP2 = group('g-d2', 'D2 only', [{ kind: 'deployment', environmentId: E1, deploymentId: D2 }], '2026-03-02T00:00:00Z')
const ALL = [DEFAULT, ENV1, DEP1, DEP2]

describe('decide', () => {
  it('pending and disabled see nothing', () => {
    expect(decide(user({ status: 'pending' }), ALL, 'deploy.view', { environmentId: E1 })).toMatchObject({ allowed: false, code: 'pending' })
    expect(decide(user({ status: 'disabled', groupIds: ['def'] }), ALL, 'deploy.view', { environmentId: E1 })).toMatchObject({
      allowed: false,
      code: 'disabled',
      reason: 'Your Hub account is disabled',
    })
  })

  it('Default grants every environment', () => {
    const u = user({ groupIds: ['def'] })
    for (const e of [E1, E2]) {
      expect(decide(u, ALL, 'release.start', { environmentId: e })).toMatchObject({ allowed: true, via: { groupName: 'Default' } })
    }
  })

  it('environment grant allows only that environment', () => {
    const u = user({ groupIds: ['g-e1'] })
    expect(decide(u, ALL, 'release.start', { environmentId: E1 }).allowed).toBe(true)
    expect(decide(u, ALL, 'release.start', { environmentId: E2 })).toMatchObject({ allowed: false, code: 'no_grant' })
  })

  it('deployment grant allows only that deployment, and view of its environment', () => {
    const u = user({ groupIds: ['g-d1'] })
    expect(decide(u, ALL, 'release.start', { environmentId: E1, deploymentIds: [D1] }).allowed).toBe(true)
    expect(decide(u, ALL, 'release.start', { environmentId: E1, deploymentIds: [D2] })).toMatchObject({ allowed: false, code: 'no_grant' })
    expect(decide(u, ALL, 'deploy.view', { environmentId: E1 }).allowed).toBe(true)
    expect(decide(u, ALL, 'release.start', { environmentId: E1 })).toMatchObject({ allowed: false, code: 'no_grant' })
  })

  it('admin is allowed everywhere with role attribution', () => {
    const a = user({ role: 'admin', groupIds: ['def'] })
    for (const act of ['deploy.view', 'deploy.edit', 'lock.break', 'admin', 'env.lock'] as HubAction[]) {
      expect(decide(a, [], act, { environmentId: E2 })).toEqual({ allowed: true, via: { role: 'admin', groupId: null, groupName: null } })
    }
  })

  it('lock.break, deploy.edit and admin are admin-only', () => {
    const u = user({ groupIds: ['def'] })
    for (const act of ['lock.break', 'deploy.edit', 'admin'] as HubAction[]) {
      expect(decide(u, ALL, act, { environmentId: E1 })).toMatchObject({ allowed: false, code: 'admin_only', reason: 'Only Hub admins can do this' })
    }
  })

  it('via is the narrowest grant', () => {
    const u = user({ groupIds: ['def', 'g-d1', 'g-e1'] })
    expect(decide(u, ALL, 'release.start', { environmentId: E1, deploymentIds: [D1] })).toMatchObject({
      allowed: true,
      via: { groupId: 'g-d1', groupName: 'D1 only' },
    })
    expect(decide(u, ALL, 'release.start', { environmentId: E1 })).toMatchObject({ via: { groupName: 'Payments-prod' } })
    expect(decide(u, ALL, 'release.start', { environmentId: E2 })).toMatchObject({ via: { groupName: 'Default' } })
  })

  it('ties go to the oldest group', () => {
    const a = group('ga', 'A', [{ kind: 'environment', environmentId: E1 }], '2026-05-01T00:00:00Z')
    const b = group('gb', 'B', [{ kind: 'environment', environmentId: E1 }], '2026-04-01T00:00:00Z')
    expect(decide(user({ groupIds: ['ga', 'gb'] }), [a, b], 'deploy.view', { environmentId: E1 })).toMatchObject({ via: { groupName: 'B' } })
  })

  it('a multi-deployment target needs every deployment covered', () => {
    const u = user({ groupIds: ['g-d1', 'g-d2'] })
    const ok = decide(u, ALL, 'release.start', { environmentId: E1, deploymentIds: [D1, D2] })
    expect(ok).toMatchObject({ allowed: true, via: { groupId: null, groupName: 'multiple' } })
    expect(ok.allowed && ok.vias?.map((v) => v.groupName)).toEqual(['D1 only', 'D2 only'])
    const no = decide(u, ALL, 'release.start', { environmentId: E1, deploymentIds: [D1, D3] })
    expect(no).toMatchObject({ allowed: false, code: 'no_grant' })
    expect(!no.allowed && no.reason).toContain(D3)
  })

  it('a non-admin with no target gets no_grant, whatever grants they hold', () => {
    const u = user({ groupIds: ['g-d1'] })
    for (const a of ['release.start', 'release.rollback', 'release.cancel', 'env.lock', 'deploy.view'] as const) {
      expect(decide(u, ALL, a)).toMatchObject({ allowed: false, code: 'no_grant' })
    }
    expect(decide(user({ role: 'admin', groupIds: ['def'] }), ALL, 'release.start').allowed).toBe(true)
  })

  it('duplicate deployment ids count once', () => {
    const d = decide(user({ groupIds: ['g-d1'] }), ALL, 'release.start', { environmentId: E1, deploymentIds: [D1, D1] })
    expect(d).toMatchObject({ allowed: true, via: { groupName: 'D1 only' } })
    expect(d.allowed && d.vias).toBeUndefined()
  })
})
