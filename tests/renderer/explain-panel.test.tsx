import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplainButton, ExplainPanel } from '../../src/renderer/src/ai/ExplainPanel'
import { explain, explainStore, resetExplain } from '../../src/renderer/src/ai/explain-store'
import '../../src/renderer/src/ai/register'
import { FailureActionSlot } from '../../src/renderer/src/deploy/slots'
import { FailurePanel } from '../../src/renderer/src/pages/deployments/release/FailurePanel'
import { SessionEnded } from '../../src/renderer/src/pages/terminals/SessionEnded'
import { TunnelCard } from '../../src/renderer/src/pages/tunnels/TunnelCard'
import { resetSessions, startSessionSync } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { toast } from '../../src/renderer/src/ui/Toaster'
import type { ExplainCommand, ExplainSubject, Explanation } from '../../src/shared/ai'
import type { SessionMeta } from '../../src/shared/ssh'
import { emitBridgeEvent, mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))
vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const REL = '44444444-4444-4444-8444-444444444444'
const ENV = '33333333-3333-4333-8333-333333333333'
const HOST = '22222222-2222-4222-8222-222222222222'
const SES = '55555555-5555-4555-8555-555555555555'
const TUN = '66666666-6666-4666-8666-666666666666'
const READY = { configured: true, model: 'claude-opus-5-5' }
const SUBJECT: ExplainSubject = { kind: 'release', releaseId: REL, stepId: 's-build' }

const cmd = (over: Partial<ExplainCommand> = {}): ExplainCommand => ({ title: 'Check disk', command: 'df -h /var', where: 'host', risk: 'read-only', ...over })
function explanation(over: Partial<Explanation> = {}): Explanation {
  return {
    requestId: 'x',
    summary: 'The build ran out of disk.',
    cause: 'The log shows ENOSPC on /var.',
    confidence: 'high',
    steps: ['Free space on /var', 'Retry the release'],
    commands: [cmd()],
    model: 'claude-opus-5-5',
    redactions: { ip: 2 },
    sentContext: 'Failure: a release step',
    target: { hostId: HOST, hostLabel: 'web-1', environmentId: ENV, environmentName: 'staging', protected: false },
    ...over,
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const p = new Promise<T>((r) => (resolve = r))
  return { p, resolve }
}
const sessionMeta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: SES, kind: 'ssh', hostId: HOST, environmentId: ENV, label: 'web-1', color: null, state: 'connecting', hops: [], error: null,
  openedAt: '2026-10-19T12:00:00Z', readyAt: null, closedAt: null, attempt: 1, container: null, ...over,
})

function mount(results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'ai:status': READY, 'ai:explain': explanation(), 'ai:command': undefined, 'ai:cancel': undefined, ...results })
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  render(
    <MemoryRouter initialEntries={['/deployments']}>
      <Routes>
        <Route path="/terminals" element={<p>terminal page</p>} />
        <Route path="*" element={<button>trigger</button>} />
      </Routes>
      <ExplainPanel />
    </MemoryRouter>,
  )
  return { invoke, writeText, calls: (ch: string) => invoke.mock.calls.filter((c) => c[0] === ch) }
}
const requestIdOf = (invoke: ReturnType<typeof mockBridge>) => (invoke.mock.calls.find((c) => c[0] === 'ai:explain') as unknown as [string, string])[1]
const open = async (subject = SUBJECT) => {
  await act(async () => void explain(subject, screen.getByRole('button', { name: 'trigger' })))
}
const panel = () => screen.getByRole('dialog', { name: 'Explain failure' })

let stopSync: () => void = () => undefined
beforeEach(() => {
  motion.safe = true
  resetExplain()
  resetSessions()
  resetTunnels()
})
afterEach(() => {
  stopSync()
  vi.useRealTimers()
})

