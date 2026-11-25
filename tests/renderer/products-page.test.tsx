import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { buildTree } from '../../src/renderer/src/inventory/tree'
import { ProductsPage } from '../../src/renderer/src/pages/products/ProductsPage'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import type { EnvironmentMeta, HostMeta, HostRole, ProductMeta } from '../../src/shared/inventory'
import type { ServiceMeta } from '../../src/shared/services'
import { DEFAULT_VAULT_ID, type IdentityMeta } from '../../src/shared/vault'
import { appService, dbService, defaultVault, deploymentMeta, environment, host, mockBridge, product, REGION, vaultStatus } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const TS = '2026-10-16T09:00:00.000Z'
const deploy: IdentityMeta = {
  id: 'id-deploy',
  vaultId: DEFAULT_VAULT_ID,
  label: 'deploy',
  username: 'deploy',
  auth: 'agent',
  sshKeyId: null,
  hasPassword: false,
  createdAt: TS,
  updatedAt: TS,
}


// Opening a session is the terminal store's job; these tests only care what it is asked for.
const sessions = vi.hoisted(() => ({ openSsh: vi.fn(), openLocal: vi.fn() }))
vi.mock('../../src/renderer/src/terminal/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/terminal/sessions')>()),
  openSsh: sessions.openSsh,
  openLocal: sessions.openLocal,
}))

interface World {
  products: ProductMeta[]
  environments: EnvironmentMeta[]
  hosts: HostMeta[]
}

/** Acme holds prod (protected, web-1 as app), staging and analytics-db; Essentials is empty. */
function world(): World {
  return {
    products: [
      product({ id: 'acme', name: 'Acme', environmentIds: ['analytics', 'prod', 'staging'] }),
      product({ id: 'essentials', name: 'Essentials', color: '#2fbf71', environmentIds: [] }),
    ],
    environments: [
      environment({ id: 'analytics', name: 'analytics-db', productId: 'acme' }),
      environment({
        id: 'prod',
        name: 'prod',
        color: '#ef5b5b',
        protected: true,
        productId: 'acme',
        hosts: [{ hostId: 'web1', role: 'app' }],
      }),
      environment({ id: 'staging', name: 'staging', color: '#f2a93b', productId: 'acme' }),
    ],
    hosts: [host({ id: 'web1', label: 'web-1', environments: [{ environmentId: 'prod', role: 'app' }] })],
  }
}

/** web-1 runs a service in both prod and staging. */
function sharedWorld(): World {
  const w = world()
  w.environments = w.environments.map((e) => (e.id === 'staging' ? { ...e, hosts: [{ hostId: 'web1', role: 'app' }] } : e))
  w.hosts = w.hosts.map((h) => ({ ...h, environments: [...h.environments, { environmentId: 'staging', role: 'app' }] }))
  return w
}

/** World plus an unassigned host, loose-1, to drag into environments. */
function looseWorld(): World {
  const w = world()
  w.hosts = [...w.hosts, host({ id: 'loose', label: 'loose-1' })]
  return w
}

const KIND_OF_ROLE = { app: 'service', other: 'service', db: 'db', bastion: 'bastion' } as const
const ROLE_RANK: HostRole[] = ['bastion', 'app', 'db']

/** The service a host gets when it joins an environment: named after the host, its type from the role. */
function placeholder(envId: string, hostId: string, label: string, role: HostRole, position: number): ServiceMeta {
  const base = { id: `${envId}-${hostId}`, name: label, environmentId: envId, hostId, position }
  const kind = KIND_OF_ROLE[role]
  if (kind === 'db') return dbService({ ...base, dbAddress: '127.0.0.1' })
  if (kind === 'bastion') return { ...base, kind: 'bastion', description: '', createdAt: TS, updatedAt: TS }
  return appService({ ...base, deploymentId: null, composeService: '' })
}

/** One placeholder service per membership in the world, as the migration makes them. */
function seed(w: World): ServiceMeta[] {
  const label = new Map(w.hosts.map((h) => [h.id, h.label]))
  return w.environments.flatMap((e) => e.hosts.map((m, i) => placeholder(e.id, m.hostId, label.get(m.hostId) ?? m.hostId, m.role, i)))
}

/** Membership is derived from services: a host is in an environment when it runs one there, its role the strongest. */
function members(services: ServiceMeta[], envId: string): { hostId: string; role: HostRole }[] {
  const out = new Map<string, HostRole>()
  for (const s of services.filter((x) => x.environmentId === envId)) {
    const role: HostRole = s.kind === 'service' ? 'app' : s.kind
    const had = out.get(s.hostId)
    if (!had || ROLE_RANK.indexOf(role) < ROLE_RANK.indexOf(had)) out.set(s.hostId, role)
  }
  return [...out].map(([hostId, role]) => ({ hostId, role }))
}

let where = ''
function Location() {
  const loc = useLocation()
  where = loc.pathname + loc.search
  return null
}

