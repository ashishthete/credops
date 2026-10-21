import { beforeEach, describe, expect, it } from 'vitest'
import { latestStore, loadLatest, resetLatest, startLatestSync } from '../../src/renderer/src/deploy/latest'
import type { EnvLastRelease, ReleaseStatus } from '../../src/shared/deploy'
import { emitBridgeEvent, mockBridge } from './helpers'

const STAMP = '2026-10-16T09:00:00.000Z'
const row = (id: string, status: ReleaseStatus, over: Partial<EnvLastRelease> = {}): EnvLastRelease => ({
  id,
  environmentId: 'e1',
  environmentName: 'staging',
  kind: 'release',
  status,
  version: null,
  previousVersion: null,
  redeploy: false,
  rollbackOf: null,
  triggeredBy: 'ana@mbp',
  createdAt: STAMP,
  startedAt: STAMP,
  finishedAt: status === 'running' ? null : STAMP,
  deploymentCount: 1,
  hostCount: 1,
  serviceIds: [],
  serviceCount: 1,
  error: null,
  operation: null,
  playbookSource: 'generated',
  previousCommit: 'aaaaaaa',
  deployedCommit: 'bbbbbbb',
  ...over,
})

/** Each `release:latest` call waits for its own resolve. */
function deferredBridge() {
  const pending: ((rows: EnvLastRelease[]) => void)[] = []
  const invoke = mockBridge()
  invoke.mockImplementation(async (channel: string) => (channel === 'release:latest' ? new Promise((r) => pending.push(r)) : null))
  return pending
}

describe('last release per environment', () => {
  beforeEach(() => resetLatest())

  it('a reply older than the newest one is dropped', async () => {
    const pending = deferredBridge()
    const first = loadLatest()
    const second = loadLatest()
    pending[1]([row('r2', 'succeeded')])
    await second
    pending[0]([row('r1', 'running')])
    await first
    expect(latestStore.get().e1).toMatchObject({ id: 'r2', status: 'succeeded' })
  })

  it('a read that started before the release finished does not put it back to running', async () => {
    const pending = deferredBridge()
    const stop = startLatestSync()
    emitBridgeEvent('release:state', row('r1', 'succeeded', { previousCommit: null, deployedCommit: null }))
    // The read began before the event; it still saw the release running.
    pending[0]([row('r1', 'running')])
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(latestStore.get().e1).toMatchObject({ id: 'r1', status: 'succeeded', deployedCommit: 'bbbbbbb' })
    stop()
  })
})
