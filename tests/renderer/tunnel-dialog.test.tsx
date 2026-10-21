import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { TunnelsPage } from '../../src/renderer/src/pages/tunnels/TunnelsPage'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import type { TunnelMeta, TunnelRuntime } from '../../src/shared/tunnels'
import { environment, host, mockBridge, tunnelMeta, tunnelRuntime } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const prod = environment({ id: 'e-prod', name: 'prod', protected: true, hosts: [{ hostId: 'h-db', role: 'db' }] })
const stage = environment({ id: 'e-stage', name: 'staging', hosts: [{ hostId: 'h-db', role: 'db' }, { hostId: 'h-web', role: 'app' }] })
const db = host({ id: 'h-db', label: 'db', environments: [{ environmentId: 'e-prod', role: 'db' }, { environmentId: 'e-stage', role: 'db' }] })
const web = host({ id: 'h-web', label: 'web', environments: [{ environmentId: 'e-stage', role: 'app' }] })

const flush = () => act(async () => {})
// Lets exit animations finish (jsdom's rAF runs on the faked setInterval).
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const card = (label: string) => screen.getByRole('article', { name: label })
const dialog = (name: string | RegExp) => screen.getByRole('dialog', { name })
const field = (d: HTMLElement, label: string) => within(d).getByLabelText(label) as HTMLInputElement | HTMLSelectElement
const type = (d: HTMLElement, label: string, value: string) => fireEvent.change(field(d, label), { target: { value } })

function setup(tunnels: TunnelMeta[] = [], runtime: TunnelRuntime[] = [], results: Record<string, unknown> = {}) {
  const invoke = mockBridge(results)
  inventoryStore.set({ products: [], environments: [prod, stage], hosts: [db, web], identities: [], vaults: [], regions: [] })
  tunnelStore.set({ tunnels, runtime: Object.fromEntries(runtime.map((r) => [r.id, r])), loaded: true })
  render(
    <MemoryRouter initialEntries={['/tunnels']}>
      <TunnelsPage />
      <Toaster />
    </MemoryRouter>,
  )
  return invoke
}

