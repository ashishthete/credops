import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetLatest } from '../../src/renderer/src/deploy/latest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { EnvLastRelease, ReleaseStatus } from '../../src/shared/deploy'
import { appService, deploymentMeta, emitBridgeEvent, envSettings, environment, host, mockBridge, product, toolingOk } from './helpers'

const STAMP = '2026-10-16T09:00:00.000Z'
const PRODUCTS = ['Shop', 'Billing', 'Search']
const ENVS = ['dev', 'qa', 'staging', 'prod']
// 12 environments: p<i>-<env>, four per product, each on its own host.
const envs = PRODUCTS.flatMap((_, p) =>
  ENVS.map((name, i) => environment({ id: `p${p}-${name}`, name: `${PRODUCTS[p].toLowerCase()}-${name}`, protected: name === 'prod', hosts: [{ hostId: `h${p}${i}`, role: 'app' }] })),
)
const products = PRODUCTS.map((name, p) => product({ id: `p${p}`, name, environmentIds: ENVS.map((e) => `p${p}-${e}`) }))
const hosts = PRODUCTS.flatMap((_, p) => ENVS.map((e, i) => host({ id: `h${p}${i}`, label: `${PRODUCTS[p].toLowerCase()}-${e}-1` })))

const last = (environmentId: string, status: ReleaseStatus, over: Partial<EnvLastRelease> = {}): EnvLastRelease => ({
  id: `0190a1b2-c3d4-7e5f-8a6b-${environmentId.padStart(12, '0').slice(-12)}`,
  environmentId,
  environmentName: environmentId,
  kind: 'release',
  status,
  version: null,
  previousVersion: null,
  redeploy: false,
  rollbackOf: null,
  triggeredBy: 'ana@mbp',
  createdAt: STAMP,
  startedAt: STAMP,
  finishedAt: STAMP,
  deploymentCount: 1,
  hostCount: 1,
  serviceIds: [],
  serviceCount: 1,
  error: null,
  previousCommit: 'aaaaaaa1111',
  deployedCommit: 'bbbbbbb2222',
  ...over,
})

// Every environment but p2-dev has one checkout with two services, set up the way unified_release.sh runs.
const deployments = envs
  .filter((e) => e.id !== 'p2-dev')
  .map((e) =>
    deploymentMeta({
      id: `d-${e.id}`, name: `core-${e.id}`, environmentId: e.id, hostId: e.hosts[0].hostId,
      composeFile: '', useSudo: 'yes', buildTimeoutSec: 3600, composeTimeoutSec: 900,
    }),
  )
const services = deployments.flatMap((d) => [
  appService({ id: `s1-${d.environmentId}`, name: 'api', environmentId: d.environmentId, deploymentId: d.id }),
  appService({ id: `s2-${d.environmentId}`, name: 'web', environmentId: d.environmentId, deploymentId: d.id }),
])

function world(extra: Record<string, unknown> = {}) {
  return mockBridge({
    'product:list': products,
    'env:list': envs,
    'host:list': hosts,
    'deploy:tooling': toolingOk(),
    'deploy:settings': envSettings({ versioned: false }),
    'deploy:list': deployments,
    'service:list': services,
    'release:latest': [
      last('p0-dev', 'succeeded', { version: 'v1.4.0' }),
      last('p0-staging', 'failed'),
      last('p0-prod', 'running', { finishedAt: null }),
      last('p1-qa', 'succeeded'),
    ],
    ...extra,
  })
}

function Where() {
  const l = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <p data-testid="where">{l.pathname + l.search}</p>
      <button type="button" onClick={() => navigate(-1)}>
        Browser back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Browser forward
      </button>
    </>
  )
}

async function open(path = '/deployments') {
  await act(async () => {
    await loadInventory()
  })
  render(
    <MemoryRouter initialEntries={[path]}>
      <DeploymentsPage />
      <Where />
      <Toaster />
    </MemoryRouter>,
  )
  return userEvent.setup()
}

/** The row buttons' environment names, in order, within one product group. */
const rowNames = (group: HTMLElement) => within(group).getAllByRole('listitem').map((li) => li.getAttribute('data-env'))

