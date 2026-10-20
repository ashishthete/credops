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
import type { EnvironmentMeta, HostMeta, ProductMeta } from '../../src/shared/inventory'
import { DEFAULT_VAULT_ID, type IdentityMeta } from '../../src/shared/vault'
import { appService, defaultVault, deploymentMeta, environment, host, mockBridge, product, vaultStatus } from './helpers'

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

/** Acme holds prod (protected, web-1 as app) and staging; analytics-db is shared with Essentials. */
function world(): World {
  return {
    products: [
      product({ id: 'acme', name: 'Acme', environmentIds: ['analytics', 'prod', 'staging'] }),
      product({ id: 'essentials', name: 'Essentials', color: '#2fbf71', environmentIds: ['analytics'] }),
    ],
    environments: [
      environment({ id: 'analytics', name: 'analytics-db', productIds: ['acme', 'essentials'] }),
      environment({
        id: 'prod',
        name: 'prod',
        color: '#ef5b5b',
        protected: true,
        productIds: ['acme'],
        hosts: [{ hostId: 'web1', role: 'app' }],
      }),
      environment({ id: 'staging', name: 'staging', color: '#f2a93b', productIds: ['acme'] }),
    ],
    hosts: [host({ id: 'web1', label: 'web-1', environments: [{ environmentId: 'prod', role: 'app' }] })],
  }
}

/** web-1 sits in both prod and staging, so it shows twice. */
function sharedWorld(): World {
  const w = world()
  w.environments = w.environments.map((e) => (e.id === 'staging' ? { ...e, hosts: [{ hostId: 'web1', role: 'app' }] } : e))
  w.hosts = w.hosts.map((h) => ({ ...h, environments: [...h.environments, { environmentId: 'staging', role: 'app' }] }))
  return w
}

let where = ''
function Location() {
  const loc = useLocation()
  where = loc.pathname + loc.search
  return null
}

