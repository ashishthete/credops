import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createService, deployStore, loadDeploy, openServiceTunnel, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { EnvironmentView } from '../../src/renderer/src/pages/products/EnvironmentView'
import { ServicesSection } from '../../src/renderer/src/pages/products/services/ServicesSection'
import { STATE_WORD } from '../../src/renderer/src/pages/tunnels/TunnelCard'
import { resetTunnels, tunnelStore } from '../../src/renderer/src/tunnels/store'
import { ConfirmDialog, type ConfirmRequest } from '../../src/renderer/src/ui/common'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { ServiceMeta } from '../../src/shared/services'
import type { TunnelState } from '../../src/shared/tunnels'
import { appService, dbService, deploymentMeta, environment, host, mockBridge, REGION, tunnelMeta, tunnelRuntime } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through its hook directly.
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => reduced.on,
}))

const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] })
const prod = environment({ id: 'e2', name: 'prod', protected: true, hosts: [{ hostId: 'h1', role: 'app' }] })

const checkouts = [
  deploymentMeta({ id: 'd2', name: 'web', hostId: 'h2', position: 1, repoUrl: null, repoPath: '/srv/web', defaultBranch: 'release', deployTag: 'web-staging' }),
  deploymentMeta({ id: 'd1', name: 'core', hostId: 'h1', position: 0, repoUrl: 'git@github.com:acme/core.git', repoPath: '/srv/core', defaultBranch: 'main' }),
]

const SERVICES: ServiceMeta[] = [
  appService({ id: 's1', name: 'api', deploymentId: 'd1', position: 2, lastDeployedCommit: 'abc1234def5678', lastReleaseId: '0190a5c2-0000-7000-8000-000000000001' }),
  appService({ id: 's2', name: 'worker', deploymentId: 'd1', position: 0, composeService: 'jobs', lastDeployedCommit: 'fed9876cba5432', lastReleaseId: '0190a5c2-0000-7000-8000-000000000002' }),
  appService({ id: 's3', name: 'site', deploymentId: 'd2', hostId: 'h2', position: 1, url: 'https://site.example.com' }),
  appService({ id: 's4', name: 'cron', deploymentId: null, position: 3, url: 'https://cron.example.com' }),
  dbService({ id: 'b1', name: 'main-db', position: 4, localPort: 15432, tunnelId: 't1' }),
]

