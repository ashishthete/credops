import { act, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, type InventoryData } from '../../src/renderer/src/inventory/store'
import { HostDialog } from '../../src/renderer/src/pages/hosts/HostDialog'
import { HostView } from '../../src/renderer/src/pages/hosts/HostView'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { Toaster } from '../../src/renderer/src/ui/Toaster'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import type { HostMeta, ResolvedHost } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID, type IdentityMeta, type SshKeyMeta, type VaultMeta } from '../../src/shared/vault'
import { defaultVault, environment, host, mockBridge, tunnelMeta, tunnelRuntime, vaultStatus } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))


// Opening a session is the terminal store's job; these tests only care what it is asked for.
const sessions = vi.hoisted(() => ({ openSsh: vi.fn(), openLocal: vi.fn() }))
vi.mock('../../src/renderer/src/terminal/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/terminal/sessions')>()),
  openSsh: sessions.openSsh,
  openLocal: sessions.openLocal,
}))

let where = ''
function Location() {
  where = useLocation().pathname
  return null
}
const Router = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/products']}>
    {children}
    <Location />
  </MemoryRouter>
)
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: Router })

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
  resetTunnels()
  where = ''
  sessions.openSsh.mockReset().mockResolvedValue('s1')
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

  it('switching context dims until it resolves and clears an error', async () => {
    const user = userEvent.setup()
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    setup(world(), async (_h, e) => {
      if (e) throw new Error('environment not found')
      await gate
      return outside
    })
    render(<HostView hostId="web1" environmentId="prod" />)
    expect(await screen.findByText('environment not found')).toBeInTheDocument()
    await user.click(within(card()).getByRole('radio', { name: 'Outside any environment' }))
    expect(screen.queryByText('environment not found')).not.toBeInTheDocument()
    expect(card()).toHaveAttribute('aria-busy', 'true')
    await act(async () => release())
    expect(await within(row('Port')).findByText('22')).toBeInTheDocument()
    expect(card()).not.toHaveAttribute('aria-busy')
  })

  it('recovers from a resolve error when the inventory changes', async () => {
    let broken = true
    setup(world(), async () => {
      if (broken) throw new Error('jump host loop: web-1 → bastion → web-1')
      return inProd
    })
    render(<HostView hostId="web1" environmentId="prod" />)
    expect(await screen.findByText('jump host loop: web-1 → bastion → web-1')).toBeInTheDocument()
    broken = false
    act(() => {
      const d = inventoryStore.get()!
      inventoryStore.set({ ...d, hosts: d.hosts.map((h) => (h.id === 'bastion' ? { ...h, jumpHostId: null, port: 2201 } : h)) })
    })
    expect(await within(card()).findByText('2222')).toBeInTheDocument()
    expect(screen.queryByText(/jump host loop/)).not.toBeInTheDocument()
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
    const unlink = await screen.findByRole('button', { name: 'Remove web-1 from prod' })
    // Reads "Unlink" in plain text, visible without hovering.
    expect(unlink).toHaveTextContent('Unlink')
    expect(unlink.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    await user.click(unlink)
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
    expect(dialog).not.toHaveTextContent(/connect directly|jump host for/)
    const confirm = within(dialog).getByRole('button', { name: 'Delete host' })
    expect(confirm).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('host:delete', 'web1')
    await user.type(within(dialog).getByLabelText('Type web-1 to confirm'), 'web-1')
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:delete', 'web1'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('delete is blocked while other hosts or environments jump through it', async () => {
    const user = userEvent.setup()
    const data = world()
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, jumpHostId: 'bastion' } : h))
    const invoke = setup(data)
    render(<HostView hostId="bastion" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'bastion options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete bastion?' })
    expect(dialog).toHaveTextContent('bastion is the jump host for web-1 and the defaults of prod. Change those first.')
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete host' })
    expect(confirm).toBeDisabled()
    await user.click(confirm)
    expect(invoke).not.toHaveBeenCalledWith('host:delete', 'bastion')
  })

  it('menus move with Home and End', async () => {
    const user = userEvent.setup()
    setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'web-1 options' }))
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'web-1 options' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Link vault' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Default' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Default' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Link vault' })).toHaveFocus()
  })

  it('picking the last environment hands focus to the list', async () => {
    const user = userEvent.setup()
    const invoke = setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'Add to environment…' }))
    await user.keyboard('{End}')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'web1', 'other'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to environment…' })).not.toBeInTheDocument())
    expect(screen.getByRole('list', { name: 'Environments' })).toHaveFocus()
  })

  it('vault toggles apply in order, each on the last result', async () => {
    const user = userEvent.setup()
    const data = world()
    data.vaults = [defaultVault, vault('ops', 'Ops'), vault('lab', 'Lab')]
    const invoke = setup(data)
    const run = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    invoke.mockImplementation(async (c: string, ...a: unknown[]) => (c === 'host:setVaults' ? gate.then(() => run(c, ...a)) : run(c, ...a)))
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'Link vault' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Ops' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Lab' }))
    await act(async () => release())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:setVaults', 'web1', ['ops', 'lab']))
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
    const SECRET = 'hunter2-S3CRET-do-not-show'
    const data = world()
    // A meta row that somehow carried a secret field must still never reach the screen.
    data.identities = [{ ...deploy, password: SECRET, passphrase: SECRET } as IdentityMeta]
    const leaky = { ...inProd, identity: { ...inProd.identity, password: SECRET } as unknown as ResolvedHost['identity'] }
    setup(data, async () => leaky)
    const { container } = render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    expect(within(row('User')).getByText(/deploy, SSH key/)).toBeInTheDocument()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(container.textContent).not.toMatch(/passphrase|hasPassword/i)
    expect(document.body.innerHTML).not.toContain(SECRET)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('dialog', { name: 'Edit host' })
    expect(document.body.innerHTML).not.toContain(SECRET)
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

