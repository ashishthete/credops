import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, type InventoryData } from '../../src/renderer/src/inventory/store'
import { HostDialog } from '../../src/renderer/src/pages/hosts/HostDialog'
import { HostView } from '../../src/renderer/src/pages/hosts/HostView'
import { Toaster } from '../../src/renderer/src/ui/Toaster'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import type { HostMeta, ResolvedHost } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID, type IdentityMeta, type VaultMeta } from '../../src/shared/vault'
import { defaultVault, environment, host, mockBridge, vaultStatus } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const TS = '2026-10-16T09:00:00.000Z'
const identity = (over: Partial<IdentityMeta> & { id: string; label: string; vaultId: string }): IdentityMeta => ({
  username: over.label,
  auth: 'agent',
  sshKeyId: null,
  hasPassword: false,
  createdAt: TS,
  updatedAt: TS,
  ...over,
})
const vault = (id: string, name: string): VaultMeta => ({ ...defaultVault, id, name, isDefault: false })

const deploy = identity({ id: 'id-deploy', label: 'deploy', vaultId: DEFAULT_VAULT_ID, auth: 'key', hasPassword: true })

/** web-1 is an app host in prod (protected), behind bastion; staging is empty. */
function world(): InventoryData {
  return {
    products: [],
    environments: [
      environment({
        id: 'prod',
        name: 'prod',
        color: '#ef5b5b',
        protected: true,
        defaultPort: 2222,
        defaultIdentityId: 'id-deploy',
        defaultJumpHostId: 'bastion',
        hosts: [
          { hostId: 'web1', role: 'app' },
          { hostId: 'bastion', role: 'bastion' },
        ],
      }),
      environment({ id: 'staging', name: 'staging', color: '#f2a93b' }),
    ],
    hosts: [
      host({ id: 'web1', label: 'web-1', address: '10.0.0.5', tags: ['api'], environments: [{ environmentId: 'prod', role: 'app' }] }),
      host({ id: 'bastion', label: 'bastion', environments: [{ environmentId: 'prod', role: 'bastion' }] }),
    ],
    identities: [deploy],
    vaults: [defaultVault],
  }
}

const inProd: ResolvedHost = {
  hostId: 'web1',
  environmentId: 'prod',
  address: '10.0.0.5',
  port: { value: 2222, source: 'environment' },
  identity: { source: 'environment', identityId: 'id-deploy', label: 'deploy', username: 'deploy', auth: 'key', vaultId: DEFAULT_VAULT_ID },
  jump: { hostId: 'bastion', source: 'environment' },
  chain: [
    {
      hostId: 'bastion',
      label: 'bastion',
      address: 'bastion.example.com',
      port: 2222,
      identity: { source: 'environment', identityId: 'id-deploy', label: 'deploy', username: 'deploy', auth: 'key', vaultId: DEFAULT_VAULT_ID },
    },
  ],
  conflicts: [],
}
const outside: ResolvedHost = {
  hostId: 'web1',
  environmentId: null,
  address: '10.0.0.5',
  port: { value: 22, source: 'global' },
  identity: { source: 'global', username: 'tester', auth: 'default' },
  jump: { hostId: null, source: null },
  chain: [],
  conflicts: [],
}

function setup(data: InventoryData = world(), resolve: (hostId: string, envId?: string) => Promise<ResolvedHost> = async (_h, e) => (e ? inProd : outside), corrupt: string[] = []) {
  const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true, corruptVaultIds: corrupt }) })
  const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'host:resolve':
        return resolve(args[0] as string, args[1] as string | undefined)
      case 'host:list':
        return data.hosts
      case 'env:list':
        return data.environments
      case 'host:update': {
        const [id, patch] = args as [string, Partial<HostMeta>]
        const h = { ...data.hosts.find((x) => x.id === id)!, ...patch }
        data.hosts = data.hosts.map((x) => (x.id === id ? h : x))
        return h
      }
      case 'host:create':
        return host({ id: 'new-host', ...(args[0] as { label: string }) })
      case 'env:putHost': {
        const [envId, hostId, role] = args as [string, string, 'app']
        data.environments = data.environments.map((e) =>
          e.id === envId ? { ...e, hosts: [...e.hosts.filter((m) => m.hostId !== hostId), { hostId, role }] } : e,
        )
        data.hosts = data.hosts.map((h) =>
          h.id === hostId ? { ...h, environments: [...h.environments.filter((m) => m.environmentId !== envId), { environmentId: envId, role }] } : h,
        )
        return data.environments.find((e) => e.id === envId)
      }
      case 'env:removeHost': {
        const [envId, hostId] = args as [string, string]
        data.environments = data.environments.map((e) => (e.id === envId ? { ...e, hosts: e.hosts.filter((m) => m.hostId !== hostId) } : e))
        data.hosts = data.hosts.map((h) => (h.id === hostId ? { ...h, environments: h.environments.filter((m) => m.environmentId !== envId) } : h))
        return data.environments.find((e) => e.id === envId)
      }
      case 'host:setVaults': {
        const [id, vaultIds] = args as [string, string[]]
        data.hosts = data.hosts.map((x) => (x.id === id ? { ...x, vaultIds } : x))
        return data.hosts.find((x) => x.id === id)
      }
      case 'host:delete':
        return null
    }
    return base(channel, ...args)
  })
  vaultStatusStore.set(vaultStatus({ unlocked: true, corruptVaultIds: corrupt }))
  inventoryStore.set(structuredClone(data))
  return invoke
}