describe('ExplainPanel', () => {
  it('opening the panel never touches a session', async () => {
    const { calls } = mount()
    await open()
    expect(await within(panel()).findByText('The build ran out of disk.')).toBeInTheDocument()
    expect(screen.getByText('High confidence')).toBeInTheDocument()
    for (const ch of ['session:write', 'ssh:open', 'shell:open']) expect(calls(ch)).toHaveLength(0)
  })

  it('shows the cause, checkable steps and the sent context', async () => {
    mount()
    await open()
    await screen.findByText('The build ran out of disk.')
    fireEvent.click(screen.getByRole('button', { name: 'Cause' }))
    expect(screen.getByText('The log shows ENOSPC on /var.')).toBeInTheDocument()
    const step = screen.getByRole('button', { name: /Free space on \/var/ })
    fireEvent.click(step)
    expect(step).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('Sent to Claude'))
    expect(screen.getByText('Failure: a release step')).toBeInTheDocument()
    expect(screen.getByText(/2 IP addresses redacted/)).toBeInTheDocument()
    expect(screen.getByText(/server-side fallback on/)).toBeInTheDocument()
  })

  it('copy writes clipboard and audits', async () => {
    const { invoke, writeText } = mount()
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('df -h /var'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:command', requestIdOf(invoke), 0, 'copy'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('run in terminal writes only after confirm', async () => {
    const { invoke, calls } = mount({ 'ssh:open': sessionMeta() })
    stopSync = startSessionSync()
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    expect(within(dialog).getByText('df -h /var')).toBeInTheDocument()
    expect(calls('ssh:open')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(calls('ssh:open')).toHaveLength(1))
    expect((calls('ssh:open')[0] as unknown[])[1]).toMatchObject({ hostId: HOST, environmentId: ENV })
    expect(calls('session:write')).toHaveLength(0)
    act(() => emitBridgeEvent('session:state', sessionMeta({ state: 'ready', readyAt: '2026-10-19T12:00:01Z' })))
    await waitFor(() => expect(calls('session:write')).toHaveLength(1))
    expect(calls('session:write')[0]).toEqual(['session:write', SES, 'df -h /var\r'])
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:command', requestIdOf(invoke), 0, 'run'))
    expect(await screen.findByText('terminal page')).toBeInTheDocument()
  })

  it('a local command opens a local shell', async () => {
    const { calls } = mount({ 'ai:explain': explanation({ commands: [cmd({ where: 'local', command: 'ssh-add -l' })] }), 'shell:open': sessionMeta({ kind: 'local', hostId: null }) })
    stopSync = startSessionSync()
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run locally?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(calls('shell:open')).toHaveLength(1))
    act(() => emitBridgeEvent('session:state', sessionMeta({ kind: 'local', hostId: null, state: 'ready' })))
    await waitFor(() => expect(calls('session:write')).toEqual([['session:write', SES, 'ssh-add -l\r']]))
    expect(calls('ssh:open')).toHaveLength(0)
  })

  it('protected environment requires the typed name', async () => {
    mount({ 'ai:explain': explanation({ target: { hostId: HOST, hostLabel: 'web-1', environmentId: ENV, environmentName: 'prod', protected: true } }) })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    const run = within(dialog).getByRole('button', { name: 'Run' })
    expect(run).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Type prod to confirm'), { target: { value: 'prod' } })
    expect(run).toBeEnabled()
  })

  it('cancel writes nothing', async () => {
    const { calls } = mount({ 'ssh:open': sessionMeta() })
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run on web-1?' })).not.toBeInTheDocument())
    for (const ch of ['session:write', 'ssh:open', 'shell:open', 'ai:command']) expect(calls(ch)).toHaveLength(0)
  })

  it('destructive command shows red badge and confirm label', async () => {
    mount({ 'ai:explain': explanation({ commands: [cmd({ risk: 'destructive', command: 'docker system prune -af' })] }) })
    await open()
    const badge = await screen.findByText('destructive')
    expect(badge.closest('[style]')?.getAttribute('style')).toContain('--err')
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    expect(within(dialog).getByRole('button', { name: 'Run destructive command' })).toBeInTheDocument()
  })

  it('a command Claude calls read-only is shown and confirmed as destructive when it matches the destructive pattern', async () => {
    mount({ 'ai:explain': explanation({ commands: [cmd({ risk: 'read-only', command: 'rm -rf /var/lib/app' })] }) })
    await open()
    const badge = await screen.findByText('destructive')
    expect(badge.closest('[style]')?.getAttribute('style')).toContain('--err')
    expect(screen.queryByText('read-only')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    expect(within(dialog).getByRole('button', { name: 'Run destructive command' })).toBeInTheDocument()
  })

  it('a command holding a control character is refused at write time, before any session opens', async () => {
    vi.mocked(toast).mockClear()
    const { calls } = mount({ 'ai:explain': explanation({ commands: [cmd({ command: 'df -h\u0015rm -rf ~' })] }), 'ssh:open': sessionMeta() })
    stopSync = startSessionSync()
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Run in terminal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run on web-1?' })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Run/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "The command didn't run", tone: 'error' })))
    for (const ch of ['session:write', 'ssh:open', 'shell:open', 'ai:command']) expect(calls(ch)).toHaveLength(0)
  })

  it('a host command with no host cannot run', async () => {
    mount({ 'ai:explain': explanation({ target: { hostId: null, hostLabel: null, environmentId: null, environmentName: null, protected: false } }) })
    await open()
    expect(await screen.findByRole('button', { name: 'Run in terminal' })).toBeDisabled()
  })

  it('loading shows skeleton and cancel calls ai:cancel', async () => {
    const pending = deferred<Explanation>()
    const { invoke } = mount({ 'ai:explain': pending.p })
    await open()
    expect(within(panel()).getByText('Reading the last 200 log lines…')).toBeInTheDocument()
    expect(panel().querySelector('[data-shimmer]')).not.toBeNull()
    expect(panel().getAttribute('data-motion')).toBe('slide')
    fireEvent.click(within(panel()).getByRole('button', { name: 'Cancel' }))
    expect(invoke).toHaveBeenCalledWith('ai:cancel', requestIdOf(invoke))
    await act(async () => pending.resolve(explanation({ summary: 'late answer' })))
    expect(screen.queryByText('late answer')).not.toBeInTheDocument()
    expect(explainStore.get().open).toBe(false)
  })

  it('reduced motion: no slide, no shimmer', async () => {
    motion.safe = false
    mount({ 'ai:explain': new Promise(() => undefined) })
    await open()
    expect(panel().querySelector('[data-shimmer]')).toBeNull()
    expect(panel().getAttribute('data-motion')).toBeNull()
  })

  it('an error shows the message', async () => {
    mount({ 'ai:explain': Promise.reject(new Error('Claude is busy; try again in a minute')) })
    await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude is busy')
  })

  it('Esc closes the panel and focus returns to the trigger', async () => {
    mount()
    await open()
    await screen.findByText('The build ran out of disk.')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Explain failure' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })

  it('palette offers Explain last failure once a tunnel fails', async () => {
    const { invoke } = mount()
    expect(commandStore.get().some((c) => c.id === 'ai.explain-last')).toBe(false)
    act(() => tunnelStore.set({ tunnels: [tunnelMeta({ id: TUN, hostId: HOST })], runtime: { [TUN]: tunnelRuntime({ id: TUN, state: 'failed' }) }, loaded: true }))
    const command = await waitFor(() => {
      const c = commandStore.get().find((x) => x.id === 'ai.explain-last')
      expect(c).toBeDefined()
      return c!
    })
    act(() => command.run())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:explain', expect.any(String), { kind: 'tunnel', tunnelId: TUN }))
  })
})

describe('Explain entry points', () => {
  it('TunnelCard failed shows Explain; disabled when AI not configured', async () => {
    mockBridge({ 'ai:status': READY })
    tunnelStore.set({ tunnels: [tunnelMeta({ id: TUN, hostId: HOST })], runtime: { [TUN]: tunnelRuntime({ id: TUN, state: 'failed', error: { code: 'dropped', message: 'gone' } }) }, loaded: true })
    const props = { id: TUN, hostLabel: 'web-1', protectedEnv: false, onEdit: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn() }
    const { unmount } = render(<TunnelCard {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explain' })).toBeEnabled())
    unmount()
    mockBridge({ 'ai:status': { configured: false, model: 'claude-opus-5-5' } })
    render(<TunnelCard {...props} />)
    const off = await screen.findByRole('button', { name: 'Explain' })
    await waitFor(() => expect(off).toBeDisabled())
    expect(off).toHaveAttribute('title', 'Set up Claude in Settings to explain failures')
  })

  it('TunnelCard that is up has no Explain', async () => {
    mockBridge({ 'ai:status': READY })
    tunnelStore.set({ tunnels: [tunnelMeta({ id: TUN, hostId: HOST })], runtime: { [TUN]: tunnelRuntime({ id: TUN, state: 'up' }) }, loaded: true })
    render(<TunnelCard id={TUN} hostLabel="web-1" protectedEnv={false} onEdit={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Explain' })).not.toBeInTheDocument()
  })

  it('SessionEnded shows Explain only for an ssh session with an error', async () => {
    mockBridge({ 'ai:status': READY })
    const { rerender } = render(<SessionEnded meta={sessionMeta({ state: 'failed', error: { code: 'auth', message: 'denied' } })} onReconnect={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Explain' })).toBeInTheDocument()
    rerender(<SessionEnded meta={sessionMeta({ state: 'closed' })} onReconnect={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Explain' })).not.toBeInTheDocument()
  })

  it('the failure-panel slot renders Explain for its release step', async () => {
    const invoke = mockBridge({ 'ai:status': READY, 'ai:explain': new Promise(() => undefined) })
    render(<FailureActionSlot releaseId={REL} stepId="s-build" error="build failed" lines={[]} />)
    const btn = await screen.findByRole('button', { name: 'Explain' })
    await waitFor(() => expect(btn).toBeEnabled())
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('ai:explain', expect.any(String), SUBJECT)
  })

  it('the release failure panel shows the Explain ai/register put in the slot', async () => {
    const invoke = mockBridge({ 'ai:status': READY, 'ai:explain': new Promise(() => undefined) })
    render(<FailurePanel releaseId={REL} chip={{ stepId: 's-build', label: 'Build', error: 'build failed' }} host={null} />)
    const panel = screen.getByRole('region', { name: 'Build failed' })
    const btn = await within(panel).findByRole('button', { name: 'Explain' })
    await waitFor(() => expect(btn).toBeEnabled())
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('ai:explain', expect.any(String), SUBJECT)
  })

  it('ExplainButton passes its subject', async () => {
    const invoke = mockBridge({ 'ai:status': READY, 'ai:explain': new Promise(() => undefined) })
    render(<ExplainButton subject={{ kind: 'session', sessionId: SES }} />)
    const btn = await screen.findByRole('button', { name: 'Explain' })
    await waitFor(() => expect(btn).toBeEnabled())
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('ai:explain', expect.any(String), { kind: 'session', sessionId: SES })
  })
})