function renderPage(w: World = world(), extra: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'vault:status': vaultStatus({ unlocked: true }), 'identity:list': [deploy], 'vault:list': [defaultVault], ...extra })
  const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'product:list':
        return w.products
      case 'env:list':
        return w.environments
      case 'host:list':
        return w.hosts
      case 'product:create': {
        const p = product({ id: 'new-product', ...(args[0] as { name: string }) })
        w.products = [...w.products, p]
        return p
      }
      case 'env:create': {
        const input = args[0] as { name: string; productIds: string[] }
        const e = environment({ id: 'new-env', ...input })
        w.environments = [...w.environments, e]
        return e
      }
      case 'host:create': {
        const input = args[0] as { label: string; environments: { environmentId: string; role: 'app' }[] }
        const h = host({ id: 'new-host', ...input })
        w.hosts = [...w.hosts, h]
        w.environments = w.environments.map((e) => {
          const m = input.environments.find((x) => x.environmentId === e.id)
          return m ? { ...e, hosts: [...e.hosts, { hostId: h.id, role: m.role }] } : e
        })
        return h
      }
      case 'env:putHost': {
        const [envId, hostId, role] = args as [string, string, 'app']
        w.environments = w.environments.map((e) => (e.id === envId ? { ...e, hosts: [...e.hosts, { hostId, role }] } : e))
        w.hosts = w.hosts.map((h) => (h.id === hostId ? { ...h, environments: [...h.environments, { environmentId: envId, role }] } : h))
        return w.environments.find((e) => e.id === envId)
      }
      case 'env:removeHost': {
        const [envId, hostId] = args as [string, string]
        w.environments = w.environments.map((e) => (e.id === envId ? { ...e, hosts: e.hosts.filter((m) => m.hostId !== hostId) } : e))
        w.hosts = w.hosts.map((h) => (h.id === hostId ? { ...h, environments: h.environments.filter((m) => m.environmentId !== envId) } : h))
        return w.environments.find((e) => e.id === envId)
      }
      case 'env:setProducts': {
        const [envId, productIds] = args as [string, string[]]
        w.environments = w.environments.map((e) => (e.id === envId ? { ...e, productIds } : e))
        w.products = w.products.map((p) => ({
          ...p,
          environmentIds: productIds.includes(p.id)
            ? [...new Set([...p.environmentIds, envId])]
            : p.environmentIds.filter((id) => id !== envId),
        }))
        return w.environments.find((e) => e.id === envId)
      }
      case 'env:delete':
        w.environments = w.environments.filter((e) => e.id !== args[0])
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

  it('renders the tree', async () => {
    const user = userEvent.setup()
    const w = world()
    renderPage(w)
    const acme = await screen.findByRole('treeitem', { name: 'Acme' })
    expect(acme).toHaveAttribute('aria-expanded', 'true')
    expect(acme).toHaveAttribute('aria-level', '1')
    expect(within(item('analytics-db')).getByText('Shared')).toBeInTheDocument()
    expect(item('prod')).toHaveAttribute('aria-level', '2')

    const all = new Set(['p:acme', 'p:essentials', 'p:acme/e:prod'])
    const order = buildTree({ ...w, identities: [], vaults: [] }, all).map((r) => r.label)
    expect(items().map((el) => el.getAttribute('aria-label'))).toEqual(order)

    await user.click(chevron(acme))
    expect(acme).toHaveAttribute('aria-expanded', 'false')
    expect(items().map((el) => el.getAttribute('aria-label'))).toEqual(['Acme', 'Essentials', 'analytics-db'])
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
    expect(last).toHaveAttribute('aria-label', 'analytics-db')
    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(item('Acme')).toHaveFocus()
    expect(item('Acme')).toHaveAttribute('aria-selected', 'true')
  })

  it('protected and shared state is in the row description', async () => {
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    expect(item('prod')).toHaveAccessibleDescription('Protected')
    expect(item('analytics-db')).toHaveAccessibleDescription('Shared')
    expect(item('staging')).not.toHaveAccessibleDescription()
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
    w.environments = w.environments.map((e) => ({ ...e, productIds: e.productIds.filter((id) => id !== 'essentials') }))
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
    expect(screen.getByRole('treeitem', { name: 'Essentials' })).toHaveAttribute('aria-selected', 'true')
  })

  it('EnvironmentView host row Connect passes the environment', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(item('prod'))
    const details = screen.getByRole('region', { name: 'Details' })
    await user.click(await within(details).findByRole('button', { name: 'Connect to web-1' }))
    await waitFor(() => expect(where).toBe('/terminals'))
    expect(sessions.openSsh).toHaveBeenCalledWith('web1', 'prod')
  })

  it('a service row Deploy opens the deploy wizard with only that service ticked', async () => {
    const user = userEvent.setup()
    renderPage(world(), {
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'core', environmentId: 'prod', hostId: 'web1' })],
      'service:list': [
        appService({ id: 's1', name: 'api', environmentId: 'prod', deploymentId: 'd1' }),
        appService({ id: 's2', name: 'worker', environmentId: 'prod', deploymentId: 'd1', position: 1 }),
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
    expect(within(dialog).getByRole('button', { name: 'Acme' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByRole('button', { name: 'Essentials' })).toHaveAttribute('aria-pressed', 'false')
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
        productIds: ['acme'],
      }),
    )
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
    await within(main).findByText('No hosts in this environment yet')
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

  it('shared host updates everywhere', async () => {
    const { invoke } = renderPage()
    const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
    const staging = item('staging')
    fireEvent.dragStart(web1, { dataTransfer: dataTransfer() })
    expect(staging).toHaveAttribute('data-drop-target', 'true')
    // prod already holds web-1, so it isn't offered.
    expect(item('prod')).not.toHaveAttribute('data-drop-target')
    fireEvent.dragOver(staging, { dataTransfer: dataTransfer() })
    fireEvent.drop(staging, { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:putHost', 'staging', 'web1', 'app'))
    expect(await screen.findByText('Added web-1 to staging')).toBeInTheDocument()

    await waitFor(() => expect(screen.getAllByRole('treeitem', { name: 'web-1' })).toHaveLength(2))
    const [inProd, inStaging] = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(within(inStaging).getByText('Shared')).toBeInTheDocument()
    fireEvent.mouseEnter(inProd)
    expect(inStaging).toHaveAttribute('data-shared-highlight', 'true')
    expect(inStaging).toHaveAttribute('data-pulse', 'true')
    expect(inProd).not.toHaveAttribute('data-shared-highlight')
    fireEvent.mouseLeave(inProd)
    expect(inStaging).not.toHaveAttribute('data-shared-highlight')

    // A drop that changes nothing is ignored.
    fireEvent.dragStart(inProd, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('prod'), { dataTransfer: dataTransfer() })
    expect(invoke.mock.calls.filter(([c]) => c === 'env:putHost')).toHaveLength(1)
  })

  it('drops an environment on a product', async () => {
    const { invoke } = renderPage()
    const staging = await screen.findByRole('treeitem', { name: 'staging' })
    fireEvent.dragStart(staging, { dataTransfer: dataTransfer() })
    expect(item('Essentials')).toHaveAttribute('data-drop-target', 'true')
    expect(item('Acme')).not.toHaveAttribute('data-drop-target')
    fireEvent.drop(item('Essentials'), { dataTransfer: dataTransfer() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:setProducts', 'staging', ['acme', 'essentials']))
  })

  it('a drop in flight blocks further drops', async () => {
    const { invoke } = renderPage()
    const run = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    invoke.mockImplementation(async (c: string, ...a: unknown[]) => (c === 'env:putHost' ? gate.then(() => run(c, ...a)) : run(c, ...a)))
    const web1 = await screen.findByRole('treeitem', { name: 'web-1' })
    fireEvent.dragStart(web1, { dataTransfer: dataTransfer() })
    fireEvent.drop(item('staging'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(web1, { dataTransfer: dataTransfer() })
    expect(item('analytics-db')).not.toHaveAttribute('data-drop-target')
    fireEvent.drop(item('analytics-db'), { dataTransfer: dataTransfer() })
    expect(invoke.mock.calls.filter(([c]) => c === 'env:putHost')).toHaveLength(1)
    await act(async () => release())
    expect(await screen.findByText('Added web-1 to staging')).toBeInTheDocument()
  })

  it('hover and drag state clear when their row leaves the tree', async () => {
    renderPage(sharedWorld())
    await screen.findByRole('treeitem', { name: 'Acme' })
    const [inProd, inStaging] = screen.getAllByRole('treeitem', { name: 'web-1' })
    fireEvent.mouseEnter(inProd)
    expect(inStaging).toHaveAttribute('data-shared-highlight', 'true')
    fireEvent.click(chevron(item('prod')))
    expect(inStaging).not.toHaveAttribute('data-shared-highlight')

    fireEvent.click(chevron(item('prod')))
    fireEvent.dragStart(screen.getAllByRole('treeitem', { name: 'web-1' })[0], { dataTransfer: dataTransfer() })
    expect(item('analytics-db')).toHaveAttribute('data-drop-target', 'true')
    fireEvent.click(chevron(item('prod')))
    expect(item('analytics-db')).not.toHaveAttribute('data-drop-target')
  })

  it('removing a host asks first', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage(sharedWorld())
    await user.click(await screen.findByRole('treeitem', { name: 'staging' }))
    // Visible without hovering: never opacity-0, and it says what it does.
    const remove = screen.getByRole('button', { name: 'Remove web-1 from staging' })
    expect(remove.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    expect(remove).toHaveTextContent('Remove')
    // The word itself is always rendered, not collapsed until hover.
    expect(within(remove).getByText('Remove').className).not.toMatch(/(^|\s)(max-w-0|opacity-0|sr-only|hidden)(\s|$)/)
    await user.click(remove)
    const dialog = await screen.findByRole('dialog', { name: 'Remove web-1 from staging?' })
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove host' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:removeHost', 'staging', 'web1'))
    expect(await screen.findByText('Removed web-1 from staging')).toBeInTheDocument()
  })

  it('removing a host from a protected environment types the name', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    await user.click(screen.getByRole('button', { name: 'Remove web-1 from prod' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove web-1 from prod?' })
    const confirm = within(dialog).getByRole('button', { name: 'Remove host' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod')
    await user.click(confirm)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:removeHost', 'prod', 'web1'))
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

  it('deleting a shared environment names its other products', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(item('analytics-db', 0))
    await screen.findByRole('heading', { name: 'analytics-db', level: 2 })
    await user.click(screen.getByRole('button', { name: 'analytics-db options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete analytics-db?' })
    expect(dialog).toHaveTextContent('Essentials')
  })

  it('removes a shared environment from one product only', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await screen.findByRole('treeitem', { name: 'Acme' })
    await user.click(item('analytics-db', 0))
    await screen.findByRole('heading', { name: 'analytics-db', level: 2 })
    await user.click(screen.getByRole('button', { name: 'analytics-db options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Acme' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:setProducts', 'analytics', ['essentials']))
    expect(invoke).not.toHaveBeenCalledWith('env:delete', expect.anything())
    await waitFor(() => expect(screen.getAllByRole('treeitem', { name: 'analytics-db' })).toHaveLength(1))
    await waitFor(() => expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:essentials/e:analytics'))
  })

  it("removes an environment from the product's card menu", async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await screen.findByRole('heading', { name: 'Acme', level: 2 })
    await user.click(screen.getByRole('button', { name: 'staging options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Acme' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('env:setProducts', 'staging', []))
    expect(await screen.findByText('Moved staging to Unassigned')).toBeInTheDocument()
  })

  it('environment view groups hosts and shows defaults', async () => {
    const user = userEvent.setup()
    const w = world()
    w.environments = w.environments.map((e) => (e.id === 'prod' ? { ...e, defaultPort: 2222, defaultIdentityId: 'id-deploy' } : e))
    renderPage(w)
    await user.click(await screen.findByRole('treeitem', { name: 'prod' }))
    const main = screen.getByRole('region', { name: 'Details' })
    expect(within(main).getByText('Protected')).toBeInTheDocument()
    expect(within(main).getByRole('heading', { name: /App/ })).toHaveTextContent('1')
    expect(within(main).getByText('2222')).toBeInTheDocument()
    expect(within(main).getAllByText('Inherited from prod')).toHaveLength(2)
    expect(within(main).getByText('App default')).toBeInTheDocument()

    await user.click(item('staging'))
    expect(await within(main).findByText('No hosts in this environment yet')).toBeInTheDocument()
  })

  it('a host selection opens the host view in its environment', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await user.click(await screen.findByRole('treeitem', { name: 'web-1' }))
    const main = screen.getByRole('region', { name: 'Details' })
    expect(await within(main).findByRole('heading', { name: 'web-1', level: 2 })).toBeInTheDocument()
    expect(within(main).getByRole('region', { name: 'Connection' })).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:resolve', 'web1', 'prod'))
    expect(within(main).getByRole('radio', { name: 'prod' })).toHaveAttribute('aria-checked', 'true')
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
    await waitFor(() => expect(new URLSearchParams(where.split('?')[1]).get('node')).toBe('p:acme/e:staging/h:new-host'))
    expect(await screen.findByRole('heading', { name: 'db-2', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: 'db-2' })).toHaveAttribute('aria-selected', 'true')
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
    const [inProd, inStaging] = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(inProd.style.transform).toBe('')
    expect(inProd.style.height).toBe('')
    fireEvent.mouseEnter(inProd)
    expect(inStaging).toHaveAttribute('data-shared-highlight', 'true')
    for (const el of items()) expect(el).not.toHaveAttribute('data-pulse')
  })

  it('motion-safe expand animates height and pulses shared rows', async () => {
    const user = userEvent.setup()
    renderPage(sharedWorld())
    const prod = await screen.findByRole('treeitem', { name: 'prod' })
    await user.click(chevron(prod))
    await user.click(chevron(prod))
    const [inProd, inStaging] = screen.getAllByRole('treeitem', { name: 'web-1' })
    expect(inProd.style.height).not.toBe('')
    fireEvent.mouseEnter(inProd)
    expect(inStaging).toHaveAttribute('data-shared-highlight', 'true')
    expect(inStaging).toHaveAttribute('data-pulse', 'true')
  })
})