const world = (extra: Record<string, unknown> = {}) =>
  mockBridge({
    'env:list': [staging, prod],
    'host:list': [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2' })],
    'deploy:list': checkouts,
    'service:list': SERVICES,
    ...extra,
  })

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

function tunnel(state: TunnelState) {
  tunnelStore.set({
    tunnels: [tunnelMeta({ id: 't1', label: 'main-db tunnel', bindPort: 15432 })],
    runtime: { t1: tunnelRuntime({ id: 't1', state, boundPort: state === 'up' ? 15432 : null }) },
    loaded: true,
  })
}

async function mount(envId = 'e1') {
  await loadInventory()
  await loadDeploy()
  const data = inventoryStore.get()!
  const env = data.environments.find((e) => e.id === envId)!
  const handlers = { onDeploy: vi.fn(), onLogs: vi.fn(), onCopy: vi.fn() }
  render(
    <MemoryRouter>
      <ServicesSection env={env} data={data} {...handlers} />
      <Toaster />
    </MemoryRouter>,
  )
  return handlers
}

const section = () => screen.getByRole('region', { name: 'Services' })
const group = (name: string) => within(section()).getByRole('region', { name })
const row = (name: string) => within(section()).getByRole('listitem', { name })

describe('services section', () => {
  beforeEach(() => {
    reduced.on = false
    inventoryStore.set(null)
    resetDeploy()
    resetTunnels()
    clearToasts()
  })

  it('services section renders first, grouped by checkout, databases last', async () => {
    world()
    await loadInventory()
    const data = inventoryStore.get()!
    render(
      <MemoryRouter>
        <EnvironmentView
          env={data.environments[0]}
          data={data}
          onNewHost={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </MemoryRouter>,
    )
    const services = await screen.findByRole('region', { name: 'Services' })
    await within(services).findByRole('region', { name: 'core' })
    // Checkouts in position order, then apps without one, then Databases.
    const groups = within(services)
      .getAllByRole('region')
      .map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['core', 'web', 'Apps without a checkout', 'Databases'])
    expect(within(services).getByRole('heading', { name: /^Services/ })).toHaveTextContent('5')
    // Services within a checkout in position order.
    const core = within(services).getByRole('region', { name: 'core' })
    expect(within(core).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['worker', 'api'])
  })

  it('the environment view wires Logs, Deploy… and Copy to…', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:logs': 'f1', 'containers:unfollow': undefined })
    await loadInventory()
    const data = inventoryStore.get()!
    render(
      <MemoryRouter>
        <EnvironmentView env={data.environments[0]} data={data} onNewHost={() => {}} onEdit={() => {}} onDelete={() => {}} />
      </MemoryRouter>,
    )
    const services = await screen.findByRole('region', { name: 'Services' })
    await user.click(await within(services).findByRole('button', { name: 'Logs for api' }))
    expect(await screen.findByRole('dialog', { name: 'api logs on app1' })).toBeInTheDocument()
    await waitFor(() => expect(calls(invoke, 'service:logs').map((c) => c.slice(1))).toEqual([['s1', 200]]))
    await user.click(screen.getByRole('button', { name: 'Close logs' }))
    await waitFor(() => expect(calls(invoke, 'containers:unfollow').map((c) => c[1])).toEqual(['f1']))
    // Deploy… opens the picker with nothing ticked.
    await user.click(within(services).getByRole('button', { name: 'Deploy…' }))
    const wizard = await screen.findByRole('dialog', { name: 'Deploy to staging' })
    expect(within(wizard).getByRole('checkbox', { name: 'api' })).not.toBeChecked()
    await user.click(within(wizard).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deploy to staging' })).not.toBeInTheDocument())

    await user.click(within(services).getByRole('button', { name: 'Services options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy to…' }))
    expect(await screen.findByRole('dialog', { name: 'Copy services from staging' })).toBeInTheDocument()
  })

  it('checkout header shows repo, branch, path, host and last commit', async () => {
    world()
    await mount()
    const core = await waitFor(() => group('core'))
    expect(within(core).getByText('git@github.com:acme/core.git')).toBeInTheDocument()
    expect(within(core).getByText('main')).toBeInTheDocument()
    expect(within(core).getByText('/srv/core')).toBeInTheDocument()
    // The checkout's host, and each row names the host it runs on.
    expect(within(core).getAllByText('app1')).toHaveLength(3)
    expect(within(row('api')).getByTitle('Runs on app1')).toBeInTheDocument()
    // The newest of its services' commits (worker's release is the later one), 7 characters, and the tag.
    expect(within(core).getByTestId('checkout-commit')).toHaveTextContent('fed9876')
    expect(within(core).getByText('deployed-staging')).toBeInTheDocument()
    // No repo URL: the path stands in for it.
    const web = group('web')
    expect(within(web).getAllByText('/srv/web').length).toBeGreaterThan(0)
    expect(within(web).getByText('release')).toBeInTheDocument()
    expect(within(web).getAllByText('app2')).toHaveLength(2)
    expect(within(web).queryByTestId('checkout-commit')).not.toBeInTheDocument()
    // Rows: the compose service in mono and the commit or Never deployed.
    expect(within(row('worker')).getByText('jobs')).toHaveClass('font-mono')
    expect(within(row('worker')).getByText('fed9876')).toBeInTheDocument()
    expect(within(row('site')).getByText('Never deployed')).toBeInTheDocument()
    expect(within(row('cron')).getByText('No checkout')).toBeInTheDocument()
  })

  it('Deploy on a row calls onDeploy with that id; header Deploy calls it with none', async () => {
    const user = userEvent.setup()
    world()
    const h = await mount()
    await waitFor(() => group('core'))
    await user.click(within(row('api')).getByRole('button', { name: 'Deploy api' }))
    expect(h.onDeploy).toHaveBeenLastCalledWith(['s1'])
    await user.click(within(section()).getByRole('button', { name: 'Deploy…' }))
    expect(h.onDeploy).toHaveBeenLastCalledWith([])
    await user.click(within(row('api')).getByRole('button', { name: 'Logs for api' }))
    expect(h.onLogs).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    // A db row and a row with no checkout offer no Deploy.
    expect(within(row('main-db')).queryByRole('button', { name: /^Deploy/ })).not.toBeInTheDocument()
    expect(within(row('cron')).queryByRole('button', { name: /^Deploy/ })).not.toBeInTheDocument()
    expect(within(row('cron')).queryByRole('button', { name: /^Logs/ })).not.toBeInTheDocument()
  })

  it('Open calls service:open; rows without a url have no Open', async () => {
    const user = userEvent.setup()
    const invoke = world()
    await mount()
    await waitFor(() => group('core'))
    await user.click(within(row('site')).getByRole('button', { name: 'Open site' }))
    await waitFor(() => expect(calls(invoke, 'service:open')).toEqual([['service:open', 's3']]))
    // No checkout: only Open works.
    await user.click(within(row('cron')).getByRole('button', { name: 'Open cron' }))
    await waitFor(() => expect(calls(invoke, 'service:open').at(-1)).toEqual(['service:open', 's4']))
    expect(within(row('api')).queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument()
  })

  it.each<[TunnelState, boolean]>([
    ['connecting', false],
    ['up', true],
    ['failed', false],
  ])('db row shows the address only when up (%s)', async (state, shown) => {
    world()
    tunnel(state)
    await mount()
    const db = await waitFor(() => row('main-db'))
    expect(within(db).getByText('postgres')).toBeInTheDocument()
    expect(within(db).getByText('10.0.0.5:5432')).toBeInTheDocument()
    expect(within(db).getByTitle('Runs on app1')).toHaveTextContent('app1')
    expect(within(db).getByText(STATE_WORD[state])).toBeInTheDocument()
    expect(within(db).queryByText('127.0.0.1:15432') !== null).toBe(shown)
    expect(within(db).queryByRole('button', { name: 'Copy 127.0.0.1:15432' }) !== null).toBe(shown)
    // Up or connecting closes; failed opens again.
    expect(within(db).getByRole('button', { name: state === 'failed' ? 'Open the main-db tunnel' : 'Close the main-db tunnel' })).toBeInTheDocument()
  })

  it('Tunnel opens and closes through the service channels', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:tunnelOpen': tunnelRuntime({ id: 't1', state: 'connecting' }) })
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'Open the main-db tunnel' })))
    await waitFor(() => expect(calls(invoke, 'service:tunnelOpen')).toEqual([['service:tunnelOpen', 'b1']]))
    act(() => tunnel('up'))
    await user.click(within(row('main-db')).getByRole('button', { name: 'Close the main-db tunnel' }))
    await waitFor(() => expect(calls(invoke, 'service:tunnelClose')).toEqual([['service:tunnelClose', 'b1']]))
  })

  it('copy button writes 127.0.0.1:<port>', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    world()
    tunnel('up')
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'Copy 127.0.0.1:15432' })))
    expect(writeText).toHaveBeenCalledWith('127.0.0.1:15432')
  })

  it('shows the empty state with one Add service; the dialog picks the type', async () => {
    const user = userEvent.setup()
    world({ 'service:list': [] })
    await mount()
    expect(await within(section()).findByText('No services yet')).toBeInTheDocument()
    expect(within(section()).queryByRole('button', { name: 'Add database' })).not.toBeInTheDocument()
    const adds = within(section()).getAllByRole('button', { name: 'Add service' })
    await user.click(adds[adds.length - 1])
    const dialog = await screen.findByRole('dialog', { name: 'Add service' })
    expect(within(dialog).getByRole('radio', { name: 'App' })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: 'Database' }))
    expect(within(dialog).getByRole('button', { name: 'Add database' })).toBeDisabled()
  })

  it('dialog defaults compose service to the name until edited', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:create': appService({ id: 's9', name: 'billing', deploymentId: 'd1', position: 5 }) })
    await mount()
    await waitFor(() => group('core'))
    await user.click(within(section()).getByRole('button', { name: 'Services options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add service' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add service' })
    const name = within(dialog).getByLabelText('Name')
    const compose = within(dialog).getByLabelText('Compose service')
    await user.type(name, 'bill')
    expect(compose).toHaveValue('bill')
    await user.clear(compose)
    await user.type(compose, 'billing-svc')
    await user.type(name, 'ing')
    expect(compose).toHaveValue('billing-svc')
    await user.selectOptions(within(dialog).getByLabelText('Checkout'), 'core')
    // The checkout sets the host.
    expect(within(dialog).getByLabelText('Host')).toHaveValue('h1')
    expect(within(dialog).getByLabelText('Host')).toBeDisabled()
    await user.click(within(dialog).getByRole('radio', { name: 'The host' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add app' }))
    await waitFor(() => expect(calls(invoke, 'service:create')).toHaveLength(1))
    expect(calls(invoke, 'service:create')[0][1]).toEqual({
      kind: 'service',
      environmentId: 'e1',
      hostId: 'h1',
      name: 'billing',
      deploymentId: 'd1',
      composeService: 'billing-svc',
      url: null,
      urlCheckFrom: 'host',
      skipUnchanged: false,
    })
  })

  it('right-click on a service row opens its menu; Duplicate adds a copy with its own name and compose service', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:create': appService({ id: 's9', name: 'api copy', deploymentId: 'd1', position: 5 }) })
    await mount()
    await waitFor(() => group('core'))
    await user.pointer({ keys: '[MouseRight]', target: row('api') })
    const menu = screen.getByRole('menu', { name: 'api options' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Edit', 'Duplicate', 'Copy name', 'Delete'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))
    expect(screen.queryByRole('menu', { name: 'api options' })).toBeNull()
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate api' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('api copy')
    expect(within(dialog).getByLabelText('Compose service')).toHaveValue('api-copy')
    await user.click(within(dialog).getByRole('button', { name: 'Add app' }))
    await waitFor(() => expect(calls(invoke, 'service:create')).toHaveLength(1))
    expect(calls(invoke, 'service:create')[0][1]).toMatchObject({ kind: 'service', name: 'api copy', deploymentId: 'd1', composeService: 'api-copy' })
  })

  it('Duplicate on a db leaves the local port to be picked; Copy database address copies host:port', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    world()
    await mount()
    await waitFor(() => group('Databases'))
    await user.pointer({ keys: '[MouseRight]', target: row('main-db') })
    await user.click(screen.getByRole('menuitem', { name: 'Copy database address' }))
    const db = SERVICES[4] as Extract<ServiceMeta, { kind: 'db' }>
    expect(writeText).toHaveBeenCalledWith(`${db.dbAddress}:${db.dbPort}`)
    await user.click(within(row('main-db')).getByRole('button', { name: 'main-db options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate main-db' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('main-db copy')
    expect(within(dialog).getByLabelText(/Local port/)).toHaveValue('')
  })

  /** Opens Add service from the options menu and switches it to a database. */
  async function addDatabase(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(section()).getByRole('button', { name: 'Services options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add service' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add service' })
    await user.click(within(dialog).getByRole('radio', { name: 'Database' }))
    return dialog
  }

  it('db dialog prefills the port from the engine and asks for its host', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:create': dbService({ id: 'b9', name: 'cache', dbEngine: 'redis', dbPort: 6379, dbAddress: '127.0.0.1', hostId: 'h2' }) })
    await mount()
    await waitFor(() => group('core'))
    const dialog = await addDatabase(user)
    expect(within(dialog).getByLabelText('Port')).toHaveValue('5432')
    await user.selectOptions(within(dialog).getByLabelText('Engine'), 'redis')
    expect(within(dialog).getByLabelText('Port')).toHaveValue('6379')
    // The address is as seen from the host.
    expect(within(dialog).getByLabelText('Address')).toHaveValue('127.0.0.1')
    expect(within(dialog).getByText('For a managed database, the bastion that reaches it')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Local port')).toHaveAttribute('placeholder', 'Picked on first open')
    // No host, no save.
    await user.type(within(dialog).getByLabelText('Name'), 'cache')
    expect(within(dialog).getByRole('button', { name: 'Add database' })).toBeDisabled()
    await user.selectOptions(within(dialog).getByLabelText('Host'), 'h2')
    await user.click(within(dialog).getByRole('button', { name: 'Add database' }))
    await waitFor(() => expect(calls(invoke, 'service:create')).toHaveLength(1))
    expect(calls(invoke, 'service:create')[0][1]).toEqual({
      kind: 'db',
      environmentId: 'e1',
      name: 'cache',
      dbEngine: 'redis',
      dbAddress: '127.0.0.1',
      hostId: 'h2',
      dbPort: 6379,
      localPort: null,
    })
  })

  it('the host select groups every host by region and marks the environment\'s own', async () => {
    const user = userEvent.setup()
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    world({
      'host:list': [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2', regionId: us.id }), host({ id: 'h3', label: 'spare', regionId: us.id })],
      'region:list': [REGION, us],
    })
    await mount()
    await waitFor(() => group('core'))
    const dialog = await addDatabase(user)
    const groups = [...within(dialog).getByLabelText('Host').querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)])
    expect(groups).toEqual([
      ['test-1', ['app1 · in staging']],
      ['us-east-1', ['app2 · in staging', 'spare']],
    ])
  })

  it('rows carry a region chip only when the environment spans several', async () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    world({ 'host:list': [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2', regionId: us.id })], 'region:list': [REGION, us] })
    await mount()
    await waitFor(() => group('core'))
    expect(within(row('site')).getByText('us-east-1')).toBeInTheDocument()
    expect(within(row('api')).getByText('test-1')).toBeInTheDocument()
    expect(within(row('main-db')).getByText('test-1')).toBeInTheDocument()
  })

  it('one region, no row chips', async () => {
    world()
    await mount()
    await waitFor(() => group('core'))
    expect(within(section()).queryByText('test-1')).not.toBeInTheDocument()
  })

  it('declining the restart prompt shows Route changed; restart to apply', async () => {
    const user = userEvent.setup()
    const moved = dbService({ id: 'b1', name: 'main-db', position: 4, localPort: 15432, tunnelId: 't1', dbAddress: '10.0.0.9' })
    const invoke = world({ 'service:update': { service: moved, tunnelRestartNeeded: true } })
    tunnel('up')
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'main-db options' })))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit main-db' })
    const address = within(dialog).getByLabelText('Address')
    await user.clear(address)
    await user.type(address, '10.0.0.9')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'service:update')[0].slice(1)).toEqual(['b1', { dbAddress: '10.0.0.9' }]))
    const prompt = await screen.findByRole('dialog', { name: 'Restart the main-db tunnel with the new route?' })
    await user.click(within(prompt).getByRole('button', { name: 'Later' }))
    expect(await within(row('main-db')).findByText('Route changed; restart to apply')).toBeInTheDocument()
    expect(calls(invoke, 'service:tunnelSync')).toHaveLength(0)
    // Restarting from the row applies it.
    await user.click(within(row('main-db')).getByRole('button', { name: 'Restart the main-db tunnel' }))
    await waitFor(() => expect(calls(invoke, 'service:tunnelSync')).toEqual([['service:tunnelSync', 'b1']]))
    await waitFor(() => expect(within(row('main-db')).queryByText('Route changed; restart to apply')).not.toBeInTheDocument())
  })

  it('accepting the restart prompt syncs the tunnel', async () => {
    const user = userEvent.setup()
    const moved = dbService({ id: 'b1', name: 'main-db', position: 4, localPort: 15432, tunnelId: 't1', dbPort: 5433 })
    const invoke = world({ 'service:update': { service: moved, tunnelRestartNeeded: true } })
    tunnel('up')
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'main-db options' })))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit main-db' })
    const port = within(dialog).getByLabelText('Port')
    await user.clear(port)
    await user.type(port, '5433')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const prompt = await screen.findByRole('dialog', { name: 'Restart the main-db tunnel with the new route?' })
    await user.click(within(prompt).getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(calls(invoke, 'service:tunnelSync')).toEqual([['service:tunnelSync', 'b1']]))
    expect(within(row('main-db')).queryByText('Route changed; restart to apply')).not.toBeInTheDocument()
  })

  it('a failed restart from the prompt still marks the route changed', async () => {
    const user = userEvent.setup()
    const moved = dbService({ id: 'b1', name: 'main-db', position: 4, localPort: 15432, tunnelId: 't1', dbPort: 5433 })
    const invoke = world({ 'service:update': { service: moved, tunnelRestartNeeded: true } })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'service:tunnelSync') throw new Error('The tunnel could not restart')
      return base(channel)
    })
    tunnel('up')
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'main-db options' })))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit main-db' })
    const port = within(dialog).getByLabelText('Port')
    await user.clear(port)
    await user.type(port, '5433')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const prompt = await screen.findByRole('dialog', { name: 'Restart the main-db tunnel with the new route?' })
    await user.click(within(prompt).getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(calls(invoke, 'service:tunnelSync')).toHaveLength(1))
    expect(await within(row('main-db')).findByText('Route changed; restart to apply')).toBeInTheDocument()
  })

  it('deleting a db with a tunnel shows the checkbox checked; unchecking keeps the tunnel', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:delete': undefined })
    tunnel('stopped')
    await mount()
    await user.click(await waitFor(() => within(row('main-db')).getByRole('button', { name: 'main-db options' })))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete main-db?' })
    const box = within(confirm).getByRole('checkbox', { name: 'Also delete its tunnel main-db tunnel' })
    expect(box).toBeChecked()
    await user.click(box)
    await user.click(within(confirm).getByRole('button', { name: 'Delete service' }))
    await waitFor(() => expect(calls(invoke, 'service:delete')).toEqual([['service:delete', 'b1', { deleteTunnel: false }]]))
    await waitFor(() => expect(within(section()).queryByRole('listitem', { name: 'main-db' })).not.toBeInTheDocument())
  })

  it('deleting in a protected environment still needs the typed name', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'service:list': [appService({ id: 's7', name: 'api', environmentId: 'e2', deploymentId: null })], 'service:delete': undefined })
    await mount('e2')
    await user.click(await waitFor(() => within(row('api')).getByRole('button', { name: 'api options' })))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete api?' })
    expect(within(confirm).queryByRole('checkbox')).not.toBeInTheDocument()
    const go = within(confirm).getByRole('button', { name: 'Delete service' })
    expect(go).toBeDisabled()
    await user.type(within(confirm).getByLabelText('Type prod to confirm'), 'prod')
    await user.click(go)
    await waitFor(() => expect(calls(invoke, 'service:delete')).toEqual([['service:delete', 's7', { deleteTunnel: false }]]))
  })

  it('ConfirmDialog without option behaves as before', async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => {})
    const request: ConfirmRequest = { title: 'Delete it?', description: 'Gone for good.', confirmLabel: 'Delete', run }
    render(<ConfirmDialog request={request} onClose={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: 'Delete it?' })
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog).getByText("This can't be undone.")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]).toEqual([])
  })

  it('reorder sends service:reorder and restores on refusal', async () => {
    const user = userEvent.setup()
    const invoke = world()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'service:reorder') throw new Error('the order no longer matches; reload and try again')
      return base(channel)
    })
    await mount()
    await waitFor(() => group('core'))
    await user.click(within(section()).getByRole('button', { name: 'Services options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reorder' }))
    const list = await within(section()).findByRole('listbox', { name: 'Service order' })
    const order = () => within(list).getAllByRole('option').map((o) => o.textContent)
    expect(order()).toEqual(['worker', 'site', 'api', 'cron', 'main-db'])
    act(() => within(list).getByRole('option', { name: 'api' }).focus())
    expect(within(list).getByRole('option', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    expect(within(list).getByRole('option', { name: 'site' })).toHaveAttribute('aria-selected', 'false')
    await user.keyboard('{ArrowUp}')
    expect(order()).toEqual(['worker', 'api', 'site', 'cron', 'main-db'])
    expect(within(list).getByRole('option', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(calls(invoke, 'service:reorder')[0].slice(1)).toEqual(['e1', ['s2', 's1', 's3', 's4', 'b1']]))
    // Refused: the previous order is back.
    await waitFor(() =>
      expect(within(group('core')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['worker', 'api']),
    )
    expect(await screen.findByText("Couldn't reorder the services")).toBeInTheDocument()
  })

  it('saving a checkout on a non-member host toasts the membership', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'host:list': [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2' }), host({ id: 'h3', label: 'build1' })],
      'deploy:create': deploymentMeta({ id: 'd9', name: 'tools', hostId: 'h3', position: 2 }),
    })
    await mount()
    await waitFor(() => group('core'))
    await user.click(within(section()).getByRole('button', { name: 'Services options' }))
    await user.click(screen.getByRole('menuitem', { name: 'New checkout' }))
    const dialog = await screen.findByRole('dialog', { name: 'New checkout' })
    await user.type(within(dialog).getByLabelText('Name'), 'tools')
    await user.selectOptions(within(dialog).getByLabelText('Host'), 'build1')
    await user.type(within(dialog).getByLabelText('Repo path'), '/srv/tools')
    await user.type(within(dialog).getByLabelText('Deploy tag'), 'deployed-staging')
    const lists = calls(invoke, 'env:list').length
    await user.click(within(dialog).getByRole('button', { name: 'Create deployment' }))
    await waitFor(() => expect(calls(invoke, 'deploy:create')).toHaveLength(1))
    expect(await screen.findByText('Added build1 to staging as an app host')).toBeInTheDocument()
    // The inventory is read again, so the host shows under the environment.
    await waitFor(() => expect(calls(invoke, 'env:list').length).toBeGreaterThan(lists))
  })

  it('saving a checkout on a member host shows no membership toast', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'deploy:update': deploymentMeta({ id: 'd1', name: 'core-2', hostId: 'h1', position: 0 }) })
    await mount()
    await user.click(await waitFor(() => within(group('core')).getByRole('button', { name: 'Edit checkout core' })))
    const dialog = await screen.findByRole('dialog', { name: 'Edit checkout' })
    await user.type(within(dialog).getByLabelText('Name'), '-2')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'deploy:update')).toHaveLength(1))
    expect(screen.queryByText(/as an app host/)).not.toBeInTheDocument()
  })

  it('a tunnel open keeps the new local port and tunnel even when a local write lands during the reread', async () => {
    const invoke = world({ 'service:tunnelOpen': tunnelRuntime({ id: 't9', state: 'up' }), 'service:create': appService({ id: 's9', name: 'new', environmentId: 'e1' }) })
    await act(async () => {
      await loadInventory()
      await loadDeploy()
    })
    const base = invoke.getMockImplementation()!
    let release: (v: ServiceMeta[]) => void = () => {}
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'service:list' && args[0] === 'e1') return new Promise<ServiceMeta[]>((r) => (release = r))
      return base(channel)
    })
    let opening!: Promise<void>
    act(() => {
      opening = openServiceTunnel('b1')
    })
    await waitFor(() => expect(calls(invoke, 'service:list').some((c) => c[1] === 'e1')).toBe(true))
    await act(async () => void (await createService({ kind: 'service', environmentId: 'e1', name: 'new', deploymentId: null, composeService: 'new', url: null, urlCheckFrom: 'host' })))
    await act(async () => {
      release(SERVICES.map((x) => (x.id === 'b1' ? { ...x, localPort: 15999, tunnelId: 't9' } : x)))
      await opening
    })
    const b1 = deployStore.get().services.find((x) => x.id === 'b1')!
    expect(b1.kind === 'db' && [b1.localPort, b1.tunnelId]).toEqual([15999, 't9'])
    expect(deployStore.get().services.some((x) => x.id === 's9')).toBe(true)
  })

  it('reduced motion: no transforms in the section', async () => {
    reduced.on = true
    world()
    tunnel('up')
    await mount()
    await waitFor(() => group('core'))
    for (const li of within(section()).getAllByRole('listitem')) {
      expect(li.style.transform ?? '').toBe('')
    }
  })

  it('with motion on the rows do carry a transform (the control for the test above)', async () => {
    reduced.on = false
    world()
    tunnel('up')
    await mount()
    await waitFor(() => group('core'))
    const transforms = within(section())
      .getAllByRole('listitem')
      .map((li) => li.style.transform ?? '')
    expect(transforms.every((t) => t !== '')).toBe(true)
  })
})