function renderPage(w: World = world(), extra: Record<string, unknown> = {}) {
  // Services are the record; the world's memberships seed them, and env/host lists are derived from them.
  const { 'service:list': given = [], ...rest } = extra as { 'service:list'?: ServiceMeta[] }
  let services: ServiceMeta[] = [...seed(w), ...given]
  const envs = () => w.environments.map((e) => ({ ...e, hosts: members(services, e.id) }))
  const hosts = () =>
    w.hosts.map((h) => ({
      ...h,
      environments: w.environments.flatMap((e) => members(services, e.id).filter((m) => m.hostId === h.id).map((m) => ({ environmentId: e.id, role: m.role }))),
    }))
  const join = (envId: string, hostId: string, role: HostRole) => {
    if (services.some((s) => s.environmentId === envId && s.hostId === hostId)) return
    const label = w.hosts.find((h) => h.id === hostId)?.label ?? hostId
    services = [...services, placeholder(envId, hostId, label, role, services.filter((s) => s.environmentId === envId).length)]
  }
  const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true }), 'identity:list': [deploy], 'vault:list': [defaultVault], ...rest })
  const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'product:list':
        return w.products
      case 'env:list':
        return envs()
      case 'host:list':
        return hosts()
      case 'service:list':
        return args[0] ? services.filter((s) => s.environmentId === args[0]) : services
      case 'service:delete':
        services = services.filter((s) => s.id !== args[0])
        return null
      case 'product:create': {
        const p = product({ id: 'new-product', ...(args[0] as { name: string }) })
        w.products = [...w.products, p]
        return p
      }
      case 'env:create': {
        const input = args[0] as { name: string; productId: string }
        const e = environment({ id: 'new-env', ...input })
        w.environments = [...w.environments, e]
        return e
      }
      case 'host:create': {
        const input = args[0] as { label: string; environments: { environmentId: string; role: 'app' }[] }
        const h = host({ id: 'new-host', ...input, environments: [] })
        w.hosts = [...w.hosts, h]
        for (const m of input.environments) join(m.environmentId, h.id, m.role)
        return hosts().find((x) => x.id === h.id)
      }
      case 'env:putHost': {
        const [envId, hostId, role] = args as [string, string, HostRole]
        join(envId, hostId, role)
        return envs().find((e) => e.id === envId)
      }
      case 'env:removeHost': {
        const [envId, hostId] = args as [string, string]
        services = services.filter((s) => !(s.environmentId === envId && s.hostId === hostId))
        return envs().find((e) => e.id === envId)
      }
      case 'env:setProduct': {
        const [envId, productId] = args as [string, string]
        w.environments = w.environments.map((e) => (e.id === envId ? { ...e, productId } : e))
        w.products = w.products.map((p) => ({
          ...p,
          environmentIds: p.id === productId
            ? [...new Set([...p.environmentIds, envId])]
            : p.environmentIds.filter((id) => id !== envId),
        }))
        return envs().find((e) => e.id === envId)
      }
      case 'env:delete':
        w.environments = w.environments.filter((e) => e.id !== args[0])
        services = services.filter((s) => s.environmentId !== args[0])
        return null
    }
    return base(channel, ...args)
  })
  vaultStatusStore.set(vaultStatus({ unlocked: true }))
  const view = render(
    <MemoryRouter initialEntries={['/products']}>
      <ProductsPage />
      <Location />
      <Toaster />
    </MemoryRouter>,
  )
  return { invoke, ...view }
}

const items = () => screen.getAllByRole('treeitem')
const item = (name: string, nth = 0) => screen.getAllByRole('treeitem', { name })[nth]
const chevron = (el: HTMLElement) => within(el).getByTestId('tree-chevron')
const HINT = 'No services — drag a host here'
const dataTransfer = () => ({ setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' })

beforeEach(() => {
  motion.safe = true
  inventoryStore.set(null)
  sessions.openSsh.mockReset().mockResolvedValue('s1')
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    clearToasts()
  })
  resetDeploy()
  resetReleases()
})

