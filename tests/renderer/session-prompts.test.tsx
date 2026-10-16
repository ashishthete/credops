import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptHost } from '../../src/renderer/src/pages/terminals/PromptHost'
import { closeKnownHosts, KnownHostsDialog, openKnownHosts } from '../../src/renderer/src/pages/terminals/KnownHostsDialog'
import { promptStore, resetSessions, startSessionSync } from '../../src/renderer/src/terminal/sessions'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { KnownHostMeta, SessionPrompt } from '../../src/shared/ssh'
import { emitBridgeEvent, mockBridge } from './helpers'

const hostKey = (promptId: string, over: object = {}): SessionPrompt => ({
  kind: 'host-key',
  promptId,
  sessionId: 's1',
  hopLabel: 'web-1',
  info: { host: 'web-1.example.com', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', known: [] },
  ...over,
})

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

let stop: () => void
function setup(results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'session:list': [], 'session:answer': undefined, ...results })
  stop = startSessionSync()
  render(<PromptHost />)
  return invoke
}
const show = (...p: SessionPrompt[]) => act(() => promptStore.set(p))

// Exits are timed by the fake clock; unmounting under it keeps one test's animation from leaking into the next.
const settleThen = async <T,>(f: () => T) => {
  await settle()
  return f()
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(600) })

beforeEach(() => {
  vi.useFakeTimers()
  resetSessions()
})
afterEach(async () => {
  stop?.()
  closeKnownHosts()
  cleanup()
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
  vi.useRealTimers()
  resetSessions()
  clearToasts()
})

