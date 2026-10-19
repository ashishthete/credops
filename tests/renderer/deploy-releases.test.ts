import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { closeRelease, onLogEvents, openRelease, releaseStore, resetReleases, startReleaseSync } from '../../src/renderer/src/deploy/releases'
import { initialPipeline, reducePipeline } from '../../src/renderer/src/deploy/pipeline'
import type { ReleaseSummary, RunEvent } from '../../src/shared/deploy'
import { events, healthFailure, OK_RUN, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

const summary = (over: Partial<ReleaseSummary> = {}): ReleaseSummary => {
  const { options: _o, releaseNotes: _n, playbook: _p, runs: _r, preflight: _f, lastSeq: _l, ...rest } = releaseDetail()
  return { ...rest, ...over }
}

/** `release:events` pages the given events by afterSeq and limit, as main does. */
function world(all: RunEvent[], extra: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'release:get': releaseDetail(), 'release:active': [], ...extra })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return all.filter((e) => e.seq > after).slice(0, limit)
    }
    return base(channel)
  })
  return invoke
}

afterEach(() => resetReleases())

describe('release store', () => {
  it('open rehydrates from get plus paged events', async () => {
    // More events than one page holds.
    const filler = Array.from({ length: 5100 }, (_, i) => ({ type: 'log' as const, stepId: null, hostId: 'h1', stream: 'out' as const, line: `line ${i}` }))
    const all = events([...OK_RUN.slice(0, 5), ...filler, ...OK_RUN.slice(5)])
    const invoke = world(all)
    const logs: string[] = []
    onLogEvents(REL, (batch) => logs.push(...batch.map((e) => (e.type === 'log' ? e.line : ''))))
    await act(() => openRelease(REL))
    const pages = calls(invoke, 'release:events').map((c) => c.slice(1))
    expect(pages).toEqual([
      [REL, 0, 5000],
      [REL, 5000, 5000],
    ])
    const expected = reducePipeline(initialPipeline(releaseDetail()), all)
    expect(releaseStore.get().pipelines[REL]).toEqual(expected)
    expect(expected.result).toEqual({ status: 'succeeded' })
    expect(logs).toHaveLength(5101)

    // Live batches append after the rehydrated ones.
    closeRelease(REL)
    expect(releaseStore.get().pipelines[REL]).toBeUndefined()
  })

  it('live batch appends', async () => {
    const all = events(OK_RUN)
    world(all.slice(0, 4))
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    expect(releaseStore.get().pipelines[REL].lastSeq).toBe(4)
    act(() => emitBridgeEvent('deploy:event', all.slice(4)))
    expect(releaseStore.get().pipelines[REL]).toEqual(reducePipeline(initialPipeline(releaseDetail()), all))
    stop()
  })

  it('seq gap triggers refetch from lastSeq', async () => {
    const all = events(healthFailure(true))
    const invoke = world(all.slice(0, 6))
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    // Main has persisted everything by now; the renderer only saw a later batch.
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:events') return all.filter((e) => e.seq > (args[1] as number)).slice(0, args[2] as number)
      return null
    })
    act(() => emitBridgeEvent('deploy:event', all.slice(10, 12)))
    await flush()
    expect(calls(invoke, 'release:events').at(-1)!.slice(1)).toEqual([REL, 6, 5000])
    expect(releaseStore.get().pipelines[REL]).toEqual(reducePipeline(initialPipeline(releaseDetail()), all))
    expect(releaseStore.get().pipelines[REL].gap).toBe(false)
    stop()
  })

  it('release:state updates the active list', async () => {
    world([], { 'release:active': [summary({ id: 'old', status: 'running' })] })
    const stop = startReleaseSync()
    await flush()
    expect(releaseStore.get().active).toEqual(['old'])
    act(() => emitBridgeEvent('release:state', summary({ status: 'running' })))
    expect(releaseStore.get().active).toEqual(['old', REL])
    expect(releaseStore.get().byId[REL].status).toBe('running')
    act(() => emitBridgeEvent('release:state', summary({ status: 'succeeded' })))
    expect(releaseStore.get().active).toEqual(['old'])
    expect(releaseStore.get().byId[REL].status).toBe('succeeded')
    stop()
  })

  it('preflight checks and the report are kept per release', async () => {
    const report = { releaseId: REL, checks: [], commits: {}, dockerModes: {}, composeServices: { 'dep-r1': ['api', 'worker', 'redis'] }, serviceCommits: {}, locks: {}, commitsTotal: 0, blocked: false }
    const check = { id: 'deps', deploymentId: 'dep-r1', hostId: 'h1', label: 'deps', level: 'warn' as const, message: 'redis is not running' }
    const all = events([{ type: 'preflight.check', check }, { type: 'preflight.done', report }])
    world(all.slice(0, 1))
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    expect(releaseStore.get().preflight[REL]).toEqual({ checks: [check], report: null })
    act(() => emitBridgeEvent('deploy:event', all.slice(1)))
    expect(releaseStore.get().preflight[REL]).toEqual({ checks: [check], report })
    expect(releaseStore.get().pipelines[REL].status).toBe('ready')
    stop()
  })

  it('stale generation ignores late results', async () => {
    const invoke = world(events(OK_RUN))
    let release: (v: unknown) => void = () => {}
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:get') return new Promise((r) => (release = r))
      return base(channel, ...args)
    })
    let opening!: Promise<void>
    act(() => {
      opening = openRelease(REL)
    })
    resetReleases()
    await act(async () => {
      release(releaseDetail())
      await opening
    })
    expect(releaseStore.get().pipelines[REL]).toBeUndefined()
    expect(calls(invoke, 'release:events')).toHaveLength(0)
  })

  it('a reopen during catch-up lets later gaps catch up again', async () => {
    const all = events(healthFailure(true))
    let persisted = all.slice(0, 6)
    const invoke = world([])
    let hold: ((v: unknown) => void) | null = null
    let holding = false
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:get') return releaseDetail()
      if (channel !== 'release:events') return null
      if (holding) {
        holding = false
        return new Promise((r) => (hold = r))
      }
      return persisted.filter((e) => e.seq > (args[1] as number)).slice(0, args[2] as number)
    })
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    // A gap starts a catch-up that main is slow to answer.
    holding = true
    act(() => emitBridgeEvent('deploy:event', all.slice(7, 8)))
    await flush()
    expect(hold).not.toBeNull()
    // The view opens the release again meanwhile, and main has more by then.
    persisted = all.slice(0, 9)
    await act(() => openRelease(REL))
    const before = calls(invoke, 'release:events').length
    act(() => emitBridgeEvent('deploy:event', all.slice(10, 11)))
    await flush()
    expect(calls(invoke, 'release:events').length).toBe(before + 1)
    expect(calls(invoke, 'release:events').at(-1)!.slice(1)).toEqual([REL, 9, 5000])
    // The old catch-up answers late and changes nothing.
    await act(async () => hold!(all))
    expect(releaseStore.get().pipelines[REL].lastSeq).toBe(9)
    stop()
  })

  it('a closed release stops tracking live seqs', async () => {
    const all = events(OK_RUN)
    const invoke = world(all.slice(0, 4))
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    closeRelease(REL)
    // Events for the closed release keep arriving.
    act(() => emitBridgeEvent('deploy:event', all.slice(8, 10)))
    const before = calls(invoke, 'release:events').length
    await act(() => openRelease(REL))
    await flush()
    // One page from the start, and no catch-up for seqs seen while it was closed.
    expect(calls(invoke, 'release:events').slice(before).map((c) => c.slice(1))).toEqual([[REL, 0, 5000]])
    stop()
  })

  it('a batch repeating a seq applies it once', async () => {
    const all = events([
      { type: 'log', stepId: null, hostId: 'h1', stream: 'out', line: 'one' },
      { type: 'log', stepId: null, hostId: 'h1', stream: 'out', line: 'two' },
    ])
    world([])
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    const logs: string[] = []
    onLogEvents(REL, (batch) => logs.push(...batch.map((e) => (e.type === 'log' ? e.line : ''))))
    act(() => emitBridgeEvent('deploy:event', [all[0], all[0], all[1]]))
    expect(logs).toEqual(['one', 'two'])
    stop()
  })
})