async function openMenu(label: string, item: string) {
  fireEvent.click(within(card(label)).getByRole('button', { name: `Actions for ${label}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
  await flush()
}

async function newTunnel() {
  fireEvent.click(screen.getAllByRole('button', { name: 'New tunnel' })[0])
  await flush()
  return dialog('New tunnel')
}

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  resetTunnels()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  resetTunnels()
  inventoryStore.set(null)
  clearToasts()
})

describe('tunnel dialog', () => {
  it('creates an L tunnel', async () => {
    const created = tunnelMeta({ id: 'new', label: 'pg', hostId: 'h-db' })
    const invoke = setup([], [], { 'tunnel:create': created })
    const d = await newTunnel()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    expect(within(d).getByRole('radio', { name: 'Local' })).toHaveAttribute('aria-checked', 'true')
    expect(field(d, 'Bind address').value).toBe('127.0.0.1')
    type(d, 'Bind port', '5433')
    type(d, 'Target host', 'localhost')
    type(d, 'Target port', '5432')
    expect(within(d).getByText('ssh -L 127.0.0.1:5433:localhost:5432 db')).toBeInTheDocument()
    expect(within(d).getByRole('button', { name: 'Copy command' })).toBeInTheDocument()

    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await flush()
    expect(calls(invoke, 'tunnel:create')).toEqual([
      [
        'tunnel:create',
        {
          label: 'pg',
          hostId: 'h-db',
          type: 'L',
          bindAddress: '127.0.0.1',
          bindPort: 5433,
          targetHost: 'localhost',
          targetPort: 5432,
          autoStart: false,
          autoReconnect: true,
        },
      ],
    ])
    expect(tunnelStore.get().tunnels.map((t) => t.id)).toEqual(['new'])
    await settle()
    expect(screen.queryByRole('dialog', { name: 'New tunnel' })).not.toBeInTheDocument()
  })

  it('save stays blocked until the required fields are valid', async () => {
    setup()
    const d = await newTunnel()
    const save = within(d).getByRole('button', { name: 'Create tunnel' })
    expect(save).toBeDisabled()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    type(d, 'Bind port', '70000')
    expect(within(d).getByText('bind port must be 0-65535')).toBeInTheDocument()
    expect(save).toBeDisabled()
    type(d, 'Bind port', '5433')
    type(d, 'Target port', '5432')
    expect(save).toBeEnabled()
    type(d, 'Target host', 'bad host')
    expect(within(d).getByText('host address is invalid')).toBeInTheDocument()
    expect(save).toBeDisabled()
  })

  it('SOCKS hides target fields and sends none', async () => {
    const invoke = setup([], [], { 'tunnel:create': tunnelMeta({ id: 'new', type: 'D', targetHost: null, targetPort: null }) })
    const d = await newTunnel()
    type(d, 'Label', 'proxy')
    type(d, 'Host', 'h-web')
    type(d, 'Bind port', '1080')
    fireEvent.click(within(d).getByRole('radio', { name: 'SOCKS' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(within(d).queryByLabelText('Target host')).not.toBeInTheDocument()
    expect(within(d).queryByLabelText('Target port')).not.toBeInTheDocument()
    expect(within(d).getByText('ssh -D 127.0.0.1:1080 web')).toBeInTheDocument()
    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await flush()
    const [, input] = calls(invoke, 'tunnel:create')[0] as [string, Record<string, unknown>]
    expect(input).toEqual({ label: 'proxy', hostId: 'h-web', type: 'D', bindAddress: '127.0.0.1', bindPort: 1080, autoStart: false, autoReconnect: true })
  })

  it('reduced motion still swaps the target fields and the type highlight', async () => {
    motion.safe = false
    setup()
    const d = await newTunnel()
    fireEvent.click(within(d).getByRole('radio', { name: 'SOCKS' }))
    await settle()
    expect(within(d).getByRole('radio', { name: 'SOCKS' })).toHaveAttribute('aria-checked', 'true')
    expect(within(d).queryByLabelText('Target host')).not.toBeInTheDocument()
    fireEvent.click(within(d).getByRole('radio', { name: 'Local' }))
    expect(within(d).getByLabelText('Target host')).toBeInTheDocument()
  })

  it('type control moves with the arrow keys', async () => {
    setup()
    const d = await newTunnel()
    const local = within(d).getByRole('radio', { name: 'Local' })
    local.focus()
    fireEvent.keyDown(local, { key: 'ArrowRight' })
    expect(within(d).getByRole('radio', { name: 'Remote' })).toHaveAttribute('aria-checked', 'true')
    expect(within(d).getByRole('radio', { name: 'Remote' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(within(d).getByRole('radio', { name: 'SOCKS' })).toHaveAttribute('aria-checked', 'true')
  })

  it('environment options follow the host', async () => {
    const invoke = setup([], [], { 'tunnel:create': tunnelMeta({ id: 'new' }) })
    const d = await newTunnel()
    const options = () => [...(field(d, 'Environment') as HTMLSelectElement).options].map((o) => o.textContent)
    expect(field(d, 'Environment')).toBeDisabled()
    type(d, 'Host', 'h-db')
    expect(options()).toEqual(['None', 'prod', 'staging'])
    type(d, 'Environment', 'e-prod')
    expect(within(d).getByText(/Protected environment/)).toBeInTheDocument()
    type(d, 'Host', 'h-web')
    expect(options()).toEqual(['None', 'staging'])
    expect(field(d, 'Environment').value).toBe('')
    type(d, 'Environment', 'e-stage')
    type(d, 'Label', 'app')
    type(d, 'Bind port', '8080')
    type(d, 'Target port', '80')
    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await flush()
    expect(calls(invoke, 'tunnel:create')[0][1]).toMatchObject({ hostId: 'h-web', environmentId: 'e-stage' })
  })

  it('exposed bind warns but still saves', async () => {
    const invoke = setup([], [], { 'tunnel:create': tunnelMeta({ id: 'new', bindAddress: '0.0.0.0' }) })
    const d = await newTunnel()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    type(d, 'Bind port', '5433')
    type(d, 'Target port', '5432')
    fireEvent.click(within(d).getByRole('button', { name: '0.0.0.0' }))
    expect(field(d, 'Bind address').value).toBe('0.0.0.0')
    expect(within(d).getByText('Anyone who can reach this machine on 0.0.0.0:5433 can use this tunnel')).toBeInTheDocument()
    fireEvent.click(within(d).getByRole('radio', { name: 'Remote' }))
    expect(within(d).getByText("Exposed on the server's network (needs GatewayPorts on the server)")).toBeInTheDocument()
    fireEvent.click(within(d).getByRole('radio', { name: 'Local' }))
    type(d, 'Bind port', '80')
    expect(within(d).getByText('Ports below 1024 need admin rights')).toBeInTheDocument()
    const save = within(d).getByRole('button', { name: 'Create tunnel' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await flush()
    expect(calls(invoke, 'tunnel:create')[0][1]).toMatchObject({ bindAddress: '0.0.0.0', bindPort: 80 })
  })

  it('duplicate bind port warns with the other tunnel\'s label', async () => {
    setup([tunnelMeta({ id: 't1', label: 'db replica', hostId: 'h-db', bindPort: 5433 })])
    const d = await newTunnel()
    type(d, 'Host', 'h-web')
    type(d, 'Bind port', '5433')
    expect(within(d).getByText('"db replica" uses the same port; they can\'t run at the same time')).toBeInTheDocument()
    type(d, 'Bind port', '5434')
    await settle()
    expect(within(d).queryByText(/uses the same port/)).not.toBeInTheDocument()
  })

  it('duplicate opens prefilled with a copy label and the next port, never starting on launch', async () => {
    const invoke = setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', environmentId: 'e-stage', bindPort: 5433, autoStart: true })], [], {
      'tunnel:create': tunnelMeta({ id: 't2', label: 'pg copy', bindPort: 5434 }),
    })
    await openMenu('pg', 'Duplicate')
    const d = dialog('Duplicate tunnel')
    expect(field(d, 'Label').value).toBe('pg copy')
    expect(field(d, 'Bind port').value).toBe('5434')
    expect(field(d, 'Environment').value).toBe('e-stage')
    expect(within(d).getByRole('switch', { name: 'Start on launch' })).toHaveAttribute('aria-checked', 'false')
    // The original's port is taken by the original, so no clash warning for the copy.
    expect(within(d).queryByText(/uses the same port/)).not.toBeInTheDocument()
    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await flush()
    expect(calls(invoke, 'tunnel:create')[0][1]).toEqual({
      label: 'pg copy',
      hostId: 'h-db',
      environmentId: 'e-stage',
      type: 'L',
      bindAddress: '127.0.0.1',
      bindPort: 5434,
      targetHost: 'localhost',
      targetPort: 5432,
      autoStart: false,
      autoReconnect: true,
    })
  })

  it('edit sends only changed fields and switching to SOCKS nulls the target', async () => {
    const before = tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', bindPort: 5433 })
    const invoke = setup([before], [], { 'tunnel:update': { ...before, label: 'pg main' } })
    await openMenu('pg', 'Edit')
    let d = dialog('Edit tunnel')
    expect(field(d, 'Label').value).toBe('pg')
    type(d, 'Label', 'pg main')
    fireEvent.click(within(d).getByRole('switch', { name: 'Start on launch' }))
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }))
    await flush()
    expect(calls(invoke, 'tunnel:update')).toEqual([['tunnel:update', 't1', { label: 'pg main', autoStart: true }]])
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Edit tunnel' })).not.toBeInTheDocument()

    tunnelStore.set({ ...tunnelStore.get(), tunnels: [before] })
    await flush()
    invoke.mockClear()
    await openMenu('pg', 'Edit')
    d = dialog('Edit tunnel')
    fireEvent.click(within(d).getByRole('radio', { name: 'SOCKS' }))
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }))
    await flush()
    expect(calls(invoke, 'tunnel:update')).toEqual([['tunnel:update', 't1', { type: 'D', targetHost: null, targetPort: null }]])
  })

  it('an edit with nothing changed just closes', async () => {
    const invoke = setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })])
    await openMenu('pg', 'Edit')
    fireEvent.click(within(dialog('Edit tunnel')).getByRole('button', { name: 'Save' }))
    await settle()
    expect(calls(invoke, 'tunnel:update')).toEqual([])
    expect(screen.queryByRole('dialog', { name: 'Edit tunnel' })).not.toBeInTheDocument()
  })

  it('editing a running tunnel\'s route shows the restart note', async () => {
    setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'up' })])
    await openMenu('pg', 'Edit')
    const d = dialog('Edit tunnel')
    type(d, 'Label', 'renamed')
    expect(within(d).queryByText('Saving restarts this tunnel')).not.toBeInTheDocument()
    type(d, 'Bind port', '6000')
    expect(within(d).getByText('Saving restarts this tunnel')).toBeInTheDocument()
    type(d, 'Bind port', '5433')
    await settle()
    expect(within(d).queryByText('Saving restarts this tunnel')).not.toBeInTheDocument()
  })

  it('a stopped tunnel never shows the restart note', async () => {
    setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'stopped' })])
    await openMenu('pg', 'Edit')
    const d = dialog('Edit tunnel')
    type(d, 'Bind port', '6000')
    expect(within(d).queryByText('Saving restarts this tunnel')).not.toBeInTheDocument()
  })

  it('store error shows inline', async () => {
    const invoke = setup()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'tunnel:create') throw new Error("Error invoking remote method 'tunnel:create': Error: bind address must be an IP address or localhost")
      return null
    })
    const d = await newTunnel()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    // An IPv6 shape the renderer accepts; only the store's net.isIP turns it down.
    type(d, 'Bind address', '1:2:3')
    type(d, 'Bind port', '5433')
    type(d, 'Target port', '5432')
    const address = field(d, 'Bind address')
    expect(address).not.toHaveAttribute('aria-invalid')
    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await settle()
    expect(calls(invoke, 'tunnel:create')).toHaveLength(1)
    expect(address).toHaveAttribute('aria-invalid', 'true')
    // The hint may still be fading out beside it under the same id.
    const said = [...document.querySelectorAll(`[id="${address.getAttribute('aria-describedby')}"]`)].map((m) => m.textContent)
    expect(said).toContain('bind address must be an IP address or localhost')
    expect(screen.queryByText("Couldn't create the tunnel")).not.toBeInTheDocument()
    expect(dialog('New tunnel')).toBeInTheDocument()
    type(d, 'Bind address', '127.0.0.2')
    expect(address).not.toHaveAttribute('aria-invalid')
  })

  it('a store error about no one field shows above the buttons', async () => {
    const invoke = setup()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'tunnel:create') throw new Error("Error invoking remote method 'tunnel:create': Error: too many tunnels (200)")
      return null
    })
    const d = await newTunnel()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    type(d, 'Bind port', '5433')
    type(d, 'Target port', '5432')
    fireEvent.click(within(d).getByRole('button', { name: 'Create tunnel' }))
    await settle()
    expect(calls(invoke, 'tunnel:create')).toHaveLength(1)
    expect(within(d).getByRole('alert')).toHaveTextContent('too many tunnels (200)')
    expect(d.querySelector('[aria-invalid="true"]')).toBeNull()
    expect(screen.queryByText("Couldn't create the tunnel")).not.toBeInTheDocument()
    type(d, 'Label', 'pg 2')
    expect(within(d).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter in a field submits the form', async () => {
    const invoke = setup([], [], { 'tunnel:create': tunnelMeta({ id: 'new', label: 'pg' }) })
    const d = await newTunnel()
    type(d, 'Label', 'pg')
    type(d, 'Host', 'h-db')
    type(d, 'Bind port', '5433')
    type(d, 'Target port', '5432')
    // jsdom has no implicit submission, so check what the browser uses for it: the footer's submit
    // button belongs to the same form as the field (through form=), and submitting that form creates.
    const form = (field(d, 'Target port') as HTMLInputElement).form!
    expect(form).not.toBeNull()
    const submit = within(d).getByRole('button', { name: 'Create tunnel' }) as HTMLButtonElement
    expect(submit.type).toBe('submit')
    expect(submit.form).toBe(form)
    fireEvent.submit(form)
    await settle()
    expect(calls(invoke, 'tunnel:create')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'New tunnel' })).not.toBeInTheDocument()
  })

  it('Escape closes and focus goes back to the button that opened it', async () => {
    const invoke = setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })])
    const trigger = screen.getAllByRole('button', { name: 'New tunnel' })[0]
    trigger.focus()
    fireEvent.click(trigger)
    await flush()
    const d = dialog('New tunnel')
    expect(field(d, 'Label')).toHaveFocus()
    fireEvent.keyDown(field(d, 'Label'), { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('dialog', { name: 'New tunnel' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(calls(invoke, 'tunnel:create')).toEqual([])
  })

  it('an edit of a tunnel that no longer exists closes with a note', async () => {
    setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })])
    await openMenu('pg', 'Edit')
    expect(dialog('Edit tunnel')).toBeInTheDocument()
    act(() => tunnelStore.set({ ...tunnelStore.get(), tunnels: [] }))
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Edit tunnel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'New tunnel' })).not.toBeInTheDocument()
    expect(screen.getByText('That tunnel no longer exists')).toBeInTheDocument()
  })

  it('no clash warning while the bind address is blank', async () => {
    setup([tunnelMeta({ id: 't1', label: 'db replica', hostId: 'h-db', bindPort: 5433 })])
    const d = await newTunnel()
    type(d, 'Bind address', '')
    type(d, 'Bind port', '5433')
    expect(within(d).queryByText(/uses the same port/)).not.toBeInTheDocument()
    type(d, 'Bind address', '127.0.0.1')
    expect(within(d).getByText(/uses the same port/)).toBeInTheDocument()
  })
})

describe('tunnel delete', () => {
  it('protected environment delete needs the typed name', async () => {
    const invoke = setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', environmentId: 'e-prod' })], [], { 'tunnel:delete': null })
    await openMenu('pg', 'Delete')
    const d = dialog('Delete pg?')
    const confirm = within(d).getByRole('button', { name: 'Delete tunnel' })
    expect(confirm).toBeDisabled()
    type(d, 'Type prod to confirm', 'pro')
    expect(confirm).toBeDisabled()
    type(d, 'Type prod to confirm', 'prod')
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await flush()
    expect(calls(invoke, 'tunnel:delete')).toEqual([['tunnel:delete', 't1']])
    expect(tunnelStore.get().tunnels).toEqual([])
  })

  it('unprotected delete is a plain confirm', async () => {
    const invoke = setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db', environmentId: 'e-stage' })], [], { 'tunnel:delete': null })
    await openMenu('pg', 'Delete')
    const d = dialog('Delete pg?')
    expect(within(d).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(d).queryByText(/stopped first/)).not.toBeInTheDocument()
    fireEvent.click(within(d).getByRole('button', { name: 'Delete tunnel' }))
    await flush()
    expect(calls(invoke, 'tunnel:delete')).toEqual([['tunnel:delete', 't1']])
  })

  it('deleting a running tunnel says it will be stopped first', async () => {
    setup([tunnelMeta({ id: 't1', label: 'pg', hostId: 'h-db' })], [tunnelRuntime({ id: 't1', state: 'up' })])
    await openMenu('pg', 'Delete')
    expect(within(dialog('Delete pg?')).getByText(/It will be stopped first/)).toBeInTheDocument()
  })
})
