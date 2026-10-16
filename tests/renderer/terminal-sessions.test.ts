import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { SessionMeta, SessionPrompt } from '../../src/shared/ssh'
import { attachSession, disposeAll, disposeTerminal, getTerminal, writeData } from '../../src/renderer/src/terminal/registry'
import {
  closeSession,
  moveTab,
  nextTab,
  openLocal,
  promptStore,
  sessionStore,
  startSessionSync,
} from '../../src/renderer/src/terminal/sessions'
import { emitBridgeEvent, mockBridge } from './helpers'
import { fake, resetFakeXterm } from './terminal-fakes'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    kind: 'local',
    hostId: null,
    environmentId: null,
    label: id,
    color: null,
    state: 'ready',
    hops: [],
    error: null,
    openedAt: '2026-10-17T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    attempt: 1,
    ...over,
  }
}

const state = (m: SessionMeta) => act(() => emitBridgeEvent('session:state', m))

beforeEach(() => {
  disposeAll()
  resetFakeXterm()
  sessionStore.set({ sessions: [], activeId: null, order: [] })
  promptStore.set([])
})

describe('session store', () => {
  it('state events upsert sessions and keep order; close removes and picks the neighbour as active', async () => {
    const invoke = mockBridge({ 'session:list': [] })
    const stop = startSessionSync()
    await state(meta('a'))
    await state(meta('b'))
    await state(meta('c'))
    await state(meta('b', { state: 'closed' }))

    let s = sessionStore.get()
    expect(s.order).toEqual(['a', 'b', 'c'])
    expect(s.sessions.map((m) => m.state)).toEqual(['ready', 'closed', 'ready'])
    expect(s.activeId).toBe('a')

    act(() => nextTab(1))
    expect(sessionStore.get().activeId).toBe('b')
    await act(() => closeSession('b'))
    expect(invoke).toHaveBeenCalledWith('session:close', 'b')
    s = sessionStore.get()
    expect(s.order).toEqual(['a', 'c'])
    expect(s.activeId).toBe('c')

    await act(() => closeSession('c'))
    expect(sessionStore.get().activeId).toBe('a')

    await state(meta('d'))
    act(() => moveTab('d', 0))
    expect(sessionStore.get().order).toEqual(['d', 'a'])
    stop()
  })

  it('openLocal uses the default size and activates the new session', async () => {
    const invoke = mockBridge({ 'shell:open': meta('L') })
    await act(async () => {
      expect(await openLocal()).toBe('L')
    })
    expect(invoke).toHaveBeenCalledWith('shell:open', { cols: 80, rows: 24 })
    expect(sessionStore.get().activeId).toBe('L')
  })

  it('data goes to the registry, not the store', async () => {
    mockBridge({ 'session:attach': { meta: meta('a'), buffer: '', end: 0 } })
    getTerminal('a')
    const stop = startSessionSync()
    const listener = vi.fn()
    const off = sessionStore.subscribe(listener)
    await attachSession('a')
    act(() => emitBridgeEvent('session:data', { id: 'a', data: 'hello', end: 5 }))
    expect(listener).not.toHaveBeenCalled()
    expect(fake.terms[0].write).toHaveBeenCalledWith('hello')
    off()
    stop()
  })

  it('attach replays the buffer before queued live data', async () => {
    let release!: (v: unknown) => void
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'session:attach') return new Promise((r) => (release = r))
      return null
    })
    const stop = startSessionSync()
    getTerminal('a')
    const attached = attachSession('a')
    emitBridgeEvent('session:data', { id: 'a', data: 'live', end: 10 })
    expect(fake.terms[0].write).not.toHaveBeenCalled()
    release({ meta: meta('a'), buffer: 'buffer', end: 6 })
    await attached
    expect(fake.terms[0].write.mock.calls.map((c) => c[0])).toEqual(['buffer', 'live'])
    stop()
  })

  it('writes only the unseen suffix of events that overlap the attached buffer', async () => {
    mockBridge({ 'session:attach': { meta: meta('a'), buffer: 'abcdefghij', end: 10 } })
    getTerminal('a')
    await attachSession('a')
    const term = fake.terms[0]
    term.write.mockClear()
    writeData('a', 'fghij', 10) // fully inside the buffer
    writeData('a', 'ijKL', 12) // straddles: only KL is new
    writeData('a', 'MN', 14)
    expect(term.write.mock.calls.map((c) => c[0])).toEqual(['KL', 'MN'])
  })

  it('applies the offset to events queued during the attach too', async () => {
    let release!: (v: unknown) => void
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'session:attach' ? new Promise((r) => (release = r)) : null,
    )
    getTerminal('a')
    const attached = attachSession('a')
    writeData('a', 'efgh', 8) // in the buffer
    writeData('a', 'ghIJ', 10) // straddles
    release({ meta: meta('a'), buffer: 'abcdefgh', end: 8 })
    await attached
    expect(fake.terms[0].write.mock.calls.map((c) => c[0])).toEqual(['abcdefgh', 'IJ'])
  })

  it('a terminal disposed mid-attach is not written to and not recreated', async () => {
    let release!: (v: unknown) => void
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'session:attach' ? new Promise((r) => (release = r)) : null,
    )
    getTerminal('a')
    const attached = attachSession('a')
    writeData('a', 'live', 4)
    disposeTerminal('a')
    release({ meta: meta('a'), buffer: 'buf', end: 0 })
    await expect(attached).resolves.toBeUndefined()
    expect(fake.terms[0].write).not.toHaveBeenCalled()
    await attachSession('a') // removed session: no-op
    expect(fake.terms).toHaveLength(1)
  })

  it('bounds the in-flight queue at the scrollback size, oldest first', async () => {
    let release!: (v: unknown) => void
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'session:attach' ? new Promise((r) => (release = r)) : null,
    )
    getTerminal('a')
    const attached = attachSession('a')
    const big = 'x'.repeat(600_000)
    writeData('a', big, 600_000)
    writeData('a', big, 1_200_000)
    release({ meta: meta('a'), buffer: '', end: 0 })
    await attached
    expect(fake.terms[0].write).toHaveBeenCalledTimes(1)
  })

  it('creates terminals with the spec options', () => {
    getTerminal('x')
    expect(fake.terms[0].options).toMatchObject({
      scrollback: 10_000,
      fontFamily: 'JetBrains Mono Variable',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
    })
  })

  it('prompts queue FIFO and promptDone removes', () => {
    mockBridge({ 'session:list': [] })
    const stop = startSessionSync()
    const p = (promptId: string): SessionPrompt => ({ kind: 'password', promptId, sessionId: 'a', hopLabel: 'h', username: 'u' })
    act(() => {
      emitBridgeEvent('session:prompt', p('1'))
      emitBridgeEvent('session:prompt', p('2'))
    })
    expect(promptStore.get().map((x) => x.promptId)).toEqual(['1', '2'])
    act(() => emitBridgeEvent('session:promptDone', { promptId: '1' }))
    expect(promptStore.get().map((x) => x.promptId)).toEqual(['2'])
    stop()
  })
})
