import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReleaseNotesEditor, type NotesContext } from '../../src/renderer/src/ai/ReleaseNotesEditor'
import '../../src/renderer/src/ai/register'
import { flushReleaseNotes, ReleaseNotesSlot, releaseOptionDefaults, releaseOptionsAvailable } from '../../src/renderer/src/deploy/slots'
import { toast } from '../../src/renderer/src/ui/Toaster'
import type { ReleaseNotesResult } from '../../src/shared/ai'
import type { CommitInfo, ReleaseDetail } from '../../src/shared/deploy'
import { fallbackNotes } from '../../src/shared/notes-fallback'
import { emitBridgeEvent, mockBridge } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))
vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const ENV = '33333333-3333-4333-8333-333333333333'
const DEP = '11111111-1111-4111-8111-111111111111'
const REL = '44444444-4444-4444-8444-444444444444'
const ctx: NotesContext = { environmentId: ENV, productName: 'Shop', deployments: [{ id: DEP, name: 'api' }], version: 'v1.5.0' }
const commit = (subject: string, i: number): CommitInfo => ({ sha: `${i}`.padEnd(40, 'a'), subject, author: 'A <a@x.io>', date: '2026-10-18T10:00:00Z', deploymentId: DEP })
const COMMITS = [commit('feat: refunds', 1), commit('fix: totals off by a cent', 2)]
const READY = { configured: true, model: 'claude-opus-5-5' }

function deferred<T>() {
  let resolve!: (v: T) => void
  const p = new Promise<T>((r) => (resolve = r))
  return { p, resolve }
}
const frame = () => act(() => new Promise((r) => setTimeout(r, 30)))
const result = (over: Partial<ReleaseNotesResult> = {}): ReleaseNotesResult => ({ requestId: 'x', text: '', model: 'claude-opus-5-5', source: 'claude', truncated: false, redactions: {}, ...over })

function Harness({ commits = COMMITS, initial = '' }: { commits?: CommitInfo[]; initial?: string }) {
  const [value, setValue] = useState(initial)
  return <ReleaseNotesEditor commits={commits} value={value} onChange={setValue} context={ctx} />
}
const box = () => screen.getByRole('textbox', { name: 'Release notes' }) as HTMLTextAreaElement

/** Mounts the editor with a pending ai:releaseNotes; returns the invoke mock, the request id and its resolver. */
async function generating(over: { status?: unknown; initial?: string } = {}) {
  const pending = deferred<ReleaseNotesResult>()
  const invoke = mockBridge({ 'ai:status': over.status ?? READY, 'ai:releaseNotes': pending.p, 'ai:cancel': undefined })
  render(<Harness initial={over.initial} />)
  fireEvent.click(await screen.findByRole('button', { name: /Generate with Claude/ }))
  const call = invoke.mock.calls.find((c) => c[0] === 'ai:releaseNotes')! as unknown as [string, string, unknown]
  return { invoke, requestId: call[1], req: call[2], resolve: (r: ReleaseNotesResult) => act(async () => pending.resolve(r)) }
}

beforeEach(() => {
  motion.safe = true
  vi.mocked(toast).mockClear()
})
afterEach(() => vi.useRealTimers())

