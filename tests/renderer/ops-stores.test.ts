import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addRunIfAbsent,
  loadRun,
  rememberRequest,
  requestFor,
  resetOps,
  runOutputStore,
  runStore,
  selectRun,
  startOpsSync,
} from '../../src/renderer/src/ops/runs'
import { containerKey, containerStore, followStore, loadContainers } from '../../src/renderer/src/ops/containers'
import { loadSnippets, saveSnippet, snippetStore } from '../../src/renderer/src/ops/snippets'
import { placeholders } from '../../src/renderer/src/ops/template'
import { MAX_RUNS_KEPT, RUN_OUTPUT_CHARS, type RunEvent, type RunHostMeta, type RunRequest, type RunSummary } from '../../src/shared/ops'
import { emitBridgeEvent, mockBridge } from './helpers'

vi.mock('../../src/renderer/src/ui/Toaster', () => ({ toast: vi.fn(() => 'toast-1') }))

let stop: (() => void) | null = null
afterEach(() => {
  sent = 0
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
// Chunks are numbered the way main numbers them: `end` is the host's total after the chunk.
let sent = 0
const out = (chunk: string, stream?: 'err'): RunEvent => ({ runId: 'r1', kind: 'output', hostId: 'h1', chunk, stream, end: (sent += chunk.length) })
const at = (chunk: string, end: number): RunEvent => ({ runId: 'r1', kind: 'output', hostId: 'h1', chunk, end })

type Invoke = Awaited<ReturnType<typeof sync>>

/** Changes one channel's reply without reinstalling the bridge (that would drop the event subscriptions). */
function override(invoke: Invoke, channel: string, impl: (...args: unknown[]) => unknown) {
  const prev = invoke.getMockImplementation()!
  invoke.mockImplementation(async (c: string, ...args: unknown[]) => (c === channel ? impl(...args) : (prev as (...a: unknown[]) => unknown)(c, ...args)))
}

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

  it('a chunk both in the snapshot and delivered after the reply is applied once', async () => {
    const invoke = await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(out('abc'))
    let release!: (v: unknown) => void
    override(invoke, 'runs:get', () => new Promise((r) => (release = r)))
    const loading = loadRun('r1')
    release({ run: summary(), output: [{ hostId: 'h1', text: 'abcdef', errRanges: [], total: 6 }] })
    await act(async () => void (await loading))
    await send(at('def', 6)) // in the snapshot already
    await send(at('gh', 8))
    expect(runOutputStore.get().r1.h1).toMatchObject({ text: 'abcdefgh', total: 8 })
  })

  it('applies only the part of a chunk the snapshot lacks, keeping stderr ranges right', async () => {
    const invoke = await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    override(invoke, 'runs:get', () => ({ run: summary(), output: [{ hostId: 'h1', text: 'abcd', errRanges: [], total: 4 }] }))
    await act(async () => loadRun('r1'))
    await send({ runId: 'r1', kind: 'output', hostId: 'h1', chunk: 'cdEE', stream: 'err', end: 6 })
    const o = runOutputStore.get().r1.h1
    expect(o.text).toBe('abcdEE')
    expect(o.errRanges).toEqual([[4, 6]])
  })

  it('a gap in the offsets reloads the run once', async () => {
    const invoke = await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(at('ab', 2))
    override(invoke, 'runs:get', () => ({ run: summary(), output: [{ hostId: 'h1', text: 'abcdef', errRanges: [], total: 6 }] }))
    await send(at('ef', 6)) // chars 3-4 were missed
    await flush()
    await send(at('gh', 8))
    expect(invoke.mock.calls.filter((c) => c[0] === 'runs:get')).toHaveLength(1)
    expect(runOutputStore.get().r1.h1.text).toBe('abcdefgh')
  })

  it('a gap during a load is not applied and ends with the correct text', async () => {
    const invoke = await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(at('ab', 2))
    const replies: ((v: unknown) => void)[] = []
    override(invoke, 'runs:get', () => new Promise((r) => replies.push(r)))
    const loading = loadRun('r1')
    await send(at('ef', 6)) // chars 3-4 are in neither the snapshot nor an event yet
    expect(runOutputStore.get().r1.h1.text).toBe('ab')
    replies[0]({ run: summary(), output: [{ hostId: 'h1', text: 'ab', errRanges: [], total: 2 }] })
    await act(async () => void (await loading))
    expect(replies).toHaveLength(2)
    replies[1]({ run: summary(), output: [{ hostId: 'h1', text: 'abcdef', errRanges: [], total: 6 }] })
    await flush()
    expect(runOutputStore.get().r1.h1).toMatchObject({ text: 'abcdef', total: 6 })
  })

  it('a failed load leaves the events applied', async () => {
    const invoke = await sync()
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(out('one '))
    override(invoke, 'runs:get', () => {
      throw new Error('boom')
    })
    await act(async () => loadRun('r1'))
    await send(out('two'))
    expect(runOutputStore.get().r1.h1.text).toBe('one two')
  })

  it('a reply after resetOps does not repopulate the stores', async () => {
    const invoke = await sync()
    let releaseRun!: (v: unknown) => void
    let releaseList!: (v: unknown) => void
    override(invoke, 'runs:get', () => new Promise((r) => (releaseRun = r)))
    override(invoke, 'containers:list', () => new Promise((r) => (releaseList = r)))
    const loading = loadRun('r1')
    const containers = loadContainers('h1', null)
    resetOps()
    releaseRun({ run: summary(), output: [] })
    releaseList({ containers: [], truncated: false, skipped: 0, fetchedAt: 'x' })
    await act(async () => void (await Promise.all([loading, containers])))
    expect(runStore.get().runs).toEqual([])
    expect(containerStore.get()).toEqual({})
  })

  it('the reply of a superseded load is ignored', async () => {
    const invoke = await sync()
    const replies: ((v: unknown) => void)[] = []
    override(invoke, 'runs:get', () => new Promise((r) => replies.push(r)))
    const first = loadRun('r1')
    const second = loadRun('r1')
    replies[0]({ run: summary({ title: 'old' }), output: [] })
    await act(async () => void (await first))
    expect(runStore.get().runs).toEqual([])
    replies[1]({ run: summary({ title: 'new' }), output: [] })
    await act(async () => void (await second))
    expect(runStore.get().runs[0].title).toBe('new')
  })

  it('the last latest container load wins', async () => {
    const invoke = await sync()
    const replies: ((v: unknown) => void)[] = []
    override(invoke, 'containers:list', () => new Promise((r) => replies.push(r)))
    const a = loadContainers('h1', null)
    const b = loadContainers('h1', null)
    const list = (fetchedAt: string) => ({ containers: [], truncated: false, skipped: 0, fetchedAt })
    replies[1](list('new'))
    replies[0](list('old'))
    await act(async () => void (await Promise.all([a, b])))
    expect(containerStore.get()[containerKey('h1', null)].list?.fetchedAt).toBe('new')
  })

  it('a run list reply keeps entries that events already updated', async () => {
    mockBridge({ 'runs:list': [summary({ title: 'stale' })] })
    stop = startOpsSync()
    await send({ runId: 'r1', kind: 'run', run: summary({ title: 'fresh' }) })
    await flush()
    expect(runStore.get().runs.map((r) => r.title)).toEqual(['fresh'])
  })

  it('keeps running runs and the newest finished ones, as main does, and forgets the requests of the rest', async () => {
    const minute = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
    const finished = (i: number) => summary({ id: `f${i}`, state: 'done', startedAt: minute(i), endedAt: minute(i) })
    // Main lists newest first; an older run is still going.
    const old = summary({ id: 'old', startedAt: '2025-12-31T00:00:00.000Z' })
    const list = [...Array.from({ length: MAX_RUNS_KEPT + 2 }, (_, i) => finished(MAX_RUNS_KEPT + 1 - i)), old]
    const req: RunRequest = { target: { kind: 'hosts', hostIds: ['h1'] }, command: { kind: 'text', text: 'uptime' }, concurrency: 1, timeoutSec: 60 }
    for (const r of list) rememberRequest(r.id, req)
    await sync({ 'runs:list': list, 'runs:get': { run: old, output: [] } })
    const ids = () => runStore.get().runs.map((r) => r.id)
    expect(ids()).toHaveLength(MAX_RUNS_KEPT + 1)
    expect(ids()).toContain('old')
    expect(ids()).not.toContain('f0')
    expect(ids()).not.toContain('f1')
    expect(requestFor('f0')).toBeUndefined()
    expect(requestFor('f1')).toBeUndefined()
    expect(requestFor('f2')).toBe(req)
    expect(requestFor('old')).toBe(req)

    // A new run finishing pushes the oldest finished one out, with its request and output.
    const next = summary({ id: 'f99', startedAt: minute(99) })
    rememberRequest('f99', req)
    await send({ runId: 'f99', kind: 'run', run: next })
    expect(ids()).toContain('f2')
    await act(async () => selectRun('f2'))
    await flush()
    await act(async () => selectRun(null))
    await send({ runId: 'f99', kind: 'run', run: { ...next, state: 'done', endedAt: minute(99) } })
    expect(ids()).not.toContain('f2')
    expect(ids()).toHaveLength(MAX_RUNS_KEPT + 1)
    expect(requestFor('f2')).toBeUndefined()
    expect(requestFor('f99')).toBe(req)
  })

  it('the run being looked at stays even when main would have dropped it', async () => {
    const minute = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
    const finished = (i: number) => summary({ id: `f${i}`, state: 'done', startedAt: minute(i), endedAt: minute(i) })
    await sync({ 'runs:list': Array.from({ length: MAX_RUNS_KEPT }, (_, i) => finished(MAX_RUNS_KEPT - i)), 'runs:get': { run: finished(1), output: [] } })
    await act(async () => selectRun('f1'))
    await flush()
    await send({ runId: 'f50', kind: 'run', run: finished(50) })
    await send({ runId: 'f51', kind: 'run', run: finished(51) })
    expect(runStore.get().runs.map((r) => r.id)).toContain('f1')
    expect(runStore.get().runs.map((r) => r.id)).not.toContain('f2')
  })

  it('a start reply adds the run only if events have not already brought it', async () => {
    await sync()
    await send({ runId: 'r1', kind: 'run', run: summary({ hosts: [hostMeta({ state: 'connecting' })] }) })
    act(() => addRunIfAbsent(summary({ hosts: [hostMeta({ state: 'queued' })] })))
    expect(runStore.get().runs[0].hosts[0].state).toBe('connecting')
    act(() => addRunIfAbsent(summary({ id: 'r2' })))
    expect(runStore.get().runs.map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('keeps output only for the selected and active runs', async () => {
    await sync({ 'runs:get': { run: summary({ state: 'done' }), output: [{ hostId: 'h1', text: 'back\n', errRanges: [], total: 5 }] } })
    await send({ runId: 'r1', kind: 'run', run: summary() })
    await send(out('live\n'))
    await send({ runId: 'r1', kind: 'run', run: summary({ state: 'done', endedAt: STAMP }) })
    expect(runOutputStore.get().r1).toBeUndefined()
    await send(at('late', 100)) // a finished, unselected run keeps nothing
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
    await send({ runId: 'r2', kind: 'output', hostId: 'h1', chunk: 'a', end: 1 })
    expect(runOutputStore.get().r2.h1.text).toBe('a')
    stop2()
    stop?.()
    stop = null
    await send({ runId: 'r2', kind: 'output', hostId: 'h1', chunk: 'b', end: 2 })
    expect(runOutputStore.get().r2.h1.text).toBe('a') // the last user left: no subscription
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

  it('keeps the text of at most six ended follows', async () => {
    await sync()
    for (let i = 0; i < 8; i++) {
      act(() => emitBridgeEvent('containers:logs', { followId: `f${i}`, chunk: 'x' }))
      act(() => emitBridgeEvent('containers:logs', { followId: `f${i}`, ended: true, error: null }))
    }
    expect(Object.keys(followStore.get())).toEqual(['f2', 'f3', 'f4', 'f5', 'f6', 'f7'])
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

  it('keeps saved snippets in label order, case-insensitive, then id', async () => {
    const snip = (id: string, label: string) => ({ id, label, script: 'ls', description: '', tags: [], variables: [], destructive: false, createdAt: STAMP, updatedAt: STAMP })
    const invoke = mockBridge({ 'snippets:list': [snip('1', 'alpha'), snip('2', 'Charlie')] })
    await loadSnippets()
    invoke.mockImplementation(async (c: string) => (c === 'snippets:create' ? snip('3', 'bravo') : c === 'snippets:update' ? snip('1', 'Zulu') : null))
    await saveSnippet(null, { label: 'bravo', script: 'ls' })
    expect(snippetStore.get().snippets.map((s) => s.label)).toEqual(['alpha', 'bravo', 'Charlie'])
    await saveSnippet('1', { label: 'Zulu', script: 'ls' })
    expect(snippetStore.get().snippets.map((s) => s.label)).toEqual(['bravo', 'Charlie', 'Zulu'])
  })

  it('lists placeholders once, in order', () => {
    expect(placeholders('echo {{b}} {{a}} {{b}} {{ Bad }} {x}')).toEqual(['b', 'a'])
  })
})
