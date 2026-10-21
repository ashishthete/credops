import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { NotificationDispatcher } from '../../src/main/notify/dispatcher'
import { DatabaseSync } from 'node:sqlite'

// The Hub is a separate project; loaded by path so the desktop typecheck does not pull it in.
const hubModule = async (p: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../hub/src/${p}`, import.meta.url).pathname) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('hub notify isolation', () => {
  it('hub releases never reach the local dispatcher', async () => {
    const { createHubNotify } = await hubModule('notify/finalize')
    const { openHubDb } = await hubModule('db')
    const sink = { send: vi.fn(async () => undefined) }
    const local = new NotificationDispatcher({
      db: new DatabaseSync(':memory:'),
      sink: sink as never,
      integrations: { forEnvironment: () => ({ notifyEvents: ['release.succeeded'] }), environmentName: () => 'prod' } as never,
      settings: { get: () => ({}) } as never,
      vault: { isUnlocked: () => true },
      audit: { append: vi.fn() },
      runs: { runMeta: () => null as never },
      tunnels: { get: () => { throw new Error('none') } },
    })
    const spy = vi.spyOn(local, 'onRunEvent')
    const hubDb = openHubDb(':memory:')
    const hub = createHubNotify({
      db: hubDb,
      secrets: { integration: () => null },
      registry: { get: () => null, nameOf: () => 'prod' } as never,
      audit: { append: vi.fn() } as never,
      runMeta: () => null,
      fetch: vi.fn() as never,
      sleep: async () => undefined,
    })
    expect(hub.dispatcher).not.toBe(local)
    await hub.dispatcher.onRunEvent({ runId: randomUUID(), type: 'run.status', status: 'failed' } as never)
    expect(spy).not.toHaveBeenCalled()
    expect(sink.send).not.toHaveBeenCalled()
  })
})
