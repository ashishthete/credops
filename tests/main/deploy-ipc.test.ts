import { describe, expect, it, vi } from 'vitest'
import type { ReleaseService } from '../../src/main/deploy/release-service'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { MAX_EVENTS_PAGE } from '../../src/shared/deploy'

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const check = (channel: string, args: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](args)
const OPTS = { backup: true, notify: false, qa: false }

describe('release:* validators', () => {
  it('accept well-formed arguments', () => {
    expect(() => check('release:preflight', [{ environmentId: ID, deploymentIds: [ID], bump: 'minor', options: OPTS }])).not.toThrow()
    expect(() => check('release:start', [ID, { typedName: 'prod', redeploy: true }])).not.toThrow()
    expect(() => check('release:break-lock', [ID, ID, { typedLabel: 'app1' }])).not.toThrow()
    expect(() => check('release:list', [{ environmentId: ID, limit: 10 }])).not.toThrow()
    expect(() => check('release:events', [ID, 0, 5000])).not.toThrow()
    expect(() => check('release:active', [])).not.toThrow()
  })

  const bad: [string, unknown[], RegExp][] = [
    ['release:preflight', [{ environmentId: 'x', deploymentIds: [ID], bump: 'minor', options: OPTS }], /environmentId/],
    ['release:preflight', [{ environmentId: ID, deploymentIds: [], bump: 'minor', options: OPTS }], /deploymentIds/],
    ['release:preflight', [{ environmentId: ID, deploymentIds: ['nope'], bump: 'minor', options: OPTS }], /deploymentIds/],
    ['release:preflight', [{ environmentId: ID, deploymentIds: [ID], bump: 'huge', options: OPTS }], /bump/],
    ['release:preflight', [{ environmentId: ID, deploymentIds: [ID], bump: 'none', options: { backup: 1, notify: false, qa: false } }], /options/],
    ['release:preflight', [{ environmentId: ID, deploymentIds: [ID], bump: 'none', options: OPTS, releaseNotes: 5 }], /releaseNotes/],
    ['release:preflight', ['x'], /./],
    ['release:start', ['x', {}], /./],
    ['release:start', [ID, { typedName: 5 }], /typedName/],
    ['release:start', [ID, { redeploy: 'yes' }], /redeploy/],
    ['release:cancel', [], /./],
    ['release:rollback', [ID, { typedName: {} }], /typedName/],
    ['release:break-lock', [ID, ID, {}], /typedLabel/],
    ['release:break-lock', [ID, 'x', { typedLabel: 'a' }], /./],
    ['release:discard', [5], /./],
    ['release:retry-version', ['x'], /./],
    ['release:list', [{ limit: 0 }], /limit/],
    ['release:list', [{ before: 'x' }], /before/],
    ['release:get', ['x'], /./],
    ['release:events', [ID, -1], /./],
    ['release:events', [ID, 0, 5001], /./],
    ['release:events', [ID, 0, 0], /./],
  ]
  it.each(bad)('%s rejects bad shapes and names the path', (channel, args, path) => {
    expect(() => check(channel, args)).toThrow(path)
  })
})

describe('release handlers', () => {
  it('release:events caps limit at 5000 and defaults to 1000', () => {
    const events = vi.fn(() => [])
    const handlers = createDeployHandlers({ deploys: {} as never, releases: { events } as unknown as ReleaseService, tooling: async () => ({}) as never })
    const h = (handlers as Record<string, unknown>)['release:events'] as (id: string, after: number, limit?: number) => unknown
    h(ID, 3, 5000)
    h(ID, 3, 999999)
    h(ID, 3)
    expect(events.mock.calls).toEqual([
      [ID, 3, MAX_EVENTS_PAGE],
      [ID, 3, MAX_EVENTS_PAGE],
      [ID, 3, 1000],
    ])
    expect(MAX_EVENTS_PAGE).toBe(5000)
  })
})