describe('deployments environment list', () => {
  beforeEach(() => {
    inventoryStore.set(null)
    resetDeploy()
    resetLatest()
    clearToasts()
  })

  it('lists 12 environments grouped by product, with hosts, services and the last release', async () => {
    world()
    await open()
    const shop = await screen.findByRole('group', { name: 'Shop' })
    const billing = screen.getByRole('group', { name: 'Billing' })
    const search = screen.getByRole('group', { name: 'Search' })
    expect(rowNames(billing)).toEqual(['p1-dev', 'p1-qa', 'p1-staging', 'p1-prod'])
    expect(rowNames(search)).toEqual(['p2-dev', 'p2-qa', 'p2-staging', 'p2-prod'])
    expect(screen.getAllByRole('listitem')).toHaveLength(12)

    const dev = within(shop).getByRole('listitem', { name: 'shop-dev' })
    expect(dev).toHaveTextContent('shop-dev-1 · 2 services')
    await waitFor(() => expect(dev).toHaveTextContent('aaaaaaa→bbbbbbb'))
    expect(dev).toHaveTextContent('v1.4.0')
    // The row opens the environment; its name carries the status and the last release.
    expect(within(dev).getByRole('button', { name: /^shop-dev, last release succeeded/ })).toBeInTheDocument()
    expect(within(dev).getByRole('button', { name: 'Deploy to shop-dev' })).toBeInTheDocument()
    // A protected environment shows a lock.
    expect(within(within(shop).getByRole('listitem', { name: 'shop-prod' })).getByLabelText('Protected')).toBeInTheDocument()
  })

  it('running and failed environments float to the top of their product', async () => {
    world()
    await open()
    const shop = await screen.findByRole('group', { name: 'Shop' })
    await waitFor(() => expect(rowNames(shop)).toEqual(['p0-prod', 'p0-staging', 'p0-dev', 'p0-qa']))
    const prod = within(shop).getByRole('listitem', { name: 'shop-prod' })
    expect(within(prod).getByRole('button', { name: /^shop-prod, running/ })).toBeInTheDocument()
    expect(within(prod).getByText('Running')).toBeInTheDocument()
    expect(within(shop).getByRole('button', { name: /^shop-staging, last release failed/ })).toBeInTheDocument()
  })

  it('a release that starts moves its environment up live', async () => {
    world()
    await open()
    const billing = await screen.findByRole('group', { name: 'Billing' })
    await waitFor(() => expect(within(billing).getByRole('button', { name: /^billing-qa, last release succeeded/ })).toBeInTheDocument())
    act(() => emitBridgeEvent('release:state', { ...last('p1-staging', 'running'), id: '0190a1b2-c3d4-7e5f-8a6b-ffffffffffff' }))
    await waitFor(() => expect(rowNames(billing)[0]).toBe('p1-staging'))
  })

  it('search filters by environment, product and host name; the product filter narrows to one product', async () => {
    world()
    const user = await open()
    await screen.findByRole('group', { name: 'Shop' })
    const box = screen.getByRole('searchbox', { name: 'Search environments' })
    await user.type(box, 'staging')
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-env')).sort()).toEqual(['p0-staging', 'p1-staging', 'p2-staging'])
    await user.clear(box)
    await user.type(box, 'billing')
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    await user.clear(box)
    await user.type(box, 'search-qa-1')
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-env'))).toEqual(['p2-qa'])
    await user.clear(box)
    await user.type(box, 'nothing like this')
    expect(screen.getByText('No environments match')).toBeInTheDocument()
    await user.clear(box)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p2')
    expect(screen.queryByRole('group', { name: 'Shop' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Search' })).getAllByRole('listitem')).toHaveLength(4)
  })

  it('Deploy opens the wizard for that environment with all of its services ticked', async () => {
    world()
    const user = await open()
    const row = await screen.findByRole('listitem', { name: 'billing-staging' })
    await user.click(within(row).getByRole('button', { name: 'Deploy to billing-staging' }))
    const wizard = await screen.findByRole('dialog', { name: 'Deploy to billing-staging' })
    expect(within(wizard).getByRole('checkbox', { name: 'api' })).toBeChecked()
    expect(within(wizard).getByRole('checkbox', { name: 'web' })).toBeChecked()
    expect(within(wizard).getByRole('button', { name: 'Run preflight' })).toBeEnabled()
    // The user can untick.
    await user.click(within(wizard).getByRole('checkbox', { name: 'web' }))
    expect(within(wizard).getByRole('checkbox', { name: 'web' })).not.toBeChecked()
    // Deploy stays on the list.
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/deployments$/)
  })

  it('an environment with no deployments shows No services yet and Add service', async () => {
    world()
    const user = await open()
    const row = await screen.findByRole('listitem', { name: 'search-dev' })
    expect(row).toHaveTextContent('No services yet')
    expect(within(row).queryByRole('button', { name: /^Deploy to/ })).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Add service to search-dev' }))
    expect(await screen.findByRole('dialog', { name: 'New checkout' })).toBeInTheDocument()
  })

  it('a row opens the detail view with a breadcrumb and Settings collapsed; Back returns to the list', async () => {
    world()
    const user = await open()
    const row = await screen.findByRole('listitem', { name: 'billing-qa' })
    await user.click(within(row).getByRole('button', { name: /^billing-qa,/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/deployments?env=p1-qa')
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(crumbs).toHaveTextContent('Deployments›Billing›billing-qa')
    expect(within(crumbs).getByText('billing-qa')).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('listitem', { name: 'core-p1-qa' })).toBeInTheDocument()
    const settings = screen.getByRole('button', { name: /^Settings/ })
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('switch', { name: 'Versioned releases' })).not.toBeInTheDocument()
    await user.click(settings)
    expect(screen.getByRole('switch', { name: 'Versioned releases' })).toBeInTheDocument()

    await user.click(within(crumbs).getByRole('button', { name: 'Deployments' }))
    expect(await screen.findByRole('group', { name: 'Shop' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/deployments$/)
  })

  it('browser back and forward move between the list and an environment', async () => {
    world()
    const user = await open()
    await user.click(within(await screen.findByRole('listitem', { name: 'shop-qa' })).getByRole('button', { name: /^shop-qa,/ }))
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('shop-qa')
    await user.click(screen.getByRole('button', { name: 'Browser back' }))
    expect(await screen.findByRole('group', { name: 'Shop' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Browser forward' }))
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Deployments›Shop›shop-qa')
  })

  it('arrow keys move between rows and Enter opens one', async () => {
    world()
    const user = await open()
    const first = await screen.findByRole('button', { name: /^shop-prod,/ })
    await waitFor(() => expect(rowNames(screen.getByRole('group', { name: 'Shop' }))[0]).toBe('p0-prod'))
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: /^shop-staging,/ })).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('button', { name: /^shop-prod,/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Deployments›Shop›shop-prod')
  })

  it('a deep link to an environment opens its detail view', async () => {
    world()
    await open('/deployments?env=p2-prod')
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Deployments›Search›search-prod')
    expect(await screen.findByRole('listitem', { name: 'core-p2-prod' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Shop' })).not.toBeInTheDocument()
  })

  it('a deployment card is one line: name, branch to tag, sudo and URLs, with the repo path in its tooltip', async () => {
    world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', environmentId: 'p0-dev', hostId: 'h00', repoPath: '/srv/api', urls: [{ url: 'https://a.example.com', from: 'host' }] })],
    })
    await open('/deployments?env=p0-dev')
    const card = await screen.findByRole('listitem', { name: 'api' })
    expect(card).toHaveTextContent('api')
    expect(card).toHaveTextContent('main → deployed')
    expect(card).toHaveTextContent('sudo auto')
    expect(card).toHaveTextContent('1 URL')
    expect(within(card).getByText('api')).toHaveAttribute('title', '/srv/api')
    expect(within(card).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'api options' })).toBeInTheDocument()
  })

  it('Settings opens by itself when the comparison has differences', async () => {
    // The default deployment differs from unified_release.sh (sudo auto, short limits).
    world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', environmentId: 'p0-dev', hostId: 'h00' })],
      'integration:get': { environmentId: 'p0-dev', qa: null, qaOnDeploy: false, qaWait: false },
    })
    await open('/deployments?env=p0-dev')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Settings/ })).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByRole('region', { name: 'Compared with unified_release.sh' })).toBeInTheDocument()
  })
})