const card = () => screen.getByRole('region', { name: 'Connection' })
const row = (term: string) => within(card()).getByRole('group', { name: term })

beforeEach(() => {
  motion.safe = true
  inventoryStore.set(null)
})

describe('HostView', () => {
  it('connection card shows sources', async () => {
    setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    expect(await within(card()).findByText('2222')).toBeInTheDocument()
    expect(within(row('Port')).getByText('Inherited from prod')).toBeInTheDocument()
    expect(within(row('User')).getByText('deploy')).toBeInTheDocument()
    expect(within(row('Jump via')).getByRole('list', { name: 'bastion → web-1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'web-1', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument()
  })

  it('context switch re-resolves', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    expect(within(card()).getByRole('radio', { name: 'prod' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(card()).getByRole('radio', { name: 'Outside any environment' }))
    await waitFor(() => expect((invoke.mock.calls as unknown[][]).some((c) => c[0] === 'host:resolve' && c.length === 2 && c[1] === 'web1')).toBe(true))
    expect(await within(row('Port')).findByText('22')).toBeInTheDocument()
    expect(within(row('Port')).getByText('App default')).toBeInTheDocument()
    await waitFor(() => expect(within(card()).queryByText('2222')).not.toBeInTheDocument())
  })

  it('values cross-fade with a slide', async () => {
    const user = userEvent.setup()
    setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    await user.click(within(card()).getByRole('radio', { name: 'Outside any environment' }))
    const value = await within(row('Port')).findByText('22')
    expect(value.closest('[data-value]')!.getAttribute('style')).toMatch(/transform/)
  })

  it('reduced motion cross-fades opacity only', async () => {
    motion.safe = false
    const user = userEvent.setup()
    setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    await user.click(within(card()).getByRole('radio', { name: 'Outside any environment' }))
    const value = await within(row('Port')).findByText('22')
    expect(value.closest('[data-value]')!.getAttribute('style') ?? '').not.toMatch(/transform/)
  })

  it('re-resolves when a hop changes, not for unrelated hosts', async () => {
    const data = world()
    data.hosts.push(host({ id: 'other', label: 'other' }))
    const invoke = setup(data)
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    const resolves = () => invoke.mock.calls.filter((c) => c[0] === 'host:resolve').length
    const before = resolves()
    const edit = (id: string, patch: Partial<HostMeta>) =>
      act(() => {
        const d = inventoryStore.get()!
        inventoryStore.set({ ...d, hosts: d.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)) })
      })
    edit('other', { port: 2000 })
    expect(resolves()).toBe(before)
    edit('bastion', { port: 2022 })
    await waitFor(() => expect(resolves()).toBe(before + 1))
  })

  it('conflict warning', async () => {
    setup(world(), async () => ({ ...outside, conflicts: [{ field: 'identity', environmentIds: ['prod', 'staging'] }] }))
    render(<HostView hostId="web1" />)
    expect(await screen.findByText('Environments disagree on the identity. Set it on this host.')).toBeInTheDocument()
  })

  it('jump host conflicts say "jump host"', async () => {
    setup(world(), async () => ({ ...outside, conflicts: [{ field: 'jumpHost', environmentIds: ['prod', 'staging'] }] }))
    render(<HostView hostId="web1" />)
    expect(await screen.findByText('Environments disagree on the jump host. Set it on this host.')).toBeInTheDocument()
  })

  it('resolve error is contained', async () => {
    setup(world(), async () => {
      throw new Error("Error invoking remote method 'host:resolve': Error: jump host loop: A → B → A")
    })
    render(<HostView hostId="web1" environmentId="prod" />)
    expect(await screen.findByText('jump host loop: A → B → A')).toBeInTheDocument()
    expect(screen.getByText(/Change the jump host on B/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'web-1', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Environments' })).toBeInTheDocument()
  })

  it('role change and add to environment', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role in prod' }), 'bastion')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'prod', 'web1', 'bastion'))
    await user.click(screen.getByRole('button', { name: 'Add to environment…' }))
    expect(screen.queryByRole('menuitem', { name: /prod/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /staging/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'web1', 'other'))
    expect(await screen.findByRole('combobox', { name: 'Role in staging' })).toBeInTheDocument()
  })

  it('removing from a protected environment types its name', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    render(
      <>
        <HostView hostId="web1" environmentId="prod" />
        <Toaster />
      </>,
    )
    await user.click(await screen.findByRole('button', { name: 'Remove web-1 from prod' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove web-1 from prod?' })
    const confirm = within(dialog).getByRole('button', { name: 'Remove host' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod')
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:removeHost', 'prod', 'web1'))
  })

  it('delete confirms, typing the name when in a protected environment', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    const onDeleted = vi.fn()
    render(<HostView hostId="web1" environmentId="prod" onDeleted={onDeleted} />)
    await user.click(await screen.findByRole('button', { name: 'web-1 options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete web-1?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete host' })
    expect(confirm).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('host:delete', 'web1')
    await user.type(within(dialog).getByLabelText('Type web-1 to confirm'), 'web-1')
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:delete', 'web1'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('links a vault', async () => {
    const user = userEvent.setup()
    const data = world()
    data.vaults = [defaultVault, vault('ops', 'Ops')]
    const invoke = setup(data)
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'Link vault' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Ops' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:setVaults', 'web1', ['ops']))
  })

  it('never renders a secret', async () => {
    setup()
    const { container } = render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    expect(within(row('User')).getByText(/deploy, SSH key/)).toBeInTheDocument()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(container.textContent).not.toMatch(/passphrase|hasPassword/i)
  })

  it('edit to inherit', async () => {
    const user = userEvent.setup()
    const data = world()
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, port: 2200 } : h))
    const invoke = setup(data)
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit host' })
    const port = within(dialog).getByLabelText('Port')
    expect(port).toHaveValue('2200')
    await user.clear(port)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { port: null }))
  })
})

describe('HostDialog', () => {
  const noop = () => {}

  it('identity picker lists linked vaults first', () => {
    const data = world()
    data.vaults = [defaultVault, vault('ops', 'Ops'), vault('broken', 'Broken')]
    data.identities = [
      identity({ id: 'id-def', label: 'root', vaultId: DEFAULT_VAULT_ID }),
      identity({ id: 'id-ops', label: 'ops-deploy', vaultId: 'ops' }),
      identity({ id: 'id-broken', label: 'lost', vaultId: 'broken' }),
    ]
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, vaultIds: ['ops'] } : h))
    setup(data, undefined, ['broken'])
    render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
    const select = screen.getByRole('combobox', { name: 'Identity' })
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Linked vaults', 'Other vaults'])
    const values = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(values).toEqual(['', 'id-ops', 'id-def'])
    expect(select.querySelector('option')!.textContent).toBe('Inherit (Inherited from prod)')
  })

  it('jump picker excludes self and loops', () => {
    const data = world()
    data.hosts = [host({ id: 'A', label: 'a', jumpHostId: 'B' }), host({ id: 'B', label: 'b' }), host({ id: 'C', label: 'c' })]
    setup(data)
    render(<HostDialog open host={data.hosts[1]} onClose={noop} onSaved={noop} />)
    const select = screen.getByRole('combobox', { name: 'Jump host' })
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'C'])
    expect(select.querySelector('option')!.textContent).toMatch(/^Inherit/)
  })

  it('create from an environment', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    const onSaved = vi.fn()
    render(<HostDialog open presetEnvironment={{ environmentId: 'prod', role: 'db' }} onClose={noop} onSaved={onSaved} />)
    const dialog = screen.getByRole('dialog', { name: 'New host' })
    await user.type(within(dialog).getByLabelText('Label'), 'db-2')
    await user.type(within(dialog).getByLabelText('Address'), '10.0.0.9')
    await user.click(within(dialog).getByRole('button', { name: 'Create host' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('host:create', {
        label: 'db-2',
        address: '10.0.0.9',
        port: null,
        identityId: null,
        jumpHostId: null,
        tags: [],
        osIcon: 'linux',
        notes: '',
        vaultIds: [DEFAULT_VAULT_ID],
        environments: [{ environmentId: 'prod', role: 'db' }],
      }),
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('tags: Enter or comma adds, Backspace removes', async () => {
    const user = userEvent.setup()
    setup()
    render(<HostDialog open onClose={noop} onSaved={noop} />)
    const input = screen.getByLabelText('Tags')
    await user.type(input, 'api{Enter}edge,')
    expect(screen.getByRole('button', { name: 'Remove tag api' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove tag edge' })).toBeInTheDocument()
    await user.type(input, '{Backspace}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove tag edge' })).not.toBeInTheDocument())
    await user.type(input, 'bad tag{Enter}')
    expect(screen.getByText(/Tags use letters, numbers/)).toBeInTheDocument()
  })
})
