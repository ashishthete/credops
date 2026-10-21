import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deployStore, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { applyContainerLog, followStore, resetContainers } from '../../src/renderer/src/ops/containers'
import { LogsDrawer } from '../../src/renderer/src/pages/ops/containers/LogsDrawer'
import { ServiceLogs } from '../../src/renderer/src/pages/products/services/ServiceLogs'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { appService, deploymentMeta, environment, host, mockBridge, vaultStatus } from './helpers'

const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }] })
const api = appService({ id: 's1', name: 'api', deploymentId: 'd1' })
const SUDO = "Docker on app1 needs sudo for logs; check the checkout's sudo setting"
const LOCKED = 'The vault was locked; follow the logs again after unlocking'

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

/** Each `service:logs` names a new follow: f1, f2, … */
function world() {
  const invoke = mockBridge({ 'containers:unfollow': undefined })
  const base = invoke.getMockImplementation()!
  let n = 0
  invoke.mockImplementation(async (channel: string) => (channel === 'service:logs' ? `f${++n}` : base(channel)))
  inventoryStore.set({ products: [], environments: [staging], hosts: [host({ id: 'h1', label: 'app1' })], identities: [], vaults: [], regions: [] })
  deployStore.set({ ...deployStore.get(), deployments: [deploymentMeta({ id: 'd1', name: 'core', hostId: 'h1', environmentId: 'e1' })], loaded: true })
  return invoke
}

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  return <ServiceLogs service={api} onClose={onClose} />
}

beforeEach(() => vaultStatusStore.set(vaultStatus({ unlocked: true })))
afterEach(() => {
  cleanup()
  resetContainers()
  resetDeploy()
  inventoryStore.set(null)
  vaultStatusStore.set(null)
})

