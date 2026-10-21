import { describe, expect, it, vi } from 'vitest'
import type { ReleaseService } from '../../src/main/deploy/release-service'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { PLAYBOOK_CHANGED_MESSAGE } from '../../src/main/deploy/release-service'
import { REVIEW_REQUIRED_MESSAGE } from '../../src/main/ipc/handlers/deploy'
import { MAX_EVENTS_PAGE } from '../../src/shared/deploy'
import { MAX_SERVICES } from '../../src/shared/services'

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const check = (channel: string, args: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](args)
const OPTS = { backup: true, notify: false, qa: false }
const HASH = 'a'.repeat(64)

describe('release:* validators', () => {
  it('accept well-formed arguments', () => {
    expect(() => check('release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'minor', options: OPTS }])).not.toThrow()
    expect(() => check('release:preflight', [{ environmentId: ID, serviceIds: [], checkoutIds: [ID], bump: 'minor', options: OPTS }])).not.toThrow()
    expect(() => check('release:start', [ID, { typedName: 'prod', redeploy: true }])).not.toThrow()
    expect(() => check('release:start', [ID, { playbookSha256: HASH }])).not.toThrow()
    expect(() => check('deploy:previewPlaybook', [ID])).not.toThrow()
    expect(() => check('deploy:savePlaybook', [ID, HASH])).not.toThrow()
    expect(() => check('release:break-lock', [ID, ID, { typedLabel: 'app1' }])).not.toThrow()
    expect(() => check('release:list', [{ environmentId: ID, limit: 10 }])).not.toThrow()
    expect(() => check('release:events', [ID, 0, 5000])).not.toThrow()
    expect(() => check('release:active', [])).not.toThrow()
    expect(() => check('release:latest', [])).not.toThrow()
  })

  const bad: [string, unknown[], RegExp][] = [
    ['release:preflight', [{ environmentId: 'x', serviceIds: [ID], bump: 'minor', options: OPTS }], /environmentId/],
    ['release:preflight', [{ environmentId: ID, bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: ['nope'], bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [], checkoutIds: ['nope'], bump: 'minor', options: OPTS }], /checkoutIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: Array(MAX_SERVICES + 1).fill(ID), bump: 'minor', options: OPTS }], /serviceIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], deploymentIds: [ID], bump: 'minor', options: OPTS }], /deploymentIds/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'huge', options: OPTS }], /bump/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'none', options: { backup: 1, notify: false, qa: false } }], /options/],
    ['release:preflight', [{ environmentId: ID, serviceIds: [ID], bump: 'none', options: OPTS, releaseNotes: 5 }], /releaseNotes/],
    ['release:preflight', ['x'], /./],
    ['release:start', ['x', {}], /./],
    ['release:start', [ID, { typedName: 5 }], /typedName/],
    ['release:start', [ID, { redeploy: 'yes' }], /redeploy/],
    ['release:start', [ID, { playbookSha256: 'A'.repeat(64) }], /playbookSha256/],
    ['release:start', [ID, { playbookSha256: 'a'.repeat(63) }], /playbookSha256/],
    ['deploy:previewPlaybook', ['x'], /./],
    ['deploy:savePlaybook', [ID, 'nope'], /./],
    ['deploy:savePlaybook', [ID], /./],
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

  it('release:latest answers from the local releases, and with none when nothing provides them', async () => {
    const row = { id: ID, environmentId: ID, previousCommit: 'a', deployedCommit: 'b' }
    const base = { deploys: {} as never, releases: {} as unknown as ReleaseService, tooling: async () => ({}) as never }
    const h = (x: ReturnType<typeof createDeployHandlers>) => (x as Record<string, unknown>)['release:latest'] as () => unknown
    expect(await h(createDeployHandlers({ ...base, lastReleases: () => [row as never] }))()).toEqual([row])
    expect(await h(createDeployHandlers(base))()).toEqual([])
  })
})

describe('playbook review handlers', () => {
  const PLAYBOOK = '[{"hosts":"od-1"}]'
  const setup = (over: { path?: string } = {}) => {
    const releases = {
      previewPlaybook: vi.fn(async () => ({ playbook: PLAYBOOK, sha256: HASH })),
      start: vi.fn(async () => undefined),
    }
    const writes: [string, string][] = []
    const saveDialog = vi.fn(async () => over.path)
    const handlers = createDeployHandlers({
      deploys: {} as never,
      releases: releases as unknown as ReleaseService,
      tooling: async () => ({}) as never,
      playbookFile: { saveDialog, write: async (path, text) => void writes.push([path, text]) },
    })
    return { releases, writes, saveDialog, h: handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> }
  }

  it('release:start refuses a start without a reviewed hash and forwards one with it', async () => {
    const { releases, h } = setup()
    await expect(h['release:start'](ID, {})).rejects.toThrow(REVIEW_REQUIRED_MESSAGE)
    await expect(h['release:start'](ID, { typedName: 'prod' })).rejects.toThrow(REVIEW_REQUIRED_MESSAGE)
    expect(releases.start).not.toHaveBeenCalled()
    await h['release:start'](ID, { playbookSha256: HASH, redeploy: true })
    expect(releases.start).toHaveBeenCalledWith(ID, { playbookSha256: HASH, redeploy: true })
  })

  it('a start refused for another reason keeps the review, so it can still be saved', async () => {
    const { releases, h, writes } = setup({ path: '/tmp/x/review.yml' })
    releases.start.mockRejectedValueOnce(new Error('This release is busy'))
    await h['deploy:previewPlaybook'](ID)
    await expect(h['release:start'](ID, { playbookSha256: HASH })).rejects.toThrow('busy')
    expect(await h['deploy:savePlaybook'](ID, HASH)).toEqual({ path: '/tmp/x/review.yml' })
    expect(writes).toEqual([['/tmp/x/review.yml', PLAYBOOK]])
    await h['release:start'](ID, { playbookSha256: HASH })
    await expect(h['deploy:savePlaybook'](ID, HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
  })

  it('deploy:previewPlaybook returns the preview; deploy:savePlaybook writes only that text where the dialog says', async () => {
    const { h, writes, saveDialog } = setup({ path: '/tmp/x/review.yml' })
    expect(await h['deploy:previewPlaybook'](ID)).toEqual({ playbook: PLAYBOOK, sha256: HASH })
    expect(await h['deploy:savePlaybook'](ID, HASH)).toEqual({ path: '/tmp/x/review.yml' })
    expect(saveDialog).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([['/tmp/x/review.yml', PLAYBOOK]])
  })

  it('deploy:savePlaybook refuses a playbook that was not the last one reviewed, and a cancelled dialog writes nothing', async () => {
    const { h, writes, saveDialog } = setup()
    await expect(h['deploy:savePlaybook'](ID, HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    await h['deploy:previewPlaybook'](ID)
    await expect(h['deploy:savePlaybook'](ID, 'b'.repeat(64))).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    await expect(h['deploy:savePlaybook']('0190a1b2-c3d4-7e5f-8a6b-1234567890ac', HASH)).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    expect(saveDialog).not.toHaveBeenCalled()
    expect(await h['deploy:savePlaybook'](ID, HASH)).toBeNull()
    expect(writes).toEqual([])
  })
})
