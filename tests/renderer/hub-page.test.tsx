import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetHub } from '../../src/renderer/src/hub/store'
import { HubPage } from '../../src/renderer/src/pages/hub/HubPage'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_GROUP_ID, type HubGroup, type HubStatus, type HubUser } from '../../src/shared/hub'
import { emitBridgeEvent, mockBridge } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const STAMP = '2026-10-16T09:00:00.000Z'
const person = (over: Partial<HubUser> = {}): HubUser => ({
  oid: 'o-alice',
  upn: 'alice@corp.example',
  name: 'Alice',
  role: 'maintainer',
  status: 'active',
  groupIds: [DEFAULT_GROUP_ID],
  createdAt: STAMP,
  lastSeenAt: null,
  ...over,
})
const group = (over: Partial<HubGroup> = {}): HubGroup => ({
  id: 'g-ops',
  name: 'Ops',
  description: '',
  builtin: false,
  memberOids: [],
  grants: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const DEFAULT_GROUP = group({ id: DEFAULT_GROUP_ID, name: 'Default', builtin: true })
const linked = (over: Partial<Extract<HubStatus, { linked: true }>> = {}): HubStatus => ({
  linked: true,
  url: 'https://hub.corp.example',
  hubId: 'hub-1',
  hubName: 'Corp Hub',
  signedIn: true,
  signingIn: false,
  online: true,
  user: person(),
  sessionExpiresAt: null,
  ...over,
})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const flush = () => act(async () => {})

async function renderHub(results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'hub:users': [], 'hub:groups': [DEFAULT_GROUP], 'hub:audit': [], ...results })
  render(
    <MemoryRouter initialEntries={['/hub']}>
      <HubPage />
      <Toaster />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}
const admin = linked({ user: person({ oid: 'o-admin', name: 'Ada', role: 'admin' }) })

describe('HubPage', () => {
  beforeEach(() => {
    motion.safe = true
    resetHub()
  })
  afterEach(() => {
    cleanup()
    clearToasts()
  })

  it('shows connect form when unlinked, sign-in after connect', async () => {
    const user = userEvent.setup()
    const invoke = await renderHub({ 'hub:status': { linked: false }, 'hub:connect': linked({ signedIn: false, user: null }) })
    await user.type(screen.getByLabelText('Hub URL'), 'https://hub.corp.example')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(calls(invoke, 'hub:connect')[0]).toEqual(['hub:connect', 'https://hub.corp.example'])
    expect(await screen.findByText('Corp Hub')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(calls(invoke, 'hub:signIn')).toHaveLength(1)
  })

  it('signing in shows a cancellable wait', async () => {
    const user = userEvent.setup()
    const invoke = await renderHub({ 'hub:status': linked({ signedIn: false, signingIn: true, user: null }) })
    expect(screen.getByText('Waiting for your browser…')).toBeTruthy()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect((cancel as HTMLButtonElement).disabled).toBe(false)
    await user.click(cancel)
    expect(calls(invoke, 'hub:cancelSignIn')).toHaveLength(1)
  })

  it('pending user sees the pending empty state and no admin tabs', async () => {
    await renderHub({ 'hub:status': linked({ user: person({ status: 'pending', groupIds: [] }) }) })
    expect(
      screen.getByText(
        "You're signed in, but not in any group yet. A Hub admin needs to add you — until then you won't see any team deployments.",
      ),
    ).toBeTruthy()
    for (const name of ['People', 'Groups', 'Audit']) expect(screen.queryByRole('tab', { name })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeTruthy()
  })

  it('admin sees People, Groups and Audit', async () => {
    const user = userEvent.setup()
    await renderHub({ 'hub:status': admin, 'hub:users': [person()] })
    for (const name of ['Overview', 'People', 'Groups', 'Audit']) expect(screen.getByRole('tab', { name })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'People' }))
    expect(screen.getByText('alice@corp.example')).toBeTruthy()
  })

  it('add all pending to Default sends every pending oid', async () => {
    const user = userEvent.setup()
    const invoke = await renderHub({
      'hub:status': admin,
      'hub:users': [
        person({ oid: 'o-1', upn: 'p1@corp.example', status: 'pending', groupIds: [] }),
        person({ oid: 'o-2', upn: 'p2@corp.example', status: 'pending', groupIds: [] }),
        person({ oid: 'o-3', upn: 'ok@corp.example' }),
      ],
      'hub:addMembers': { ...DEFAULT_GROUP, memberOids: ['o-1', 'o-2'] },
    })
    await user.click(screen.getByRole('tab', { name: 'People' }))
    await user.click(screen.getByRole('button', { name: 'Add all pending to Default (2)' }))
    expect(calls(invoke, 'hub:addMembers')[0]).toEqual(['hub:addMembers', DEFAULT_GROUP_ID, ['o-1', 'o-2']])
  })

  it('Default group has no delete or rename', async () => {
    const user = userEvent.setup()
    await renderHub({ 'hub:status': admin, 'hub:groups': [DEFAULT_GROUP, group()] })
    await user.click(screen.getByRole('tab', { name: 'Groups' }))
    const def = screen.getByRole('article', { name: 'Default' })
    expect(within(def).getByText('Built in')).toBeTruthy()
    expect(within(def).queryByRole('button', { name: /^Delete/ })).toBeNull()
    expect(within(def).queryByRole('button', { name: /^Rename/ })).toBeNull()
    const ops = screen.getByRole('article', { name: 'Ops' })
    expect(within(ops).getByRole('button', { name: 'Delete Ops' })).toBeTruthy()
    expect(within(ops).getByRole('button', { name: 'Rename Ops' })).toBeTruthy()
  })

  it('a last_group 409 surfaces its message', async () => {
    const user = userEvent.setup()
    const message = 'Every person has to stay in at least one group'
    const invoke = await renderHub({
      'hub:status': admin,
      'hub:users': [person()],
      'hub:groups': [{ ...DEFAULT_GROUP, memberOids: ['o-alice'] }],
    })
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'hub:removeMember') throw new Error(`Error invoking remote method 'hub:removeMember': Error: ${message}`)
      if (ch === 'hub:groups') return [{ ...DEFAULT_GROUP, memberOids: ['o-alice'] }]
      if (ch === 'hub:users') return [person()]
      return null
    })
    await user.click(screen.getByRole('tab', { name: 'Groups' }))
    await user.click(screen.getByRole('button', { name: 'Remove Alice from Default' }))
    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('verifies the audit chain', async () => {
    const user = userEvent.setup()
    await renderHub({ 'hub:status': admin, 'hub:verifyAudit': { ok: true, count: 7 } })
    await user.click(screen.getByRole('tab', { name: 'Audit' }))
    await user.click(screen.getByRole('button', { name: 'Verify chain' }))
    expect(await screen.findByText('Chain intact (7 events)')).toBeTruthy()
  })

  it('reduced motion renders with no transforms', async () => {
    motion.safe = false
    const user = userEvent.setup()
    await renderHub({ 'hub:status': admin, 'hub:users': [person()], 'hub:groups': [DEFAULT_GROUP, group()] })
    const check = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[style]')) {
        expect(el.getAttribute('style') ?? '').not.toMatch(/transform/)
      }
    }
    check()
    await user.click(screen.getByRole('tab', { name: 'People' }))
    check()
    await user.click(screen.getByRole('tab', { name: 'Groups' }))
    check()
    act(() => emitBridgeEvent('hub:state', admin))
    check()
    fireEvent.keyDown(window, { key: 'x' })
  })
})