describe('ReleaseNotesEditor', () => {
  it('generate streams deltas into the textarea', async () => {
    const { requestId, req, resolve } = await generating()
    expect(req).toEqual({ environmentId: ENV, productName: 'Shop', deployments: ctx.deployments, version: 'v1.5.0', commits: COMMITS })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    act(() => {
      emitBridgeEvent('ai:delta', { requestId, text: '## Fea' })
      emitBridgeEvent('ai:delta', { requestId: 'someone-else', text: 'NOPE' })
      emitBridgeEvent('ai:delta', { requestId, text: 'tures\n- Refunds' })
    })
    await frame()
    expect(box().value).toBe('## Features\n- Refunds')
    await resolve(result({ requestId, text: '## Features\n- Refunds', redactions: { secret: 1, host: 2 } }))
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '3 values redacted' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '3 values redacted' }))
    expect(screen.getByText('2 hosts')).toBeInTheDocument()
    expect(screen.getByText('1 secret')).toBeInTheDocument()
  })

  it('stop keeps partial text and calls ai:cancel', async () => {
    const { invoke, requestId, resolve } = await generating()
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '## Features\n- Ref' }))
    await frame()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(invoke).toHaveBeenCalledWith('ai:cancel', requestId)
    act(() => emitBridgeEvent('ai:delta', { requestId, text: 'LATE' }))
    await frame()
    await resolve(result({ requestId, text: '## Fixes\n- fallback', source: 'fallback', model: null, error: { code: 'cancelled', message: 'Cancelled' } }))
    expect(box().value).toBe('## Features\n- Ref')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeInTheDocument()
  })

  it('typing during a stream stops it and keeps edits', async () => {
    const { invoke, requestId, resolve } = await generating()
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '## Features' }))
    await frame()
    fireEvent.change(box(), { target: { value: '## Features\n- mine' } })
    expect(invoke).toHaveBeenCalledWith('ai:cancel', requestId)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stopped — your edits win' }))
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '\n- theirs' }))
    await frame()
    await resolve(result({ requestId, text: '## Features\n- theirs', source: 'fallback', error: { code: 'cancelled', message: 'Cancelled' } }))
    expect(box().value).toBe('## Features\n- mine')
  })

  it('a successful reply that lands after the user typed does not overwrite the edits', async () => {
    const { requestId, resolve } = await generating()
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '## Features' }))
    await frame()
    fireEvent.change(box(), { target: { value: '## Features\n- mine' } })
    // Main finished before ai:cancel arrived: the reply is a full success.
    await resolve(result({ requestId, text: '## Features\n- theirs' }))
    expect(box().value).toBe('## Features\n- mine')
  })

  it('preview renders sections from markdown', async () => {
    mockBridge({ 'ai:status': READY })
    render(<Harness initial={'## Features\n- **Refunds** from orders\n\n## Fixes\n- Totals'} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Preview' }))
    expect(screen.getByRole('heading', { name: 'Features' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Fixes' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Refunds from orders', 'Totals'])
    expect(screen.getByText('Refunds').tagName).toBe('STRONG')
    expect(screen.getByText('6 words')).toBeInTheDocument()
  })

  it('zero commits shows the redeploy empty state and no generate button', async () => {
    mockBridge({ 'ai:status': READY })
    render(<Harness commits={[]} />)
    expect(await screen.findByText('Redeploy — no new commits, no notes or notifications')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('the commit chip expands into the commit list', async () => {
    mockBridge({ 'ai:status': READY })
    render(<Harness />)
    const chip = await screen.findByRole('button', { name: '2 commits' })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('fix: totals off by a cent')).toBeInTheDocument()
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument()
  })

  it('not configured shows settings link and fallback', async () => {
    mockBridge({ 'ai:status': { configured: false, model: 'claude-opus-5-5' } })
    render(<Harness />)
    expect(await screen.findByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '#/settings')
    expect(screen.queryByRole('button', { name: /Generate/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use commit list instead' }))
    expect(box().value).toBe(fallbackNotes(COMMITS))
    expect(box().value).toBe('## Features\n- Refunds\n\n## Fixes\n- Totals off by a cent')
  })

  it('error shows the AiError message and keeps the text', async () => {
    const { requestId, resolve } = await generating({ initial: 'my draft' })
    await resolve(result({ requestId, text: '## Fixes\n- x', source: 'fallback', model: null, error: { code: 'auth', message: 'The Anthropic key was rejected' } }))
    expect(screen.getByRole('alert')).toHaveTextContent('The Anthropic key was rejected')
    expect(box().value).toBe('my draft')
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeInTheDocument()
  })

  it('a rejected request shows its message and keeps the text', async () => {
    const invoke = mockBridge({ 'ai:status': READY })
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'ai:status') return READY
      if (ch === 'ai:releaseNotes') throw new Error('vault locked')
      return null
    })
    render(<Harness initial="kept" />)
    fireEvent.click(await screen.findByRole('button', { name: /Generate with Claude/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('vault locked')
    expect(box().value).toBe('kept')
  })

  it('a truncated result says it was cut off', async () => {
    const { requestId, resolve } = await generating()
    await resolve(result({ requestId, text: '## Features\n- a', truncated: true }))
    expect(box().value).toBe('## Features\n- a')
    expect(screen.getByText('Cut off at the length limit')).toBeInTheDocument()
  })

  it('reduced motion renders without caret and transforms', async () => {
    motion.safe = false
    const { requestId } = await generating()
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '## Features\n- a' }))
    await frame()
    expect(document.querySelector('[data-caret]')).toBeNull()
    expect(document.querySelector('[data-motion]')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByRole('heading', { name: 'Features' })).toBeInTheDocument()
    expect(document.querySelector('[data-motion]')).toBeNull()
  })

  it('motion-safe streaming shows the caret and an animated underline', async () => {
    const { requestId } = await generating()
    act(() => emitBridgeEvent('ai:delta', { requestId, text: '## Features' }))
    await frame()
    expect(document.querySelector('[data-caret]')).not.toBeNull()
    expect(document.querySelector('[data-motion="underline"]')).not.toBeNull()
  })
})

function detail(over: Partial<ReleaseDetail> = {}): ReleaseDetail {
  return {
    id: REL,
    environmentId: ENV,
    kind: 'release',
    status: 'ready',
    version: 'v1.5.0',
    previousVersion: 'v1.4.0',
    redeploy: false,
    rollbackOf: null,
    triggeredBy: 'tester@mac',
    createdAt: '2026-10-19T09:00:00Z',
    startedAt: null,
    finishedAt: null,
    deploymentCount: 1,
    hostCount: 1,
    error: null,
    options: { backup: false, notify: true, qa: false },
    releaseNotes: null,
    playbook: null,
    runs: [{ id: 'r1', releaseId: REL, deploymentId: DEP, deploymentName: 'api', hostId: 'h1', hostLabel: 'app1', position: 0, branch: 'main', previousCommit: null, deployedCommit: null, commits: [], status: 'pending', rolledBack: false, backupFile: null, startedAt: null, finishedAt: null, steps: [] }],
    preflight: {
      releaseId: REL,
      checks: [],
      commits: { [DEP]: { commits: COMMITS, hiddenPairs: 0, truncated: 0, firstDeploy: false, head: null, tagCommit: null } },
      dockerModes: {},
      composeServices: {},
      serviceCommits: {},
      locks: {},
      commitsTotal: 2,
      blocked: false,
    },
    lastSeq: 0,
    ...over,
  } as ReleaseDetail
}

describe('ReleaseNotesSlot', () => {
  it('slot in Choose shows the after-preflight hint; in Confirm mounts the editor with preflight commits', async () => {
    mockBridge({ 'ai:status': READY })
    const { rerender } = render(<ReleaseNotesSlot environmentId={ENV} release={null} />)
    expect(screen.getByText('Notes are drafted from the commits after preflight')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    rerender(<ReleaseNotesSlot environmentId={ENV} release={detail()} productName="Shop" />)
    expect(await screen.findByRole('button', { name: '2 commits' })).toBeInTheDocument()
    expect(box()).toBeInTheDocument()
  })

  it('a redeploy in Confirm shows the empty state', async () => {
    mockBridge({ 'ai:status': READY })
    render(<ReleaseNotesSlot environmentId={ENV} release={detail({ redeploy: true, preflight: { ...detail().preflight!, commits: {}, commitsTotal: 0 } })} />)
    expect(await screen.findByText('Redeploy — no new commits, no notes or notifications')).toBeInTheDocument()
  })

  it('edits save through release:set-notes, flushed before Start', async () => {
    const invoke = mockBridge({ 'ai:status': READY, 'release:set-notes': undefined })
    render(<ReleaseNotesSlot environmentId={ENV} release={detail({ releaseNotes: 'saved' })} />)
    await screen.findByRole('button', { name: '2 commits' })
    expect(box().value).toBe('saved')
    fireEvent.change(box(), { target: { value: 'edited once' } })
    fireEvent.change(box(), { target: { value: 'edited twice' } })
    expect(invoke.mock.calls.filter((c) => c[0] === 'release:set-notes')).toEqual([])
    await act(() => flushReleaseNotes(REL))
    expect(invoke.mock.calls.filter((c) => c[0] === 'release:set-notes')).toEqual([['release:set-notes', REL, 'edited twice']])
    // Nothing pending: a second flush sends nothing.
    await act(() => flushReleaseNotes(REL))
    expect(invoke.mock.calls.filter((c) => c[0] === 'release:set-notes')).toHaveLength(1)
    fireEvent.change(box(), { target: { value: 'edited thrice' } })
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === 'release:set-notes')).toHaveLength(2), { timeout: 1000 })
    expect(invoke).toHaveBeenLastCalledWith('release:set-notes', REL, 'edited thrice')
  })

  it('registers the notify and QA options and defaults QA from the environment', async () => {
    expect(releaseOptionsAvailable()).toEqual({ notify: true, qa: true })
    mockBridge({ 'integration:get': { environmentId: ENV, qaOnDeploy: true, qa: { repo: 'o/r', workflow: 'qa.yml', ref: 'main' } } })
    expect(await releaseOptionDefaults(ENV)).toEqual({ qa: true })
    mockBridge({ 'integration:get': { environmentId: ENV, qaOnDeploy: true, qa: null } })
    expect(await releaseOptionDefaults(ENV)).toEqual({ qa: false })
    mockBridge({})
    expect(await releaseOptionDefaults(ENV)).toEqual({})
  })
})

describe('ReleaseNotesReadOnly', () => {
  it('shows saved notes and copies them', async () => {
    const { ReleaseNotesReadOnly } = await import('../../src/renderer/src/ai/NotesPreview')
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { rerender } = render(<ReleaseNotesReadOnly notes={'## Fixes\n- Totals'} />)
    expect(screen.getByRole('heading', { name: 'Fixes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('## Fixes\n- Totals')
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Release notes copied' })))
    rerender(<ReleaseNotesReadOnly notes={null} />)
    expect(screen.queryByRole('region', { name: 'Release notes' })).not.toBeInTheDocument()
  })
})