describe('Change login', () => {
  const sshKey = (over: Partial<SshKeyMeta> & { id: string; label: string; vaultId: string }): SshKeyMeta => ({
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAA',
    fingerprint: 'SHA256:abc',
    source: 'generated',
    filePath: null,
    hasPassphrase: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  })

  /** setup() plus identity and key IPC; created identities land in the data so a reload sees them. */
  function setupLogin(data: InventoryData = world(), keys: SshKeyMeta[] = [], resolved: ResolvedHost = outside) {
    const invoke = setup(data, async () => resolved)
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'key:list':
          return keys
        case 'identity:list':
          return data.identities
        case 'identity:create': {
          const input = args[0] as IdentityMeta & { password?: string }
          const row = identity({ id: 'id-new', label: input.label, vaultId: input.vaultId, username: input.username, auth: input.auth, sshKeyId: input.sshKeyId ?? null, hasPassword: !!input.password })
          data.identities = [...data.identities, row]
          return row
        }
        case 'key:scanLocal':
          return [{ path: '/home/tester/.ssh/id_work', keyType: 'ssh-ed25519', fingerprint: 'SHA256:work', encrypted: false, alreadyLinked: false }]
        case 'key:link': {
          const k = sshKey({ id: 'k-linked', label: (args[0] as { label: string }).label, vaultId: (args[0] as { vaultId: string }).vaultId, source: 'file', filePath: '/home/tester/.ssh/id_work' })
          keys = [...keys, k]
          return k
        }
      }
      return base(channel, ...args)
    })
    return invoke
  }

  const openChange = async (user: ReturnType<typeof userEvent.setup>) => {
    await within(row('User')).findByRole('button', { name: 'Change' })
    await user.click(within(row('User')).getByRole('button', { name: 'Change' }))
    return screen.findByRole('dialog', { name: 'Change login' })
  }

  it('names the default chain plainly and credits ~/.ssh/config for the user', async () => {
    setup(world(), async () => ({ ...outside, identity: { source: 'global', username: 'ubuntu', auth: 'default', userSource: 'ssh-config' } }))
    render(<HostView hostId="web1" />)
    expect(await within(row('User')).findByText('ubuntu')).toBeInTheDocument()
    expect(within(row('User')).getByText('From ~/.ssh/config')).toBeInTheDocument()
    expect(within(row('User')).getByText('Your SSH keys (agent, then ~/.ssh keys)')).toBeInTheDocument()
  })

  it('without ~/.ssh/config the user is the app default', async () => {
    setup()
    render(<HostView hostId="web1" />)
    expect(await within(row('User')).findByText('tester')).toBeInTheDocument()
    expect(within(row('User')).getByText('App default')).toBeInTheDocument()
  })

  it('saves your SSH keys as a new identity in the Default vault and sets it on the host', async () => {
    const user = userEvent.setup()
    const invoke = setupLogin()
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    const name = within(dialog).getByLabelText('Username')
    expect(name).toHaveValue('tester')
    expect(within(dialog).getByRole('radio', { name: 'Your SSH keys (default)' })).toBeChecked()
    await user.clear(name)
    await user.type(name, 'ubuntu')
    await user.click(within(dialog).getByRole('button', { name: 'Save login' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('identity:create', { vaultId: DEFAULT_VAULT_ID, label: 'ubuntu', username: 'ubuntu', auth: 'agent' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { identityId: 'id-new' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change login' })).not.toBeInTheDocument())
    expect(inventoryStore.get()!.identities.some((i) => i.id === 'id-new')).toBe(true)
  })

  it("reuses a matching identity in the host's vault", async () => {
    const user = userEvent.setup()
    const data = world()
    const team = vault('team', 'Team')
    data.vaults = [defaultVault, team]
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, vaultIds: ['team'] } : h))
    // Same username and method, but in the Default vault: not the host's vault, so not a match.
    data.identities = [...data.identities, identity({ id: 'id-elsewhere', label: 'tester', vaultId: DEFAULT_VAULT_ID, username: 'tester' }), identity({ id: 'id-team', label: 'tester', vaultId: 'team', username: 'tester' })]
    const invoke = setupLogin(data)
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    await user.click(within(dialog).getByRole('button', { name: 'Save login' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { identityId: 'id-team' }))
    expect(invoke).not.toHaveBeenCalledWith('identity:create', expect.anything())
  })

  it('a key in a vault: picks an existing key', async () => {
    const user = userEvent.setup()
    const invoke = setupLogin(world(), [sshKey({ id: 'k1', label: 'deploy key', vaultId: DEFAULT_VAULT_ID }), sshKey({ id: 'k2', label: 'other vault', vaultId: 'team' })])
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    await user.click(within(dialog).getByRole('radio', { name: 'A key in a vault' }))
    const save = within(dialog).getByRole('button', { name: 'Save login' })
    expect(save).toBeDisabled()
    const keySelect = await within(dialog).findByLabelText('SSH key')
    await waitFor(() => expect(within(keySelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick a key…', 'deploy key · ssh-ed25519']))
    await user.selectOptions(keySelect, 'k1')
    await user.click(save)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('identity:create', { vaultId: DEFAULT_VAULT_ID, label: 'tester · deploy key', username: 'tester', auth: 'key', sshKeyId: 'k1' }),
    )
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { identityId: 'id-new' }))
  })

  it('a key in a vault: Link key file… comes back with the new key picked', async () => {
    const user = userEvent.setup()
    setupLogin()
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    await user.click(within(dialog).getByRole('radio', { name: 'A key in a vault' }))
    expect(within(dialog).getByRole('button', { name: 'Import key file…' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Link key file…' }))
    const link = await screen.findByRole('dialog', { name: 'Link from ~/.ssh' })
    await user.click(await within(link).findByRole('radio', { name: /id_work/ }))
    await user.click(within(link).getByRole('button', { name: 'Link key' }))
    const back = await screen.findByRole('dialog', { name: 'Change login' })
    await waitFor(() => expect(within(back).getByLabelText('SSH key')).toHaveValue('k-linked'))
    expect(within(back).getByLabelText('Username')).toHaveValue('tester')
  })

  it('password: creates a password identity and never shows the password again', async () => {
    const user = userEvent.setup()
    const invoke = setupLogin()
    render(<HostView hostId="web1" />)
    let dialog = await openChange(user)
    await user.click(within(dialog).getByRole('radio', { name: 'Password' }))
    const save = within(dialog).getByRole('button', { name: 'Save login' })
    expect(save).toBeDisabled()
    const field = within(dialog).getByLabelText('Password', { selector: 'input' })
    expect(field).toHaveAttribute('type', 'password')
    await user.type(field, 'hunter2')
    await user.click(save)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('identity:create', { vaultId: DEFAULT_VAULT_ID, label: 'tester@web-1', username: 'tester', auth: 'password', password: 'hunter2' }),
    )
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { identityId: 'id-new' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change login' })).not.toBeInTheDocument())
    expect(document.body.textContent).not.toContain('hunter2')
    dialog = await openChange(user)
    await user.click(within(dialog).getByRole('radio', { name: 'Password' }))
    expect(within(dialog).getByLabelText('Password', { selector: 'input' })).toHaveValue('')
  })

  const pwIdentity = identity({ id: 'id-pw', label: 'tester@web-1', vaultId: DEFAULT_VAULT_ID, username: 'tester', auth: 'password', hasPassword: true })
  const ownPw: ResolvedHost = {
    ...outside,
    identity: { source: 'host', identityId: 'id-pw', label: 'tester@web-1', username: 'tester', auth: 'password', vaultId: DEFAULT_VAULT_ID },
  }
  const typePassword = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
    await user.type(within(dialog).getByLabelText('Password', { selector: 'input' }), 'n3w')
    await user.click(within(dialog).getByRole('button', { name: 'Save login' }))
  }

  it("re-seals the host's own, unshared password identity", async () => {
    const user = userEvent.setup()
    const data = world()
    data.identities = [...data.identities, pwIdentity]
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, identityId: 'id-pw' } : h))
    const invoke = setupLogin(data, [], ownPw)
    invoke.mockImplementation(
      ((impl) => async (channel: string, ...args: unknown[]) => (channel === 'identity:update' ? pwIdentity : impl(channel, ...args)))(
        invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>,
      ),
    )
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    expect(within(dialog).getByRole('radio', { name: 'Password' })).toBeChecked()
    await typePassword(user, dialog)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('identity:update', 'id-pw', { password: 'n3w' }))
    expect(invoke).not.toHaveBeenCalledWith('identity:create', expect.anything())
  })

  it('never re-seals a password identity another host or an environment also uses', async () => {
    for (const share of ['host', 'environment', 'unused'] as const) {
      const user = userEvent.setup()
      const data = world()
      data.identities = [...data.identities, pwIdentity]
      // 'unused': same label, but web-1 doesn't use it.
      if (share !== 'unused') data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, identityId: 'id-pw' } : h))
      if (share === 'host') data.hosts = data.hosts.map((h) => (h.id === 'bastion' ? { ...h, identityId: 'id-pw' } : h))
      if (share === 'environment') data.environments = data.environments.map((e) => (e.id === 'staging' ? { ...e, defaultIdentityId: 'id-pw' } : e))
      const invoke = setupLogin(data, [], share === 'unused' ? outside : ownPw)
      const view = render(<HostView hostId="web1" />)
      const dialog = await openChange(user)
      await user.click(within(dialog).getByRole('radio', { name: 'Password' }))
      await typePassword(user, dialog)
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { identityId: 'id-new' }))
      expect(invoke).toHaveBeenCalledWith('identity:create', expect.objectContaining({ auth: 'password', password: 'n3w' }))
      expect(invoke).not.toHaveBeenCalledWith('identity:update', expect.anything(), expect.anything())
      view.unmount()
    }
  })

  it('the method radios are one tab stop, move with arrow keys and describe themselves', async () => {
    const user = userEvent.setup()
    setupLogin()
    render(<HostView hostId="web1" />)
    const dialog = await openChange(user)
    const radios = within(dialog).getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
    expect(radios[0]).toHaveAccessibleDescription('ssh-agent, then the keys in ~/.ssh, like ssh does.')
    radios[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(radios[1]).toHaveFocus()
    expect(radios[1]).toBeChecked()
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(radios[2]).toHaveFocus()
    expect(radios[2]).toBeChecked()
  })

  it('Change says it opens a dialog', async () => {
    setupLogin()
    render(<HostView hostId="web1" />)
    await within(row('User')).findByText('tester')
    expect(within(row('User')).getByRole('button', { name: 'Change' })).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('warns that saving replaces an inherited login', async () => {
    const user = userEvent.setup()
    setupLogin(world(), [], inProd)
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    await user.click(within(row('User')).getByRole('button', { name: 'Change' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change login' })
    expect(within(dialog).getByText("web-1 will stop using prod's default login.")).toBeInTheDocument()
  })

  it('prefills the method from an identity the host already uses', async () => {
    const user = userEvent.setup()
    setupLogin(world(), [], inProd)
    render(<HostView hostId="web1" environmentId="prod" />)
    await within(card()).findByText('2222')
    await user.click(within(row('User')).getByRole('button', { name: 'Change' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change login' })
    expect(within(dialog).getByLabelText('Username')).toHaveValue('deploy')
    expect(within(dialog).getByRole('radio', { name: 'A key in a vault' })).toBeChecked()
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

  it('inherit labels follow the context, and go plain when environments disagree', () => {
    const data = world()
    data.environments = data.environments.map((e) =>
      e.id === 'staging' ? { ...e, defaultIdentityId: null, defaultPort: 2300, hosts: [{ hostId: 'web1', role: 'app' }] } : e,
    )
    data.hosts = data.hosts.map((h) =>
      h.id === 'web1' ? { ...h, environments: [...h.environments, { environmentId: 'staging', role: 'app' }] } : h,
    )
    setup(data)
    const { rerender } = render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
    const identityInherit = () => screen.getByRole('combobox', { name: 'Identity' }).querySelector('option')!.textContent
    expect(identityInherit()).toBe('Inherit')
    expect(screen.getByLabelText('Port')).toHaveAttribute('placeholder', '')
    rerender(<HostDialog open host={data.hosts[0]} contextEnvironmentId="staging" onClose={noop} onSaved={noop} />)
    expect(identityInherit()).toBe('Inherit (App default)')
    expect(screen.getByLabelText('Port')).toHaveAttribute('placeholder', '2300')
    rerender(<HostDialog open host={data.hosts[0]} contextEnvironmentId="prod" onClose={noop} onSaved={noop} />)
    expect(identityInherit()).toBe('Inherit (Inherited from prod)')
    expect(screen.getByLabelText('Port')).toHaveAttribute('placeholder', '2222')
  })

  it('edits only send what the user changed since opening', async () => {
    const user = userEvent.setup()
    const data = world()
    const invoke = setup(data)
    render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
    // Someone else renames the host while the dialog is open.
    act(() => {
      const d = inventoryStore.get()!
      inventoryStore.set({ ...d, hosts: d.hosts.map((h) => (h.id === 'web1' ? { ...h, label: 'web-1-renamed' } : h)) })
    })
    await user.type(screen.getByLabelText('Port'), '2201')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { port: 2201 }))
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
        keepaliveSec: null,
        envVars: {},
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

  it('HostView connect in env context opens ssh with environmentId and navigates', async () => {
    const user = userEvent.setup()
    setup()
    render(<HostView hostId="web1" environmentId="prod" />)
    await user.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(where).toBe('/terminals'))
    expect(sessions.openSsh).toHaveBeenCalledWith('web1', 'prod')
  })

  it('HostView connect outside any environment passes none, and a failed open stays put', async () => {
    const user = userEvent.setup()
    setup()
    sessions.openSsh.mockResolvedValue(undefined)
    render(<HostView hostId="web1" />)
    await user.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(sessions.openSsh).toHaveBeenCalledWith('web1', undefined))
    await act(async () => {})
    expect(where).toBe('/products')
  })

  it.each([
    [null, '30 s (default)'],
    [45, '45 s'],
    [0, 'off'],
  ])('connection card shows the effective keepalive %s', async (keepaliveSec, text) => {
    const data = world()
    data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, keepaliveSec } : h))
    setup(data)
    render(<HostView hostId="web1" />)
    expect(await within(row('Keepalive')).findByText(text)).toBeInTheDocument()
  })

  describe('HostDialog advanced', () => {
    const noop = () => {}
    const open = async (user: ReturnType<typeof userEvent.setup>) => {
      const dialog = screen.getByRole('dialog', { name: 'Edit host' })
      const toggle = within(dialog).getByRole('button', { name: 'Advanced' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await user.click(toggle)
      return dialog
    }

    it('HostDialog advanced edits keepalive and env vars and patches only changed fields', async () => {
      const user = userEvent.setup()
      const data = world()
      data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, envVars: { LANG: 'C' } } : h))
      const invoke = setup(data)
      render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
      const dialog = await open(user)
      expect(within(dialog).getByText("Sent to the server at login. Don't put secrets here.")).toBeInTheDocument()
      expect(within(dialog).getByLabelText('Variable name 1')).toHaveValue('LANG')
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Keepalive' }), 'custom')
      await user.type(within(dialog).getByLabelText('Seconds'), '60')
      await user.click(within(dialog).getByRole('button', { name: 'Add variable' }))
      await user.type(within(dialog).getByLabelText('Variable name 2'), 'EDITOR')
      await user.type(within(dialog).getByLabelText('Variable value 2'), 'vim')
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { keepaliveSec: 60, envVars: { EDITOR: 'vim', LANG: 'C' } }))
    })

    it('off and removing a variable are saved; untouched advanced fields send nothing', async () => {
      const user = userEvent.setup()
      const data = world()
      data.hosts = data.hosts.map((h) => (h.id === 'web1' ? { ...h, envVars: { LANG: 'C' }, keepaliveSec: 15 } : h))
      const invoke = setup(data)
      render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
      const dialog = await open(user)
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Keepalive' }), 'off')
      await user.click(within(dialog).getByRole('button', { name: 'Remove variable 1' }))
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:update', 'web1', { keepaliveSec: 0, envVars: {} }))
    })

    it('env var name error shows inline and blocks save', async () => {
      const user = userEvent.setup()
      const invoke = setup()
      const data = world()
      render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
      const dialog = await open(user)
      await user.click(within(dialog).getByRole('button', { name: 'Add variable' }))
      await user.type(within(dialog).getByLabelText('Variable name 1'), '1BAD NAME')
      await user.type(within(dialog).getByLabelText('Variable value 1'), 'hunter2')
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent('an env var name is invalid')
      expect(alert).not.toHaveTextContent('BAD')
      expect(alert).not.toHaveTextContent('hunter2')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
      await user.clear(within(dialog).getByLabelText('Variable name 1'))
      await user.type(within(dialog).getByLabelText('Variable name 1'), 'GOOD')
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
      expect(invoke).not.toHaveBeenCalledWith('host:update', expect.anything(), expect.anything())
    })

    it('rejects duplicate names, bad values and a keepalive out of range without echoing them', async () => {
      const user = userEvent.setup()
      setup()
      const data = world()
      render(<HostDialog open host={data.hosts[0]} onClose={noop} onSaved={noop} />)
      const dialog = await open(user)
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Keepalive' }), 'custom')
      await user.type(within(dialog).getByLabelText('Seconds'), '9000')
      expect(await within(dialog).findByText('keepalive must be 1-3600 seconds')).toBeInTheDocument()
      await user.clear(within(dialog).getByLabelText('Seconds'))
      await user.type(within(dialog).getByLabelText('Seconds'), '20')
      const add = within(dialog).getByRole('button', { name: 'Add variable' })
      await user.click(add)
      await user.click(add)
      await user.type(within(dialog).getByLabelText('Variable name 1'), 'DUP')
      await user.type(within(dialog).getByLabelText('Variable name 2'), 'DUP')
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('an env var name is used more than once')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
      await user.clear(within(dialog).getByLabelText('Variable name 2'))
      await user.type(within(dialog).getByLabelText('Variable name 2'), 'OTHER')
      fireEvent.change(within(dialog).getByLabelText('Variable value 2'), { target: { value: 'a\u200Bb' } })
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('an env var value has control or format characters')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    })
  })

  describe('host tunnels', () => {
    const tunnels = () => screen.getByRole('region', { name: 'Tunnels' })

    it('HostView lists host tunnels with toggles', async () => {
      const user = userEvent.setup()
      const invoke = setup()
      tunnelStore.set({
        tunnels: [
          tunnelMeta({ id: 't-pg', label: 'pg', hostId: 'web1' }),
          tunnelMeta({ id: 't-proxy', label: 'proxy', hostId: 'web1', type: 'D', bindPort: 1080, targetHost: null, targetPort: null }),
          tunnelMeta({ id: 't-other', label: 'elsewhere', hostId: 'bastion' }),
        ],
        runtime: { 't-pg': tunnelRuntime({ id: 't-pg', state: 'up' }) },
        loaded: true,
      })
      render(<HostView hostId="web1" />)
      const rows = within(tunnels()).getAllByRole('listitem')
      expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['pg', 'proxy'])
      expect(within(rows[0]).getByText('127.0.0.1:5433 → localhost:5432')).toBeInTheDocument()
      expect(within(rows[1]).getByText('SOCKS on 127.0.0.1:1080')).toBeInTheDocument()
      expect(within(rows[0]).getByRole('switch', { name: 'Run pg' })).toHaveAttribute('aria-checked', 'true')
      expect(within(rows[0]).getByText('Up')).toBeInTheDocument()
      const proxy = within(rows[1]).getByRole('switch', { name: 'Run proxy' })
      expect(proxy).toHaveAttribute('aria-checked', 'false')
      await user.click(proxy)
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('tunnel:start', 't-proxy'))
      await user.click(within(rows[0]).getByRole('switch', { name: 'Run pg' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('tunnel:stop', 't-pg'))
    })

    it('a host without tunnels says so in one line', () => {
      setup()
      render(<HostView hostId="bastion" />)
      expect(within(tunnels()).queryAllByRole('listitem')).toHaveLength(0)
      expect(within(tunnels()).getByText('No tunnels on this host yet.')).toBeInTheDocument()
    })

    it('New tunnel for this host prefills host and environment', async () => {
      const user = userEvent.setup()
      setup()
      render(<HostView hostId="web1" environmentId="prod" />)
      await within(card()).findByText('2222')
      await user.click(within(tunnels()).getByRole('button', { name: 'New tunnel for this host' }))
      const dialog = await screen.findByRole('dialog', { name: 'New tunnel' })
      expect(within(dialog).getByLabelText('Host')).toHaveValue('web1')
      expect(within(dialog).getByLabelText('Environment')).toHaveValue('prod')
      expect(within(dialog).getByText('ssh -L 127.0.0.1:…:localhost:… web-1')).toBeInTheDocument()
    })

    it('New tunnel outside any environment leaves the environment empty', async () => {
      const user = userEvent.setup()
      setup()
      render(<HostView hostId="web1" />)
      await user.click(within(tunnels()).getByRole('button', { name: 'New tunnel for this host' }))
      const dialog = await screen.findByRole('dialog', { name: 'New tunnel' })
      expect(within(dialog).getByLabelText('Host')).toHaveValue('web1')
      expect(within(dialog).getByLabelText('Environment')).toHaveValue('')
    })
  })
})
