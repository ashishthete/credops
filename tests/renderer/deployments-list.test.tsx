import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetLatest } from '../../src/renderer/src/deploy/latest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { rowLabel } from '../../src/renderer/src/pages/deployments/EnvList'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { EnvLastRelease, ReleaseStatus } from '../../src/shared/deploy'
import { appService, deploymentMeta, emitBridgeEvent, envSettings, environment, host, mockBridge, product, REGION, toolingOk } from './helpers'

const STAMP = '2026-10-16T09:00:00.000Z'
const PRODUCTS = ['Shop', 'Billing', 'Search']
const ENVS = ['dev', 'qa', 'staging', 'prod']
// 12 environments: p<i>-<env>, four per product, each on its own host.
const envs = PRODUCTS.flatMap((_, p) =>
  ENVS.map((name, i) => environment({ id: `p${p}-${name}`, name: `${PRODUCTS[p].toLowerCase()}-${name}`, productId: `p${p}`, protected: name === 'prod', hosts: [{ hostId: `h${p}${i}`, role: 'app' }] })),
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
  operation: null,
  playbookSource: 'generated',
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

  it('the header menu offers Import deployments… and Export deployments…', async () => {
    const invoke = world()
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Import or export deployments' }))
    await user.click(screen.getByRole('menuitem', { name: 'Export deployments…' }))
    expect(invoke).toHaveBeenCalledWith('config:export', 'deployments')
    await user.click(screen.getByRole('button', { name: 'Import or export deployments' }))
    expect(screen.getByRole('menuitem', { name: 'Import deployments…' })).toBeInTheDocument()
  })

  it("groups each environment under its one product, after the product's own order, with no 'No product' group", async () => {
    // p1-x isn't in Billing's environmentIds yet: its productId still places it, after the listed ones.
    const extra = environment({ id: 'p1-x', name: 'billing-x', productId: 'p1' })
    world({ 'env:list': [extra, ...envs] })
    await open()
    const billing = await screen.findByRole('group', { name: 'Billing' })
    expect(rowNames(billing)).toEqual(['p1-dev', 'p1-qa', 'p1-staging', 'p1-prod', 'p1-x'])
    expect(screen.queryByRole('group', { name: 'No product' })).not.toBeInTheDocument()
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

  it('a rolled-back release reads rolled back and shows the commit that is live, not the one rolled back', async () => {
    world({ 'release:latest': [last('p0-dev', 'rolled_back')] })
    await open()
    const shop = await screen.findByRole('group', { name: 'Shop' })
    const dev = within(shop).getByRole('listitem', { name: 'shop-dev' })
    const btn = await within(dev).findByRole('button', { name: /^shop-dev, last release rolled back .*, aaaaaaa is running$/ })
    expect(btn).toBeInTheDocument()
    expect(dev).not.toHaveTextContent('aaaaaaa→bbbbbbb')
    const commit = within(dev).getByText('aaaaaaa')
    expect(commit).toHaveAttribute('title', 'bbbbbbb was rolled back; aaaaaaa is running')
    expect(within(dev).getByText('bbbbbbb')).toHaveClass('line-through')
    // It needs a look: it floats up with the failed ones.
    expect(rowNames(shop)[0]).toBe('p0-dev')
  })

  it('a rolled-back first deploy has no live commit to show', () => {
    const row = { id: 'e', name: 'qa', protected: false, productName: 'P', hosts: [], regions: [], units: 1, hub: false }
    expect(rowLabel({ ...row, last: last('e', 'rolled_back', { previousCommit: null }) })).toMatch(/^qa, last release rolled back [^,]*$/)
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

  it("a row shows its environment's regions, and search finds environments by region", async () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    world({ 'region:list': [REGION, us], 'host:list': hosts.map((h) => (h.id === 'h10' ? { ...h, regionId: us.id } : h)) })
    const user = await open()
    const billing = await screen.findByRole('group', { name: 'Billing' })
    const row = (id: string) => within(billing).getAllByRole('listitem').find((li) => li.getAttribute('data-env') === id)!
    expect(within(row('p1-dev')).getByText('us-east-1')).toHaveAttribute('title', 'US East')
    expect(within(row('p1-qa')).getByText('test-1')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Search environments' }), 'us east')
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-env'))).toEqual(['p1-dev'])
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
    expect(card).toHaveTextContent('main → to deployed')
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

  it('Settings opens by itself for a risk with no fix: a protected environment with versioned releases off prod', async () => {
    const invoke = world({
      'deploy:settings': envSettings({ environmentId: 'p0-staging', versioned: true }),
      'env:list': envs.map((e) => (e.id === 'p0-staging' ? { ...e, protected: true } : e)),
    })
    await open('/deployments?env=p0-staging')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Settings/ })).toHaveAttribute('aria-expanded', 'true'))
    expect(await screen.findByRole('button', { name: /^Compared with unified_release\.sh/ })).toHaveTextContent('1 difference')
    // Settings and the comparison share one read of the QA settings.
    expect((invoke.mock.calls as unknown[][]).filter((c) => c[0] === 'integration:get')).toHaveLength(1)
  })

  it('Settings remembers what it was for each environment this session', async () => {
    world({ 'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', environmentId: 'p0-dev', hostId: 'h00' })] })
    const user = await open('/deployments?env=p0-dev')
    const toggle = () => screen.getByRole('button', { name: /^Settings/ })
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'))
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', { name: 'Deployments' }))
    await user.click(within(await screen.findByRole('listitem', { name: 'shop-dev' })).getByRole('button', { name: /^shop-dev,/ }))
    await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    // Still collapsed once the comparison has been read again.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Settings' })).not.toHaveAttribute('aria-busy'))
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).not.toHaveAttribute('aria-controls')
  })

  it('Deploy on a checkout with no services ticks the whole checkout', async () => {
    world({ 'deploy:list': [...deployments, deploymentMeta({ id: 'd-bare', name: 'static-site', environmentId: 'p2-dev', hostId: 'h20' })] })
    const user = await open()
    const row = await screen.findByRole('listitem', { name: 'search-dev' })
    await user.click(within(row).getByRole('button', { name: 'Deploy to search-dev' }))
    const wizard = await screen.findByRole('dialog', { name: 'Deploy to search-dev' })
    expect(within(within(wizard).getByRole('group', { name: 'static-site' })).getByRole('checkbox', { name: 'Whole checkout' })).toBeChecked()
    expect(within(wizard).getByRole('button', { name: 'Run preflight' })).toBeEnabled()
  })

  it('a link to an environment that has not arrived yet waits for it instead of showing the list', async () => {
    world()
    render(
      <MemoryRouter initialEntries={['/deployments?env=p0-qa']}>
        <DeploymentsPage />
        <Where />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('environment-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('deployments-loading')).not.toBeInTheDocument()
    await act(async () => {
      await loadInventory()
    })
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Deployments›Shop›shop-qa')
    expect(screen.getByTestId('where')).toHaveTextContent('/deployments?env=p0-qa')
  })

  it('a link to an environment that is gone goes to the list, replacing the link', async () => {
    world()
    await open('/deployments?env=gone')
    expect(await screen.findByRole('group', { name: 'Shop' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/deployments$/))
  })

  it('opening an environment focuses its name; going back focuses its row', async () => {
    world()
    const user = await open()
    await user.click(within(await screen.findByRole('listitem', { name: 'billing-qa' })).getByRole('button', { name: /^billing-qa,/ }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'billing-qa' })).toHaveFocus())
    await user.click(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', { name: 'Deployments' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^billing-qa,/ })).toHaveFocus())
  })

  it('Home and End move to the first and last row', async () => {
    world()
    const user = await open()
    const row = await screen.findByRole('button', { name: /^billing-qa,/ })
    row.focus()
    await user.keyboard('{End}')
    expect(screen.getAllByRole('button', { name: /^search-/ }).at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getAllByRole('button', { name: /^shop-/ })[0]).toHaveFocus()
  })

  it('a deployment card reads its branch to tag and describes itself with its repo path', async () => {
    world({ 'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', environmentId: 'p0-dev', hostId: 'h00', repoPath: '/srv/api' })] })
    await open('/deployments?env=p0-dev')
    const card = await screen.findByRole('listitem', { name: 'api' })
    expect(card).toHaveAccessibleDescription(/\/srv\/api/)
    expect(within(card).getByText('to')).toHaveClass('sr-only')
  })

  it('a Hub environment with no events reads last release unknown; a local one no releases yet', () => {
    const row = { id: 'e', name: 'prod-eu', protected: false, productName: 'Team', hosts: [], regions: [], units: 1 }
    expect(rowLabel({ ...row, hub: true })).toBe('prod-eu, last release unknown')
    expect(rowLabel({ ...row, hub: false })).toBe('prod-eu, no releases yet')
  })

  it('relative times on the rows keep moving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(STAMP) + 10_000 })
    try {
      world()
      await open()
      const row = await screen.findByRole('button', { name: /^billing-qa,/ })
      expect(row).toHaveAccessibleName('billing-qa, last release succeeded just now')
      await act(async () => {
        vi.advanceTimersByTime(90_000)
      })
      expect(row).toHaveAccessibleName('billing-qa, last release succeeded 1 minute ago')
    } finally {
      vi.useRealTimers()
    }
  })
})
