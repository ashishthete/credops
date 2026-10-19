import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { applyContainerLog, resetContainers } from '../../src/renderer/src/ops/containers'
import { ContainersTab } from '../../src/renderer/src/pages/ops/ContainersTab'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import type { ContainerList, ContainerMeta } from '../../src/shared/ops'
import { environment, host, mockBridge } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))
vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const c = (name: string, over: Partial<ContainerMeta> = {}): ContainerMeta => ({
  id: `id-${name}`,
  name,
  image: `img/${name}:1`,
  state: 'running',
  status: 'Up 2 hours',
  ports: '',
  createdAt: '2026-10-19T08:00:00Z',
  project: null,
  service: null,
  ...over,
})
const list = (containers: ContainerMeta[]): ContainerList => ({ containers, truncated: false, skipped: 0, fetchedAt: '2026-10-19T09:00:00Z' })

const app1 = host({ id: 'h-app', label: 'app-1' })
const stg1 = host({ id: 'h-stg', label: 'stg-1' })
const prod = environment({ id: 'e-prod', name: 'prod', protected: true, hosts: [{ hostId: 'h-app', role: 'app' }] })
const staging = environment({ id: 'e-stg', name: 'staging', hosts: [{ hostId: 'h-stg', role: 'app' }] })

const containers = list([
  c('web-1', { project: 'shop', ports: '0.0.0.0:80->80/tcp' }),
  c('db-1', { project: 'shop', state: 'exited', status: 'Exited (0) 1 hour ago' }),
  c('cron', { state: 'restarting', status: 'Restarting' }),
])

let where = ''
function Where() {
  where = useLocation().pathname
  return null
}

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

async function renderTab(results: Record<string, unknown> = {}, entry = '/ops/containers?host=h-app&env=e-prod') {
  const invoke = mockBridge({ 'containers:list': containers, ...results })
  inventoryStore.set({ products: [], environments: [prod, staging], hosts: [app1, stg1], identities: [], vaults: [] })
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/ops/containers" element={<ContainersTab />} />
        <Route path="/terminals" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
  await flush()
  return invoke
}

beforeEach(() => {
  motion.safe = true
  vi.mocked(toast).mockClear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  resetContainers()
  resetSessions()
  inventoryStore.set(null)
  clearToasts()
  where = ''
})

describe('containers tab', () => {
  it('groups containers by compose project and filters running only', async () => {
    await renderTab()
    const groups = screen.getAllByRole('region').map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['shop', 'Standalone'])
    expect(screen.getByRole('button', { name: /shop\s*2 containers/ })).toHaveAttribute('aria-expanded', 'true')
    expect(within(screen.getByRole('region', { name: 'shop' })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'exited' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'restarting' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Running only' }))
    expect(screen.queryByRole('listitem', { name: 'db-1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: 'cron' })).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'web-1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /shop\s*1 container$/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /shop/ }))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'web-1' })).not.toBeInTheDocument())
  })

  it('restart in a protected environment asks for the typed name; in staging it runs directly', async () => {
    const invoke = await renderTab({ 'containers:action': undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Restart web-1' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Restart container' })
    expect(confirm).toBeDisabled()
    expect(calls(invoke, 'containers:action')).toHaveLength(0)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'prod' } })
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(calls(invoke, 'containers:action')[0].slice(1)).toEqual(['h-app', 'e-prod', 'web-1', 'restart', 'prod'])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restarted web-1 on app-1' }))
    cleanup()

    const invoke2 = await renderTab({ 'containers:action': undefined }, '/ops/containers?host=h-stg&env=e-stg')
    fireEvent.click(screen.getByRole('button', { name: 'Restart web-1' }))
    await flush()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls(invoke2, 'containers:action')[0].slice(1)).toEqual(['h-stg', 'e-stg', 'web-1', 'restart', undefined])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restarted web-1 on stg-1' }))
  })

  it('a docker error shows the plain message with a retry', async () => {
    const invoke = await renderTab()
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'containers:list') throw new Error("Error invoking remote method 'containers:list': Error: Docker isn't installed on app-1")
      return null
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh containers' }))
    await flush()
    expect(screen.getByText("Docker isn't installed on app-1")).toBeInTheDocument()
    invoke.mockImplementation(async () => containers)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(screen.getByRole('listitem', { name: 'web-1' })).toBeInTheDocument()
  })

  it('logs drawer follows and unfollows on close', async () => {
    const invoke = await renderTab({ 'containers:logs': '2026-10-19T09:00:00Z hello\n', 'containers:follow': 'f1', 'containers:unfollow': undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Logs of web-1' }))
    await flush()
    expect(calls(invoke, 'containers:logs')[0].slice(1)).toEqual(['h-app', 'e-prod', 'web-1', 200])
    expect(screen.getByRole('log')).toHaveTextContent('hello')
    expect(document.querySelector('[data-stamp]')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Tail'), { target: { value: '1000' } })
    await flush()
    expect(calls(invoke, 'containers:logs').at(-1)!.slice(1)).toEqual(['h-app', 'e-prod', 'web-1', 1000])

    fireEvent.click(screen.getByRole('switch', { name: 'Follow' }))
    await flush()
    expect(calls(invoke, 'containers:follow')[0].slice(1)).toEqual(['h-app', 'e-prod', 'web-1', 1000])
    act(() => applyContainerLog({ followId: 'f1', chunk: 'live line\n' }))
    expect(screen.getByRole('log')).toHaveTextContent('live line')

    fireEvent.click(screen.getByRole('button', { name: 'Close logs' }))
    await flush()
    expect(calls(invoke, 'containers:unfollow').map((x) => x[1])).toEqual(['f1'])
  })

  it('Shell opens an exec tab and goes to Terminals', async () => {
    const invoke = await renderTab({
      'ssh:open': { id: 's1', attempt: 1, container: 'web-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Shell in web-1' }))
    await flush()
    const open = calls(invoke, 'ssh:open')[0][1] as Record<string, unknown>
    expect(open).toMatchObject({ hostId: 'h-app', environmentId: 'e-prod', container: 'web-1' })
    expect(where).toBe('/terminals')
  })
})
