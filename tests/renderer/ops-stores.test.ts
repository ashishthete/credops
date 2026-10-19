import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRun, resetOps, runOutputStore, runStore, selectRun, startOpsSync } from '../../src/renderer/src/ops/runs'
import { containerKey, containerStore, followStore, loadContainers } from '../../src/renderer/src/ops/containers'
import { loadSnippets, saveSnippet, snippetStore } from '../../src/renderer/src/ops/snippets'
import { placeholders } from '../../src/renderer/src/ops/template'
import { RUN_OUTPUT_CHARS, type RunEvent, type RunHostMeta, type RunSummary } from '../../src/shared/ops'
import { emitBridgeEvent, mockBridge } from './helpers'

vi.mock('../../src/renderer/src/ui/Toaster', () => ({ toast: vi.fn(() => 'toast-1') }))

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
  resetOps()
})

const flush = () => act(async () => {})
const STAMP = '2026-01-01T00:00:00.000Z'

const hostMeta = (over: Partial<RunHostMeta> = {}): RunHostMeta => ({
  hostId: 'h1',
  label: 'web-1',
  state: 'running',
  exitCode: null,
  signal: null,
  error: null,
  startedAt: STAMP,
  endedAt: null,
  truncated: false,
  ...over,
})
const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1',
  state: 'running',
  title: 'uptime',
  environmentId: null,
  environmentName: null,
  concurrency: 4,
  hosts: [hostMeta()],
  startedAt: STAMP,
  endedAt: null,
  outputDropped: false,
  ...over,
})
const send = (e: RunEvent) => act(() => emitBridgeEvent('run:event', e))
const out = (chunk: string, stream?: 'err'): RunEvent => ({ runId: 'r1', kind: 'output', hostId: 'h1', chunk, stream })

async function sync(results: Record<string, unknown> = {}) {
  const invoke = mockBridge(results)
  stop = startOpsSync()
  await flush()
  return invoke
}

describe('ops stores', () => {
  it('run events build per-host state and output in order', async () => {
    await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send({ runId: 'r1', kind: 'host', host: hostMeta({ state: 'ok', exitCode: 0 }) })
    await send(out('one\n'))
    await send(out('boom\n', 'err'))
    await send(out('two\n'))
    expect(runStore.get().runs[0].hosts[0].state).toBe('ok')
    const o = runOutputStore.get().r1.h1
    expect(o.text).toBe('one\nboom\ntwo\n')
    expect(o.errRanges).toEqual([[4, 9]])
  })

  it('output beyond the cap trims from the front and shifts stderr ranges', async () => {
    await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(out('x'.repeat(RUN_OUTPUT_CHARS - 10)))
    await send(out('E'.repeat(20), 'err'))
    const o = runOutputStore.get().r1.h1
    expect(o.text).toHaveLength(RUN_OUTPUT_CHARS)
    expect(o.text.endsWith('E'.repeat(20))).toBe(true)
    expect(o.errRanges).toEqual([[RUN_OUTPUT_CHARS - 20, RUN_OUTPUT_CHARS]])
    await send(out('y'.repeat(RUN_OUTPUT_CHARS)))
    expect(runOutputStore.get().r1.h1.errRanges).toEqual([])
  })

  it('a load discards events older than it', async () => {
    await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    let release!: (v: unknown) => void
    const gate = new Promise((r) => (release = r))
    const invoke = mockBridge({ 'runs:get': gate })
    stop?.()
    stop = startOpsSync()
    await flush()
    const loading = loadRun('r1')
    await send(out('old\n'))
    release({ run: summary(), output: [{ hostId: 'h1', text: 'snapshot\n', errRanges: [] }] })
    await act(async () => void (await loading))
    await send(out('new\n'))
    expect(runOutputStore.get().r1.h1.text).toBe('snapshot\nnew\n')
    expect(invoke).toHaveBeenCalledWith('runs:get', 'r1')
  })

  it('keeps output only for the selected and active runs', async () => {
    await sync({ 'runs:get': { run: summary({ state: 'done' }), output: [{ hostId: 'h1', text: 'back\n', errRanges: [] }] } })
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(out('live\n'))
    await send({ runId: 'r1', kind: 'run', run: summary({ state: 'done', endedAt: STAMP }) })
    expect(runOutputStore.get().r1).toBeUndefined()
    await act(async () => selectRun('r1'))
    await flush()
    expect(runOutputStore.get().r1.h1.text).toBe('back\n')
    await act(async () => selectRun(null))
    expect(runOutputStore.get().r1).toBeUndefined()
  })

  it('startOpsSync is idempotent and resetOps clears every store', async () => {
    const invoke = await sync({ 'runs:list': [summary({ state: 'done' })], 'snippets:list': [] })
    const stop2 = startOpsSync()
    await flush()
    expect(invoke.mock.calls.filter((c) => c[0] === 'runs:list')).toHaveLength(1)
    await send({ runId: 'r1', kind: 'run', run: summary({ id: 'r2', state: 'running' }) })
    // One event, one subscription: a duplicate would double the output.
    await send({ runId: 'r2', kind: 'output', hostId: 'h1', chunk: 'a' })
    expect(runOutputStore.get().r2.h1.text).toBe('a')
    stop2()
    followStore.set({ f1: 'text' })
    containerStore.set({ k: { list: null, loading: false, error: null, busy: {} } })
    snippetStore.set({ snippets: [], loaded: true })
    resetOps()
    expect(runStore.get()).toEqual({ runs: [], selectedId: null })
    expect(runOutputStore.get()).toEqual({})
    expect(followStore.get()).toEqual({})
    expect(containerStore.get()).toEqual({})
    expect(snippetStore.get()).toEqual({ snippets: [], loaded: false })
  })

  it('container logs events append to the follow text', async () => {
    await sync()
    act(() => emitBridgeEvent('containers:logs', { followId: 'f1', chunk: 'a' }))
    act(() => emitBridgeEvent('containers:logs', { followId: 'f1', chunk: 'b' }))
    expect(followStore.get().f1).toBe('ab')
  })

  it('loads containers per host and environment', async () => {
    const list = { containers: [], truncated: false, skipped: 0, fetchedAt: STAMP }
    const invoke = mockBridge({ 'containers:list': list })
    await loadContainers('h1', null)
    expect(invoke).toHaveBeenCalledWith('containers:list', 'h1', null)
    expect(containerStore.get()[containerKey('h1', null)]).toMatchObject({ list, loading: false, error: null })
  })

  it('saves a snippet into the list', async () => {
    const snip = { id: 's1', label: 'x', script: 'ls', description: '', tags: [], variables: [], destructive: false, createdAt: STAMP, updatedAt: STAMP }
    mockBridge({ 'snippets:list': [], 'snippets:create': snip })
    await loadSnippets()
    expect(snippetStore.get().loaded).toBe(true)
    await saveSnippet(null, { label: 'x', script: 'ls' })
    expect(snippetStore.get().snippets).toEqual([snip])
  })

  it('lists placeholders once, in order', () => {
    expect(placeholders('echo {{b}} {{a}} {{b}} {{ Bad }} {x}')).toEqual(['b', 'a'])
  })
})