describe('service logs', () => {
  it('opens a live follow with the chosen tail and unfollows on close', async () => {
    const invoke = world()
    const { rerender } = render(<Harness />)
    await flush()
    expect(screen.getByRole('dialog', { name: 'api logs on app1' })).toBeInTheDocument()
    expect(calls(invoke, 'service:logs').map((x) => x.slice(1))).toEqual([['s1', 200]])
    expect([...(screen.getByLabelText('Tail') as HTMLSelectElement).options].map((o) => Number(o.value))).toEqual([100, 200, 1000, 5000])

    fireEvent.change(screen.getByLabelText('Tail'), { target: { value: '1000' } })
    await flush()
    expect(calls(invoke, 'containers:unfollow').map((x) => x[1])).toEqual(['f1'])
    expect(calls(invoke, 'service:logs').at(-1)!.slice(1)).toEqual(['s1', 1000])

    rerender(<ServiceLogs service={null} onClose={() => {}} />)
    await flush()
    expect(calls(invoke, 'containers:unfollow').map((x) => x[1])).toEqual(['f1', 'f2'])
  })

  it('appends containers:logs chunks as text, not HTML', async () => {
    world()
    render(<Harness />)
    await flush()
    act(() => applyContainerLog({ followId: 'f1', chunk: 'one <b>bold</b>\n' }))
    act(() => applyContainerLog({ followId: 'f1', chunk: 'two <img src=x onerror=alert(1)>\n' }))
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('one <b>bold</b>')
    expect(log).toHaveTextContent('two <img src=x onerror=alert(1)>')
    expect(log.querySelector('b, img')).toBeNull()
    expect(followStore.get().f1).toContain('one')
  })

  it('the sudo error shows the hint that opens checkout settings', async () => {
    world()
    render(<Harness />)
    await flush()
    act(() => applyContainerLog({ followId: 'f1', ended: true, error: { code: 'unknown', message: SUDO } }))
    const sheet = screen.getByRole('dialog', { name: 'api logs on app1' })
    expect(within(sheet).getByText(SUDO)).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open checkout settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit checkout' })
    await waitFor(() => expect(within(dialog).getByLabelText('Use sudo')).toHaveFocus())
  })

  it('another ended follow shows no hint; Follow again restarts it', async () => {
    const invoke = world()
    render(<Harness />)
    await flush()
    act(() => applyContainerLog({ followId: 'f1', chunk: 'last words\n' }))
    act(() => applyContainerLog({ followId: 'f1', ended: true, error: { code: 'unknown', message: 'no such service: api' } }))
    await flush()
    expect(screen.getByText('no such service: api')).toBeInTheDocument()
    // The lines stay in the drawer after the follow ends.
    expect(screen.getByRole('log')).toHaveTextContent('last words')
    expect(screen.queryByRole('button', { name: 'Open checkout settings' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Follow again' }))
    await flush()
    expect(calls(invoke, 'service:logs')).toHaveLength(2)
  })

  it('a follow ended by the lock says so and follows again once unlocked', async () => {
    const invoke = world()
    render(<Harness />)
    await flush()
    act(() => {
      vaultStatusStore.set(vaultStatus({ unlocked: false }))
      applyContainerLog({ followId: 'f1', ended: true, error: { code: 'locked', message: LOCKED } })
    })
    expect(screen.getByText(LOCKED)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Follow again' })).toBeDisabled()
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true })))
    fireEvent.click(screen.getByRole('button', { name: 'Follow again' }))
    await flush()
    expect(calls(invoke, 'service:logs').map((x) => x.slice(1))).toEqual([
      ['s1', 200],
      ['s1', 200],
    ])
    expect(screen.queryByText(LOCKED)).not.toBeInTheDocument()
  })

  it('a late inventory load renames the drawer without restarting the follow', async () => {
    const invoke = world()
    inventoryStore.set(null)
    render(<Harness />)
    await flush()
    expect(screen.getByRole('dialog', { name: 'api logs on its host' })).toBeInTheDocument()
    act(() => applyContainerLog({ followId: 'f1', chunk: 'kept\n' }))
    act(() => inventoryStore.set({ products: [], environments: [staging], hosts: [host({ id: 'h1', label: 'app1' })], identities: [], vaults: [], regions: [] }))
    await flush()
    expect(screen.getByRole('dialog', { name: 'api logs on app1' })).toBeInTheDocument()
    expect(calls(invoke, 'service:logs')).toHaveLength(1)
    expect(calls(invoke, 'containers:unfollow')).toHaveLength(0)
    expect(screen.getByRole('log')).toHaveTextContent('kept')
  })

  it('a late sudo end from an earlier follow does not raise the hint', async () => {
    world()
    render(<Harness />)
    await flush()
    fireEvent.change(screen.getByLabelText('Tail'), { target: { value: '1000' } })
    await flush()
    // The current follow ends on another error, then the stopped one's sudo end arrives late.
    act(() => applyContainerLog({ followId: 'f2', ended: true, error: { code: 'unknown', message: 'no such service: api' } }))
    act(() => applyContainerLog({ followId: 'f1', ended: true, error: { code: 'unknown', message: SUDO } }))
    await flush()
    expect(screen.getByText('no such service: api')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open checkout settings' })).not.toBeInTheDocument()
    // The current follow's sudo end still does.
    fireEvent.click(screen.getByRole('button', { name: 'Follow again' }))
    await flush()
    act(() => applyContainerLog({ followId: 'f3', ended: true, error: { code: 'unknown', message: SUDO } }))
    expect(await screen.findByRole('button', { name: 'Open checkout settings' })).toBeInTheDocument()
  })

  it('without snapshot there is no Follow switch; with it the snapshot mode works as before', async () => {
    mockBridge({ 'containers:unfollow': undefined })
    const follow = vi.fn(async () => 'f7')
    const snapshot = vi.fn(async (tail: number) => `snap ${tail}\n`)
    const { rerender } = render(<LogsDrawer target={{ title: 'Live', follow }} onClose={() => {}} />)
    await flush()
    expect(screen.queryByRole('switch', { name: 'Follow' })).not.toBeInTheDocument()
    expect(follow).toHaveBeenCalledWith(200)

    rerender(<LogsDrawer target={null} onClose={() => {}} />)
    await flush()
    follow.mockClear()
    rerender(<LogsDrawer target={{ title: 'Snap', follow, snapshot }} onClose={() => {}} />)
    await flush()
    expect(snapshot).toHaveBeenCalledWith(200)
    expect(follow).not.toHaveBeenCalled()
    expect(screen.getByRole('log')).toHaveTextContent('snap 200')
    fireEvent.click(screen.getByRole('switch', { name: 'Follow' }))
    await flush()
    expect(follow).toHaveBeenCalledWith(200)
  })
})