describe('products page', () => {
  it('empty state', async () => {
    renderPage({ products: [], environments: [], hosts: [] })
    expect(await screen.findByText('No products yet')).toBeInTheDocument()
    expect(screen.getByText('Create your first product to group environments.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New product' }).length).toBeGreaterThan(0)
  })

  it('offers Import products… and Export products… for the products segment', async () => {
    const { invoke } = renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Export products…' }))
    expect(invoke).toHaveBeenCalledWith('config:export', 'products')
    await user.click(screen.getByRole('button', { name: 'Import products…' }))
    expect(invoke).toHaveBeenCalledWith('config:importOpen', 'products')
  })

  it('renders the tree', async () => {
    const user = userEvent.setup()
    const w = world()
    renderPage(w)
    const acme = await screen.findByRole('treeitem', { name: 'Acme' })
    expect(acme).toHaveAttribute('aria-expanded', 'true')
    expect(acme).toHaveAttribute('aria-level', '1')
    expect(item('prod')).toHaveAttribute('aria-level', '2')

    const all = new Set(['p:acme', 'p:essentials', 'p:acme/e:prod'])
    const order = buildTree({ ...w, identities: [], vaults: [], regions: [] }, all, seed(w)).map((r) => r.label)
    expect(order).toContain('web-1')
    expect(items().map((el) => el.getAttribute('aria-label'))).toEqual(order)

    await user.click(chevron(acme))
    expect(acme).toHaveAttribute('aria-expanded', 'false')
    expect(items().map((el) => el.getAttribute('aria-label'))).toEqual(['Acme', 'Essentials'])
  })

  it('keyboard navigation', async () => {
    const user = userEvent.setup()
    renderPage()
    const acme = await screen.findByRole('treeitem', { name: 'Acme' })
    expect(acme).toHaveAttribute('aria-selected', 'true')
    expect(acme).toHaveAttribute('tabindex', '0')
    act(() => acme.focus())

    await user.keyboard('{ArrowDown}')
    expect(item('analytics-db')).toHaveAttribute('aria-selected', 'true')
    expect(item('analytics-db')).toHaveFocus()
    expect(acme).toHaveAttribute('aria-selected', 'false')
    expect(acme).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{ArrowUp}{ArrowLeft}')
    expect(acme).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard('{ArrowDown}{Enter}')
    expect(item('Essentials')).toHaveAttribute('aria-selected', 'true')
    expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:essentials')
  })

  it('Enter selects a row focused without arrows; Home and End jump', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    act(() => item('staging').focus())
    await user.keyboard('{Enter}')
    expect(item('staging')).toHaveAttribute('aria-selected', 'true')
    expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:acme/e:staging')

    await user.keyboard('{End}')
    const last = items().at(-1)!
    expect(last).toHaveAttribute('aria-label', 'Essentials')
    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(item('Acme')).toHaveFocus()
    expect(item('Acme')).toHaveAttribute('aria-selected', 'true')
  })

  it('protected state is in the row description', async () => {
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    expect(item('prod')).toHaveAccessibleDescription('Environment prod. Protected. Region test-1')
    expect(item('analytics-db')).toHaveAccessibleDescription('Environment analytics-db. No services')
    expect(item('staging')).toHaveAccessibleDescription('Environment staging. No services')
    // A service row says its type and the host it runs on.
    expect(item('web-1')).toHaveAccessibleDescription('App web-1. On web-1. Region test-1')
  })

  it('collapsing moves focus out of a hidden row', async () => {
    renderPage()
    const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
    act(() => web1.focus())
    fireEvent.click(chevron(item('prod')))
    expect(item('prod')).toHaveFocus()
  })

  it('creates a product', async () => {
    const user = userEvent.setup()
    const w = world()
    w.products = w.products.filter((p) => p.id !== 'essentials')
    const { invoke } = renderPage(w)
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(screen.getAllByRole('button', { name: 'New product' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'New product' })
    await user.type(within(dialog).getByLabelText('Name'), 'Essentials')
    await user.click(within(dialog).getByRole('radio', { name: 'Leaf' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create product' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('product:create', { name: 'Essentials', color: '#5b8cff', icon: 'leaf', description: '' }),
    )
    expect(await screen.findByText('Created Essentials')).toBeInTheDocument()
    // The selection is a navigation, which the router renders in a transition: under load it can
    // commit after the toast, so wait for it rather than asserting the moment the toast shows.
    await waitFor(() => expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:new-product'))
    expect(await screen.findByRole('heading', { name: 'Essentials', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: 'Essentials' })).toHaveAttribute('aria-selected', 'true')
  })

  it("a service row's Connect opens its host in the environment", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(item('prod'))
    const details = screen.getByRole('region', { name: 'Details' })
    // A button on the row itself, not only in its menu.
    await user.click(await within(details).findByRole('button', { name: 'Connect to web-1' }))
    await waitFor(() => expect(where).toBe('/terminals'))
    expect(sessions.openSsh).toHaveBeenCalledWith('web1', 'prod')
  })

  it("a service in the tree connects to its host from the row's menu", async () => {
    const user = userEvent.setup()
    renderPage(sharedWorld())
    const inStaging = (await screen.findAllByRole('treeitem', { name: 'web-1' }))[1]
    fireEvent.contextMenu(inStaging)
    await user.click(await screen.findByRole('menuitem', { name: 'Connect to host' }))
    await waitFor(() => expect(where).toBe('/terminals'))
    expect(sessions.openSsh).toHaveBeenCalledWith('web1', 'staging')
  })

  it('a service row Deploy opens the deploy wizard with only that service ticked', async () => {
    const user = userEvent.setup()
    renderPage(world(), {
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'core', environmentId: 'prod', hostId: 'web1' })],
      'service:list': [
        appService({ id: 's1', name: 'api', environmentId: 'prod', hostId: 'web1', deploymentId: 'd1', position: 1 }),
        appService({ id: 's2', name: 'worker', environmentId: 'prod', hostId: 'web1', deploymentId: 'd1', position: 2 }),
      ],
    })
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(item('prod'))
    const details = screen.getByRole('region', { name: 'Details' })
    await user.click(await within(details).findByRole('button', { name: 'Deploy api' }))
    const wizard = await screen.findByRole('dialog', { name: 'Deploy to prod' })
    expect(within(wizard).getByRole('checkbox', { name: 'api' })).toBeChecked()
    expect(within(wizard).getByRole('checkbox', { name: 'worker' })).not.toBeChecked()
    await user.click(within(wizard).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deploy to prod' })).not.toBeInTheDocument())
  })

  it('environment dialog saves defaults', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(within(screen.getByRole('region', { name: 'Details' })).getByRole('button', { name: 'New environment' }))
    const dialog = await screen.findByRole('dialog', { name: 'New environment' })
    // Opened from Acme: the product is set and can't change here.
    expect(within(dialog).getByLabelText('Product')).toHaveDisplayValue('Acme')
    expect(within(dialog).getByLabelText('Product')).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Name'), 'staging')
    await user.type(within(dialog).getByLabelText('Default port'), '2222')
    await user.selectOptions(within(dialog).getByLabelText('Default identity'), 'id-deploy')
    await user.click(within(dialog).getByRole('button', { name: 'Create environment' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('env:create', {
        name: 'staging',
        color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        protected: false,
        defaultPort: 2222,
        defaultIdentityId: 'id-deploy',
        defaultJumpHostId: null,
        domain: null,
        productId: 'acme',
      }),
    )
  })

  it('environment dialog edits move an environment with one product select', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'staging' }))
    await user.click(within(screen.getByRole('region', { name: 'Details' })).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit environment' })
    const select = within(dialog).getByLabelText('Product')
    expect(select).toBeEnabled()
    expect(select).toHaveDisplayValue('Acme')
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Acme', 'Essentials'])
    await user.selectOptions(select, 'Essentials')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:setProduct', 'staging', 'essentials'))
  })

  it('a new environment from the tree needs a product picked', async () => {
    const user = userEvent.setup()
    const w = world()
    w.hosts = [...w.hosts, host({ id: 'loose', label: 'loose-1' })]
    renderPage(w)
    await user.click(await screen.findByRole('treeitem', { name: 'Unassigned hosts' }))
    await user.click(screen.getAllByRole('button', { name: 'New environment' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'New environment' })
    const select = within(dialog).getByLabelText('Product')
    expect(select).toBeEnabled()
    expect(select).toHaveDisplayValue('Pick a product')
    await user.type(within(dialog).getByLabelText('Name'), 'qa')
    expect(within(dialog).getByRole('button', { name: 'Create environment' })).toBeDisabled()
    await user.selectOptions(select, 'Essentials')
    expect(within(dialog).getByRole('button', { name: 'Create environment' })).toBeEnabled()
  })

  /** Wraps the page's bridge with env:update (applied to the world) and a scripted env:openDomain. */
  function renderDomainPage(domain: string | null, open: (id: string) => Promise<null> = async () => null) {
    const w = world()
    w.environments = w.environments.map((e) => (e.id === 'prod' ? { ...e, domain } : e))
    const out = renderPage(w)
    const prev = out.invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    out.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'env:update') {
        const [id, patch] = args as [string, Partial<EnvironmentMeta>]
        w.environments = w.environments.map((e) => (e.id === id ? { ...e, ...patch } : e))
        return w.environments.find((e) => e.id === id)
      }
      if (channel === 'env:openDomain') return open(args[0] as string)
      return prev(channel, ...args)
    })
    return out
  }

  it('environment dialog edits the domain or URL', async () => {
    const user = userEvent.setup()
    const { invoke } = renderDomainPage(null)
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    const details = screen.getByRole('region', { name: 'Details' })
    await user.click(within(details).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit environment' })
    const field = within(dialog).getByLabelText('Domain or URL')
    expect(field).toHaveAccessibleDescription('e.g. staging.example.com')

    await user.type(field, 'https://u:p@x.example.com')
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    // The hint fades out (and the error in) over the field's short exit animation.
    await waitFor(() => expect(field).toHaveAccessibleDescription('Leave the login out of the URL'))
    await waitFor(() => expect(within(dialog).queryByText('e.g. staging.example.com')).not.toBeInTheDocument())
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(within(dialog).getByLabelText('Name')).not.toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText('Default port')).not.toHaveAttribute('aria-invalid', 'true')

    await user.clear(field)
    await user.type(field, 'ftp://x.example.com')
    await waitFor(() => expect(field).toHaveAccessibleDescription('Use an http:// or https:// URL'))

    await user.clear(field)
    await user.type(field, 'staging.example.com')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:update', 'prod', expect.objectContaining({ domain: 'staging.example.com' })))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit environment' })).not.toBeInTheDocument())
    await user.click(within(details).getByRole('button', { name: 'Edit' }))
    const again = await screen.findByRole('dialog', { name: 'Edit environment' })
    const f2 = within(again).getByLabelText('Domain or URL')
    expect(f2).toHaveValue('staging.example.com')
    await user.clear(f2)
    await user.click(within(again).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:update', 'prod', { domain: null }))
  })

  it('a new environment sends the domain as typed, or null', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(within(screen.getByRole('region', { name: 'Details' })).getByRole('button', { name: 'New environment' }))
    const dialog = await screen.findByRole('dialog', { name: 'New environment' })
    await user.type(within(dialog).getByLabelText('Name'), 'qa')
    await user.type(within(dialog).getByLabelText('Domain or URL'), 'https://qa.example.com/app')
    await user.click(within(dialog).getByRole('button', { name: 'Create environment' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:create', expect.objectContaining({ name: 'qa', domain: 'https://qa.example.com/app' })))
  })

  it('environment view shows the domain with Open', async () => {
    const user = userEvent.setup()
    const { invoke } = renderDomainPage('staging.example.com')
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    const main = screen.getByRole('region', { name: 'Details' })
    const value = within(main).getByText('staging.example.com')
    expect(value.closest('div')).toHaveTextContent('Domain or URL')
    expect(value).toHaveClass('font-mono')
    await user.click(within(main).getByRole('button', { name: 'Open staging.example.com in your browser' }))
    expect(invoke).toHaveBeenCalledWith('env:openDomain', 'prod')
    expect(invoke.mock.calls.filter((c) => c[0] === 'env:openDomain')[0]).toHaveLength(2)
  })

  it('environment view shows a URL exactly as stored, and None without Open', async () => {
    const user = userEvent.setup()
    renderDomainPage('HTTPS://Staging.Example.com/app?x=1')
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    const main = screen.getByRole('region', { name: 'Details' })
    expect(within(main).getByText('HTTPS://Staging.Example.com/app?x=1')).toBeInTheDocument()
    await user.click(item('staging'))
    await within(main).findByText('No services yet')
    expect(within(main).getByText('None')).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: /^Open / })).not.toBeInTheDocument()
  })

  it("a rejected open surfaces as a toast", async () => {
    const user = userEvent.setup()
    renderDomainPage('staging.example.com', async () => {
      throw new Error("This environment's domain or URL can't be opened")
    })
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    await user.click(await screen.findByRole('button', { name: 'Open staging.example.com in your browser' }))
    expect(await screen.findByText(/This environment's domain or URL can't be opened/)).toBeInTheDocument()
  })

  it('dropping an unassigned host on an environment runs it there', async () => {
    const { invoke } = renderPage(looseWorld())
    const loose = await screen.findByRole('treeitem', { name: 'loose-1' })
    const staging = item('staging')
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    expect(staging).toHaveAttribute('data-drop-target', 'true')
    // Products and services are not places for a host.
    expect(item('Acme')).not.toHaveAttribute('data-drop-target')
    expect(item('web-1')).not.toHaveAttribute('data-drop-target')
    fireEvent.dragOver(staging, { dataTransfer: dataTransfer() })
    fireEvent.drop(staging, { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'loose', 'app'))
    expect(await screen.findByText('Added loose-1 to staging')).toBeInTheDocument()

    // It now runs a service in staging, named after it, and is no longer unassigned.
    const row = await screen.findByRole('treeitem', { name: 'loose-1' })
    await waitFor(() => expect(row).toHaveAttribute('aria-level', '3'))
    expect(row).toHaveAccessibleDescription('App loose-1. On loose-1. Region test-1')
    expect(screen.queryByRole('treeitem', { name: 'Unassigned hosts' })).not.toBeInTheDocument()
  })

  it('drops an environment on a product', async () => {
    const { invoke } = renderPage()
    const staging = await screen.findByRole('treeitem', { name: 'staging' })
    fireEvent.dragStart(staging, { dataTransfer: dataTransfer() })
    expect(item('Essentials')).toHaveAttribute('data-drop-target', 'true')
    expect(item('Acme')).not.toHaveAttribute('data-drop-target')
    fireEvent.drop(item('Essentials'), { dataTransfer: dataTransfer() })
    const ask = await screen.findByRole('dialog', { name: 'Move staging to Essentials?' })
    expect(invoke).not.toHaveBeenCalledWith('env:setProduct', expect.anything(), expect.anything())
    fireEvent.click(within(ask).getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:setProduct', 'staging', 'essentials'))
    expect(await screen.findByText('Moved staging to Essentials')).toBeInTheDocument()
  })

  it('cancelling the move leaves the environment where it is', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    const staging = await screen.findByRole('treeitem', { name: 'staging' })
    fireEvent.dragStart(staging, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('Essentials'), { dataTransfer: dataTransfer() })
    const ask = await screen.findByRole('dialog', { name: 'Move staging to Essentials?' })
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(invoke).not.toHaveBeenCalledWith('env:setProduct', expect.anything(), expect.anything())
  })

  it('a host dropped into an environment in another region says so, and still joins', async () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    const w = world()
    w.environments = w.environments.map((e) => (e.id === 'staging' ? { ...e, hosts: [{ hostId: 'web1', role: 'app' }] } : e))
    w.hosts = [
      host({ id: 'web1', label: 'web-1', environments: [{ environmentId: 'prod', role: 'app' }, { environmentId: 'staging', role: 'app' }] }),
      host({ id: 'us1', label: 'app-us-1', regionId: us.id }),
    ]
    const { invoke } = renderPage(w, { 'region:list': [REGION, us] })
    const loose = await screen.findByRole('treeitem', { name: 'app-us-1' })
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('staging'), { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'us1', 'app'))
    expect(await screen.findByText("staging's hosts are all in test-1; app-us-1 is in us-east-1.")).toBeInTheDocument()
  })

  it('a host dropped into an empty environment gets no region hint', async () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    const w = world()
    w.hosts = [...w.hosts, host({ id: 'us1', label: 'app-us-1', regionId: us.id })]
    const { invoke } = renderPage(w, { 'region:list': [REGION, us] })
    const loose = await screen.findByRole('treeitem', { name: 'app-us-1' })
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('staging'), { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'us1', 'app'))
    expect(await screen.findByText('Added app-us-1 to staging')).toBeInTheDocument()
    expect(screen.queryByText(/is in us-east-1/)).not.toBeInTheDocument()
  })

  it('a drop in flight blocks further drops', async () => {
    const { invoke } = renderPage(looseWorld())
    const run = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    invoke.mockImplementation(async (c: string, ...a: unknown[]) => (c === 'env:putHost' ? gate.then(() => run(c, ...a)) : run(c, ...a)))
    const loose = await screen.findByRole('treeitem', { name: 'loose-1' })
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('staging'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    expect(item('analytics-db')).not.toHaveAttribute('data-drop-target')
    fireEvent.drop(item('analytics-db'), { dataTransfer: dataTransfer() })
    expect(invoke.mock.calls.filter(([c]) => c === 'env:putHost')).toHaveLength(1)
    await act(async () => release())
    expect(await screen.findByText('Added loose-1 to staging')).toBeInTheDocument()
  })

  it('drag state clears when the dragged row leaves the tree', async () => {
    renderPage(looseWorld())
    await screen.findByRole('treeitem', { name: 'Acme' })
    fireEvent.dragStart(item('loose-1'), { dataTransfer: dataTransfer() })
    expect(item('analytics-db')).toHaveAttribute('data-drop-target', 'true')
    fireEvent.click(chevron(item('Unassigned hosts')))
    expect(item('analytics-db')).not.toHaveAttribute('data-drop-target')
  })

  it('deleting a service from the tree asks first', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage(sharedWorld())
    const inStaging = (await screen.findAllByRole('treeitem', { name: 'web-1' }))[1]
    fireEvent.contextMenu(inStaging)
    const menu = await screen.findByRole('menu', { name: 'Options for web-1' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Connect to host', 'Edit service', 'Delete service'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete service' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete web-1?' })
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete service' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('service:delete', 'staging-web1', { deleteTunnel: false }))
    // Its last service gone, the host leaves staging but stays in prod.
    await waitFor(() => expect(screen.getAllByRole('treeitem', { name: 'web-1' })).toHaveLength(1))
  })

  it('deleting a service in a protected environment types the name', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'web-1' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete service' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete web-1?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete service' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod')
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('service:delete', 'prod-web1', { deleteTunnel: false }))
  })

  it('protected delete types the name', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    expect(await screen.findByRole('heading', { name: 'prod', level: 2 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'prod options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete prod?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete environment' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:delete', 'prod'))
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'prod' })).not.toBeInTheDocument())
  })

  it('product cards offer no way to take an environment out of its product', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Acme', level: 2 })
    expect(screen.queryByRole('button', { name: 'staging options' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Remove from/)).not.toBeInTheDocument()
  })

  it('deleting a product that still has environments shows why it was refused', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    const prev = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (c: string, ...a: unknown[]) => {
      if (c === 'product:delete') throw new Error('Acme still has 3 environments: move or delete them first')
      return prev(c, ...a)
    })
    await screen.findByRole('heading', { name: 'Acme', level: 2 })
    await user.click(screen.getByRole('button', { name: 'Acme options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(await screen.findByText("Couldn't delete Acme")).toBeInTheDocument()
    expect(screen.getByText('Acme still has 3 environments: move or delete them first')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('product:delete', 'acme')
    expect(item('Acme')).toBeInTheDocument()
  })

  it('an empty product deletes after a confirm', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'Essentials' }))
    await user.click(screen.getByRole('button', { name: 'Essentials options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const ask = await screen.findByRole('dialog', { name: 'Delete Essentials?' })
    expect(within(ask).getByText('It has no environments, so nothing else is removed.')).toBeInTheDocument()
    await user.click(within(ask).getByRole('button', { name: 'Delete product' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('product:delete', 'essentials'))
  })

  describe('regions', () => {
    const US = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    /** prod runs web-1 in test-1 and app-us-1 in us-east-1. */
    const split = (): World => {
      const w = world()
      w.environments = w.environments.map((e) => (e.id === 'prod' ? { ...e, hosts: [...e.hosts, { hostId: 'us1', role: 'app' }] } : e))
      w.hosts = [...w.hosts, host({ id: 'us1', label: 'app-us-1', regionId: US.id, environments: [{ environmentId: 'prod', role: 'app' }] })]
      return w
    }

    it('an environment in one region shows that region once, on its tree row, not on each host', async () => {
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
      const main = screen.getByRole('region', { name: 'Details' })
      expect(within(main).getAllByText('test-1')).toHaveLength(1)
      expect(within(main).queryByText('Regions:')).not.toBeInTheDocument()
      expect(within(item('prod')).getByText('test-1')).toBeInTheDocument()
      expect(within(item('web-1')).queryByText('test-1')).not.toBeInTheDocument()
      // The host still says its region to a screen reader.
      expect(item('web-1')).toHaveAccessibleDescription(/Region test-1/)
    })

    it('an environment over several regions lists them and marks each host', async () => {
      const user = userEvent.setup()
      renderPage(split(), { 'region:list': [REGION, US] })
      await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
      const main = screen.getByRole('region', { name: 'Details' })
      const header = within(main).getByLabelText('Regions: test-1, us-east-1')
      expect(header).toHaveTextContent('Regions:')
      // Header chip plus one per host.
      expect(within(main).getAllByText('us-east-1')).toHaveLength(2)
      expect(within(main).getAllByText('test-1')).toHaveLength(2)
      expect(within(item('app-us-1')).getByText('us-east-1')).toBeInTheDocument()
      expect(within(item('prod')).queryByText(/test-1|us-east-1/)).not.toBeInTheDocument()
      expect(item('app-us-1')).toHaveAccessibleDescription(/Region us-east-1/)
    })

    it('an environment with no hosts shows no region', async () => {
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('treeitem', { name: 'staging' }))
      expect(within(screen.getByRole('region', { name: 'Details' })).queryByText('test-1')).not.toBeInTheDocument()
    })

    const REPORT = {
      region: { id: REGION.id, code: REGION.code, displayName: 'Default region', hostCount: 1 },
      productLinks: [{ environmentId: 'staging', environmentName: 'staging', kept: { id: 'acme', name: 'Acme' }, removed: [{ id: 'old', name: 'Globe' }] }],
      unassigned: { product: { id: 'acme', name: 'Acme' }, environments: [{ id: 'analytics', name: 'analytics-db' }] },
      renamed: [{ environmentId: 'prod', from: 'prod', to: 'prod (2)' }],
    }

    it('the upgrade banner says what moved and links to each environment', async () => {
      const user = userEvent.setup()
      renderPage(world(), { 'region:upgradeReport': REPORT })
      const banner = await screen.findByRole('status', { name: 'Regions upgrade' })
      expect(banner).toHaveTextContent('Hosts now have a region. Everything is in Default region for now. Create your regions and move hosts.')
      expect(banner).toHaveTextContent('staging: kept Acme, removed Globe')
      expect(banner).toHaveTextContent('In no product, now in Acme: analytics-db')
      expect(banner).toHaveTextContent('Renamed prod to prod (2)')
      await user.click(within(banner).getByRole('button', { name: 'analytics-db' }))
      expect(item('analytics-db')).toHaveAttribute('aria-selected', 'true')
    })

    it('dismissing the banner hides it and tells main', async () => {
      const user = userEvent.setup()
      const { invoke } = renderPage(world(), { 'region:upgradeReport': REPORT })
      const banner = await screen.findByRole('status', { name: 'Regions upgrade' })
      await user.click(within(banner).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByRole('status', { name: 'Regions upgrade' })).not.toBeInTheDocument()
      expect(invoke).toHaveBeenCalledWith('region:dismissUpgradeReport')
    })

    it('no report, no banner', async () => {
      const { invoke } = renderPage()
      await screen.findByRole('treeitem', { name: 'Acme' })
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('region:upgradeReport'))
      expect(screen.queryByRole('status', { name: 'Regions upgrade' })).not.toBeInTheDocument()
    })
  })

  it('environment view lists its services and shows defaults', async () => {
    const user = userEvent.setup()
    const w = world()
    w.environments = w.environments.map((e) => (e.id === 'prod' ? { ...e, defaultPort: 2222, defaultIdentityId: 'id-deploy' } : e))
    renderPage(w)
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    const main = screen.getByRole('region', { name: 'Details' })
    expect(within(main).getByText('Protected')).toBeInTheDocument()
    const section = await within(main).findByRole('region', { name: 'Services' })
    expect(within(section).getByRole('heading', { name: /Services/ })).toHaveTextContent('1')
    expect(within(main).getByText('2222')).toBeInTheDocument()
    expect(within(main).getAllByText('Inherited from prod')).toHaveLength(2)
    expect(within(main).getByText('App default')).toBeInTheDocument()
    // No role-grouped host sections, and no separate database button.
    expect(within(main).queryByRole('heading', { name: 'App' })).not.toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Add database' })).not.toBeInTheDocument()

    await user.click(item('staging'))
    expect(await within(main).findByText('No services yet')).toBeInTheDocument()
  })

  it('a service selection opens its environment; an unassigned host opens the host view', async () => {
    const user = userEvent.setup()
    renderPage(looseWorld())
    await user.click(await screen.findByRole('treeitem', { name: 'web-1' }))
    expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:acme/e:prod/s:prod-web1')
    const main = screen.getByRole('region', { name: 'Details' })
    expect(await within(main).findByRole('heading', { name: 'prod', level: 2 })).toBeInTheDocument()

    await user.click(item('loose-1'))
    expect(await within(main).findByRole('heading', { name: 'loose-1', level: 2 })).toBeInTheDocument()
    expect(within(main).getByRole('region', { name: 'Connection' })).toBeInTheDocument()
  })

  it('new host from an environment lands in it', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'staging' }))
    await user.click(screen.getByRole('button', { name: 'New host' }))
    const dialog = await screen.findByRole('dialog', { name: 'New host' })
    await user.type(within(dialog).getByLabelText('Label'), 'db-2')
    await user.type(within(dialog).getByLabelText('Address'), '10.0.0.9')
    await user.click(within(dialog).getByRole('button', { name: 'Create host' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('host:create', expect.objectContaining({ environments: [{ environmentId: 'staging', role: 'app' }] })),
    )
    // It joins as an app named after it; the environment stays selected.
    await waitFor(() => expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:acme/e:staging'))
    expect(await screen.findByRole('treeitem', { name: 'db-2' })).toHaveAccessibleDescription(/^App db-2\. On db-2/)
  })

  it('a dropped host is a bastion where it is the jump host', async () => {
    const w = looseWorld()
    w.environments = w.environments.map((e) => (e.id === 'staging' ? { ...e, defaultJumpHostId: 'loose' } : e))
    const { invoke } = renderPage(w)
    fireEvent.dragStart(await screen.findByRole('treeitem', { name: 'loose-1' }), { dataTransfer: dataTransfer() })
    fireEvent.drop(item('staging'), { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'loose', 'bastion'))
    await waitFor(() => expect(item('loose-1')).toHaveAccessibleDescription(/^Bastion loose-1/))
  })

  it("a service row's menu edits the service", async () => {
    const user = userEvent.setup()
    renderPage()
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'web-1' }))
    const menu = await screen.findByRole('menu', { name: 'Options for web-1' })
    expect(within(menu).queryByRole('menuitemradio')).not.toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit service' }))
    expect(await screen.findByRole('dialog', { name: 'Edit web-1' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('right-clicking a product or environment opens its add and edit dialogs', async () => {
    const user = userEvent.setup()
    renderPage()
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Acme' }))
    let menu = await screen.findByRole('menu', { name: 'Options for Acme' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['New environment', 'Edit product'])
    await user.click(within(menu).getByRole('menuitem', { name: 'New environment' }))
    const envDialog = await screen.findByRole('dialog', { name: 'New environment' })
    expect(within(envDialog).getByLabelText('Product')).toHaveValue('acme')
    expect(within(envDialog).getByLabelText('Product')).toBeDisabled()
    await user.click(within(envDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.contextMenu(item('staging'))
    menu = await screen.findByRole('menu', { name: 'Options for staging' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['New host', 'Add service', 'Edit environment'])
    await user.click(within(menu).getByRole('menuitem', { name: 'New host' }))
    expect(await screen.findByRole('dialog', { name: 'New host' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.contextMenu(item('staging'))
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add service' }))
    expect(await screen.findByRole('dialog', { name: 'Add service' })).toBeInTheDocument()
    expect(item('staging')).toHaveAttribute('aria-selected', 'true')
  })

  it('the options button toggles its menu', async () => {
    const user = userEvent.setup()
    renderPage()
    const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
    const button = within(web1).getByRole('button', { name: 'Options for web-1' })
    await user.click(button)
    expect(await screen.findByRole('menu', { name: 'Options for web-1' })).toBeInTheDocument()
    await user.click(button)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('the role menu flips above and pulls in from the edge when it would overflow', async () => {
    const { innerHeight, innerWidth } = window
    Object.assign(window, { innerHeight: 300, innerWidth: 400 })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const menu = this.getAttribute('role') === 'menu'
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: menu ? 200 : 0, height: menu ? 150 : 0, toJSON() {} } as DOMRect
    })
    try {
      renderPage()
      const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
      fireEvent.contextMenu(web1, { clientX: 350, clientY: 250 })
      const menu = await screen.findByRole('menu', { name: 'Options for web-1' })
      expect(menu.style.left).toBe('192px')
      expect(menu.style.top).toBe('98px')
      fireEvent.keyDown(menu, { key: 'Escape' })
      fireEvent.contextMenu(web1, { clientX: 20, clientY: 40 })
      const near = await screen.findByRole('menu', { name: 'Options for web-1' })
      expect(near.style.left).toBe('20px')
      expect(near.style.top).toBe('40px')
    } finally {
      rect.mockRestore()
      Object.assign(window, { innerHeight, innerWidth })
    }
  })

  it('Shift+F10 and the options button open the menu; remove asks first', async () => {
    const user = userEvent.setup()
    renderPage()
    const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
    act(() => web1.focus())
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(await screen.findByRole('menu', { name: 'Options for web-1' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(web1).toHaveFocus()

    await user.click(within(web1).getByRole('button', { name: 'Options for web-1' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete service' }))
    expect(await screen.findByRole('dialog', { name: 'Delete web-1?' })).toBeInTheDocument()
  })

  it('a host running services in two environments shows one row in each, saying the host', async () => {
    renderPage(sharedWorld())
    await screen.findByRole('treeitem', { name: 'staging' })
    const rows = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).toHaveAccessibleDescription('App web-1. On web-1. Region test-1')
      expect(within(r).getByTitle('App')).toHaveTextContent('app')
    }
  })

  it('an empty expanded environment shows a hint that arrow keys skip', async () => {
    const user = userEvent.setup()
    renderPage()
    const staging = await screen.findByRole('treeitem', { name: 'staging' })
    expect(staging).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText(HINT).length).toBeGreaterThan(0)
    expect(items().every((el) => el.getAttribute('aria-label') !== HINT)).toBe(true)
    act(() => staging.focus())
    await user.keyboard('{ArrowDown}')
    expect(item('Essentials')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(staging).toHaveFocus()
  })

  it('dropping on the hint adds the host to that environment', async () => {
    const { invoke } = renderPage(looseWorld())
    const loose = await screen.findByRole('treeitem', { name: 'loose-1' })
    fireEvent.dragStart(loose, { dataTransfer: dataTransfer() })
    const hint = screen.getAllByText(HINT)[1]
    fireEvent.dragOver(hint, { dataTransfer: dataTransfer() })
    fireEvent.drop(hint, { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'loose', 'app'))
  })

  describe('practical layouts', () => {
    const layout = (): World => ({
      products: [
        product({ id: 'ent', name: 'Enterprize', environmentIds: ['stage', 'uat'] }),
        product({ id: 'ess', name: 'Essentials', environmentIds: ['alpha'] }),
      ],
      environments: [
        environment({
          id: 'stage',
          name: 'Stage',
          productId: 'ent',
          hosts: [
            { hostId: 'alpha', role: 'app' },
            { hostId: 'uat2', role: 'db' },
            { hostId: 'jump', role: 'bastion' },
          ],
        }),
        environment({ id: 'uat', name: 'UAT', productId: 'ent', hosts: [{ hostId: 'alpha', role: 'db' }] }),
        environment({ id: 'alpha', name: 'alpha', productId: 'ess', hosts: [{ hostId: 'alpha', role: 'app' }] }),
      ],
      hosts: [
        host({
          id: 'alpha',
          label: 'alpha',
          environments: [
            { environmentId: 'stage', role: 'app' },
            { environmentId: 'uat', role: 'db' },
            { environmentId: 'alpha', role: 'app' },
          ],
        }),
        host({ id: 'uat2', label: 'uat2-db', environments: [{ environmentId: 'stage', role: 'db' }] }),
        host({ id: 'jump', label: 'jump-1', environments: [{ environmentId: 'stage', role: 'bastion' }] }),
      ],
    })

    it('B: one environment over several hosts shows each service type', async () => {
      renderPage(layout())
      await screen.findByRole('treeitem', { name: 'Stage' })
      const chipOf = (name: string) => within(item(name)).getByTitle(/^(App|Database|Bastion)$/).textContent
      expect(chipOf('uat2-db')).toBe('db')
      expect(chipOf('jump-1')).toBe('bastion')
      expect(item('uat2-db')).toHaveAccessibleDescription('Database uat2-db. On uat2-db. Region test-1')
      // Bastions first, then apps, then databases.
      const stage = items().map((el) => el.getAttribute('aria-label'))
      expect(stage.slice(stage.indexOf('Stage') + 1, stage.indexOf('Stage') + 4)).toEqual(['jump-1', 'alpha', 'uat2-db'])
    })

    it('C: a host running in several environments has a service row in each', async () => {
      renderPage(layout())
      await screen.findByRole('treeitem', { name: 'Stage' })
      const rows = screen.getAllByRole('treeitem', { name: 'alpha' }).filter((el) => el.getAttribute('aria-level') === '3')
      expect(rows).toHaveLength(3)
      const descs = rows.map((r) => r.getAttribute('aria-describedby') && document.getElementById(r.getAttribute('aria-describedby')!)?.textContent)
      expect(descs.sort()).toEqual([
        'App alpha. On alpha. Region test-1',
        'App alpha. On alpha. Region test-1',
        'Database alpha. On alpha. Region test-1',
      ])
    })

    it('D: the service type belongs to the environment', async () => {
      renderPage(layout())
      await screen.findByRole('treeitem', { name: 'Stage' })
      const rows = screen.getAllByRole('treeitem', { name: 'alpha' }).filter((el) => el.getAttribute('aria-level') === '3')
      const chips = rows.map((r) => within(r).getByTitle(/^(App|Database|Bastion)$/).textContent)
      expect(chips.sort()).toEqual(['app', 'app', 'db'])
    })

    it('F: an environment and a service with one name read differently', async () => {
      renderPage(layout())
      await screen.findByRole('treeitem', { name: 'Stage' })
      const same = screen.getAllByRole('treeitem', { name: 'alpha' })
      const env = same.find((el) => el.getAttribute('aria-level') === '2')!
      const svc = same.find((el) => el.getAttribute('aria-level') === '3')!
      expect(env).toHaveAccessibleDescription(/^Environment alpha(\. Region \S+)?$/)
      expect(svc).toHaveAccessibleDescription(/^App alpha\. On alpha/)
      expect(within(env).getByTitle('Environment alpha')).toBeInTheDocument()
      expect(within(svc).getByTitle('App alpha')).toBeInTheDocument()
      expect(within(env).queryByTitle(/^(App|Database|Bastion)$/)).not.toBeInTheDocument()
    })
  })

  it('reduced motion', async () => {
    motion.safe = false
    const user = userEvent.setup()
    renderPage(sharedWorld())
    const prod = await screen.findByRole('treeitem', { name: 'prod' })
    await user.click(chevron(prod))
    expect(screen.getAllByRole('treeitem', { name: 'web-1' })).toHaveLength(1)
    await user.click(chevron(prod))
    // No findBy: the row is there right after the click, with no height or transform animation.
    const [inProd] = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(inProd.style.transform).toBe('')
    expect(inProd.style.height).toBe('')
    for (const el of items()) expect(el).not.toHaveAttribute('data-pulse')
  })

  it('motion-safe expand animates height', async () => {
    const user = userEvent.setup()
    renderPage(sharedWorld())
    const prod = await screen.findByRole('treeitem', { name: 'prod' })
    await user.click(chevron(prod))
    await user.click(chevron(prod))
    const [inProd] = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(inProd.style.height).not.toBe('')
  })
})