describe('host key prompt', () => {
  it('shows grouped fingerprint and trust answers true', async () => {
    const invoke = setup()
    await show(hostKey('p1'))
    expect(screen.getByRole('dialog', { name: 'First time connecting to web-1' })).toBeTruthy()
    expect(screen.getByText('ssh-ed25519')).toBeTruthy()
    expect(screen.getByTestId('fingerprint').textContent).toBe('SHA256: abcd efgh ijkl mnop qrst uvwx yz01 2345 6789 ABCD EFG')
    // Focus never starts on Trust.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }))
    expect(calls(invoke, 'session:answer')[0].slice(1)).toEqual(['p1', { kind: 'host-key', trust: true }])
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mentions other known key types', async () => {
    setup()
    await show(
      hostKey('p1', {
        info: { host: 'h', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaaa', known: [{ keyType: 'ssh-rsa', fingerprint: 'SHA256:bbbb', source: 'app' }] },
      }),
    )
    expect(screen.getByText('This host is known with a different key type (ssh-rsa)')).toBeTruthy()
  })

  it('cancel and Esc answer false', async () => {
    const invoke = setup()
    await show(hostKey('p1'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    await show(hostKey('p2'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    const answers = calls(invoke, 'session:answer').map((c) => c.slice(1))
    expect(answers).toEqual([
      ['p1', { kind: 'host-key', trust: false }],
      ['p2', { kind: 'host-key', trust: false }],
    ])
  })
})

describe('auth prompts', () => {
  const password: SessionPrompt = { kind: 'password', promptId: 'pw', sessionId: 's1', hopLabel: 'web-1', username: 'deploy' }

  it('password prompt answers and clears the field', async () => {
    const invoke = setup()
    await show(password)
    expect(screen.getByRole('dialog', { name: 'Password for deploy@web-1' })).toBeTruthy()
    const input = screen.getByLabelText('Password') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    fireEvent.change(input, { target: { value: 'hunter2-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(calls(invoke, 'session:answer')[0].slice(1)).toEqual(['pw', { kind: 'password', password: 'hunter2-secret' }])
    expect(input.value).toBe('')
    await settle()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('Cancel answers a null password', async () => {
    const invoke = setup()
    await show(password)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls(invoke, 'session:answer')[0].slice(1)).toEqual(['pw', { kind: 'password', password: null }])
  })

  it('keyboard prompt renders echo and non-echo fields', async () => {
    const invoke = setup()
    await show({
      kind: 'keyboard',
      promptId: 'kb',
      sessionId: 's1',
      hopLabel: 'web-1',
      name: 'Two-factor',
      instructions: 'Enter your codes',
      prompts: [
        { prompt: 'Username: ', echo: true },
        { prompt: 'Code: ', echo: false },
      ],
    })
    expect(screen.getByRole('dialog', { name: 'Two-factor' })).toBeTruthy()
    expect(screen.getByText('Enter your codes')).toBeTruthy()
    const user = screen.getByLabelText('Username:') as HTMLInputElement
    const code = screen.getByLabelText('Code:') as HTMLInputElement
    expect(user.type).toBe('text')
    expect(code.type).toBe('password')
    fireEvent.change(user, { target: { value: 'me' } })
    fireEvent.change(code, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(calls(invoke, 'session:answer')[0].slice(1)).toEqual(['kb', { kind: 'keyboard', responses: ['me', '123456'] }])
  })
})

describe('external close', () => {
  it('promptDone with a typed secret leaves no value in the DOM, during or after the exit', async () => {
    setup()
    await show({ kind: 'password', promptId: 'pw', sessionId: 's1', hopLabel: 'web-1', username: 'deploy' })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2-secret' } })
    act(() => emitBridgeEvent('session:promptDone', { promptId: 'pw' }))
    const values = () => [...document.querySelectorAll('input')].map((i) => i.value)
    expect(values().every((v) => !v.includes('hunter2'))).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(values().every((v) => !v.includes('hunter2'))).toBe(true)
    await settle()
    expect(document.querySelector('input')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('queue', () => {
  it('promptDone closes the dialog; next prompt in queue appears', async () => {
    setup()
    await show(hostKey('p1'), { kind: 'password', promptId: 'p2', sessionId: 's1', hopLabel: 'db', username: 'root' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: /First time connecting/ })).toBeTruthy()
    act(() => emitBridgeEvent('session:promptDone', { promptId: 'p1' }))
    await settle()
    expect(screen.getByRole('dialog', { name: 'Password for root@db' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    act(() => emitBridgeEvent('session:promptDone', { promptId: 'p2' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('known hosts dialog', () => {
  it('shows an error with Retry when the list fails', async () => {
    let fail = true
    const invoke = mockBridge({})
    invoke.mockImplementation(async (channel: string) => {
      if (channel !== 'knownhost:list') return undefined
      if (fail) throw new Error('boom')
      return []
    })
    render(<KnownHostsDialog />)
    act(() => openKnownHosts())
    await settle()
    expect(screen.queryByText('Loading…')).toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByText('No trusted hosts yet.')).toBeTruthy()
  })

  const entry = (id: string, host: string, over: Partial<KnownHostMeta> = {}): KnownHostMeta => ({
    id,
    host,
    keyType: 'ssh-ed25519',
    fingerprint: `SHA256:${id}fp`,
    firstSeen: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastSeen: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    ...over,
  })

  it('lists, filters, and removes after confirm', async () => {
    let list = [entry('a', 'alpha.example.com'), entry('b', '[beta.example.com]:2222', { keyType: 'ssh-rsa' })]
    const invoke = mockBridge({ 'knownhost:list': list })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knownhost:list') return list
      if (channel === 'knownhost:remove') {
        list = list.filter((e) => e.id !== 'a')
        return undefined
      }
      return undefined
    })
    render(<KnownHostsDialog />)
    act(() => openKnownHosts())
    expect((await settleThen(() => screen.getByText('alpha.example.com')))).toBeTruthy()
    expect(screen.getByText('[beta.example.com]:2222')).toBeTruthy()
    expect(screen.getAllByText(/3 days ago/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/2 hours ago/).length).toBeGreaterThan(0)
    expect(screen.getByText('Entries in ~/.ssh/known_hosts are read-only here; use ssh-keygen -R to remove them.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter known hosts'), { target: { value: 'beta' } })
    expect(screen.queryByText('alpha.example.com')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter known hosts'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove alpha.example.com ssh-ed25519' }))
    expect(calls(invoke, 'knownhost:remove')).toHaveLength(0)
    const confirm = await settleThen(() => screen.getByRole('dialog', { name: 'Remove alpha.example.com?' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await settle()
    expect(calls(invoke, 'knownhost:remove')[0].slice(1)).toEqual(['a'])
    await settle()
    expect(screen.queryByText('alpha.example.com')).toBeNull()
    expect(screen.getByText('[beta.example.com]:2222')).toBeTruthy()
  })
})
