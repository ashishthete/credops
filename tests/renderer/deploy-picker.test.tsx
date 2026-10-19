import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutNotice, pickerGroups, selectionRequest } from '../../src/renderer/src/deploy/picker'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeployWizard } from '../../src/renderer/src/pages/deployments/release/DeployWizard'
import type { CommitInfo, PreflightCheck, PreflightReport, RunEvent } from '../../src/shared/deploy'
import type { ServiceMeta } from '../../src/shared/services'
import { events, REL, releaseDetail } from './fixtures/release-events'
import { appService, dbService, deploymentMeta, emitBridgeEvent, envSettings, environment, host, mockBridge } from './helpers'

const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] })
const HOSTS = [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2' })]
const CHECKOUTS = [
  deploymentMeta({ id: 'd1', name: 'core', hostId: 'h1', position: 0, defaultBranch: 'main', repoPath: '/srv/core', repoUrl: 'git@github.com:acme/core.git' }),
  deploymentMeta({ id: 'd2', name: 'web', hostId: 'h1', position: 1, defaultBranch: 'main', repoPath: '/srv/web' }),
  deploymentMeta({ id: 'd3', name: 'site', hostId: 'h2', position: 2, defaultBranch: 'release', repoPath: '/srv/site', managedEnv: true, envTemplate: 'A=1' }),
]
const SERVICES: ServiceMeta[] = [
  appService({ id: 's1', name: 'api', deploymentId: 'd1', composeService: 'api', position: 0 }),
  appService({ id: 's2', name: 'worker', deploymentId: 'd1', composeService: 'worker', position: 1 }),
  appService({ id: 's3', name: 'site', deploymentId: 'd3', composeService: 'site', position: 2 }),
  appService({ id: 's5', name: 'site-worker', deploymentId: 'd3', composeService: 'site-worker', position: 3 }),
  appService({ id: 's6', name: 'legacy', deploymentId: null, composeService: 'legacy', position: 4 }),
  dbService({ id: 'b1', name: 'main-db', dbAddress: '10.0.0.5', dbPort: 5432, viaHostId: 'h1' }),
]

const commit = (n: number, deploymentId = 'd1'): CommitInfo => ({
  sha: `${String(n).padStart(2, '0')}${'c'.repeat(38)}`,
  subject: `change ${n}`,
  author: 'ana',
  date: '2026-10-18T10:00:00.000Z',
  deploymentId,
})

function report(over: Partial<PreflightReport> = {}): PreflightReport {
  return {
    releaseId: REL,
    checks: [],
    commits: {},
    dockerModes: {},
    composeServices: {},
    serviceCommits: {},
    locks: {},
    commitsTotal: 3,
    blocked: false,
    ...over,
  }
}

const check = (over: Partial<PreflightCheck> & { id: string }): PreflightCheck => ({ deploymentId: null, hostId: 'h1', label: over.id, level: 'ok', message: '', ...over })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

/** `persisted` is what `release:events` replays; a test can also push live batches. */
async function mount({ preselect = [] as string[], env = staging, persisted = [] as RunEvent[] } = {}) {
  const invoke = mockBridge({
    'env:list': [env],
    'host:list': HOSTS,
    'deploy:list': CHECKOUTS,
    'service:list': SERVICES,
    'deploy:settings': envSettings(),
    'release:preflight': { releaseId: REL },
    'release:get': releaseDetail({ status: 'preflight', runs: [] }),
    'release:active': [],
  })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') return persisted.filter((e) => e.seq > (args[1] as number))
    return base(channel)
  })
  await act(async () => {
    await loadInventory()
    await loadDeploy(['e1'])
  })
  const user = userEvent.setup()
  let closed = 0
  render(
    <MemoryRouter>
      <DeployWizard environmentId="e1" preselect={preselect} onClose={() => closed++} />
    </MemoryRouter>,
  )
  const dialog = await screen.findByRole('dialog', { name: 'Deploy to staging' })
  return { invoke, user, dialog, closed: () => closed }
}

const box = (scope: HTMLElement, name: string) => within(scope).getByRole('checkbox', { name })
const group = (dialog: HTMLElement, name: string) => within(dialog).getByRole('group', { name })

async function preflight(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('button', { name: 'Run preflight' }))
  await screen.findByRole('list', { name: 'Preflight checks' })
}

afterEach(() => {
  cleanup()
  resetReleases()
  resetDeploy()
  inventoryStore.set(null)
})

describe('picker helpers', () => {
  it('groups services by checkout; a checkout without services is whole only when ticked', () => {
    const { groups, unavailable } = pickerGroups(SERVICES, CHECKOUTS, new Set(['s1', 's2', 's3']), new Set(['d2']))
    expect(groups.map((g) => [g.checkout.name, g.services.map((s) => s.name), g.whole, g.partial])).toEqual([
      ['core', ['api', 'worker'], true, false],
      ['web', [], true, false],
      ['site', ['site', 'site-worker'], false, true],
    ])
    expect(unavailable.map((s) => s.name)).toEqual(['legacy'])
    expect(selectionRequest(groups)).toEqual({ serviceIds: ['s1', 's2', 's3'], checkoutIds: ['d2'] })
    expect(checkoutNotice(groups[0], null)).toEqual([])
  })

  it('notice copy for several unselected services and known compose services', () => {
    const more = [...SERVICES, appService({ id: 's7', name: 'cron', deploymentId: 'd3', composeService: 'cron', position: 5 })]
    const { groups } = pickerGroups(more, CHECKOUTS, new Set(['s3']), new Set())
    expect(checkoutNotice(groups[2], ['site', 'site-worker', 'cron', 'redis', 'db'], ['db'])).toEqual([
      'Updates code for site to release. Only site is rebuilt and restarted.',
      'site-worker and cron keep running their current images; they will pick up the new code the next time they are deployed or restarted.',
      "Compose services OpsDeck doesn't track (redis) are not restarted.",
      'The managed .env is rewritten for the whole checkout.',
    ])
    expect(checkoutNotice(groups[2], ['site', 'site-worker', 'cron'])).not.toContainEqual(expect.stringContaining('track'))
  })
})

describe('deploy wizard', () => {
  it('All ticks every deployable service and no db', async () => {
    const { user, dialog } = await mount()
    for (const name of ['api', 'worker', 'site', 'site-worker']) expect(box(dialog, name)).not.toBeChecked()
    await user.click(box(dialog, 'All'))
    for (const name of ['api', 'worker', 'site', 'site-worker']) expect(box(dialog, name)).toBeChecked()
    expect(box(group(dialog, 'web'), 'Whole checkout')).toBeChecked()
    expect(within(dialog).queryByRole('checkbox', { name: /main-db/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByText('main-db')).not.toBeInTheDocument()
    expect(box(dialog, 'legacy')).not.toBeChecked()
    await user.click(box(dialog, 'All'))
    expect(box(dialog, 'api')).not.toBeChecked()
  })

  it('a fully ticked group is whole checkout; partial shows the notice naming every unselected service', async () => {
    const { user, dialog } = await mount()
    const core = group(dialog, 'core')
    expect(within(core).getByText('git@github.com:acme/core.git')).toBeInTheDocument()
    expect(within(core).getByText('main')).toBeInTheDocument()
    expect(within(core).getByText('app1')).toBeInTheDocument()
    await user.click(box(core, 'All of core'))
    expect(box(core, 'api')).toBeChecked()
    expect(box(core, 'worker')).toBeChecked()
    expect(within(core).getByText('whole checkout')).toBeInTheDocument()
    expect(within(core).queryByRole('list', { name: 'What happens to core' })).not.toBeInTheDocument()

    await user.click(box(core, 'worker'))
    expect(within(core).queryByText('whole checkout')).not.toBeInTheDocument()
    const notice = within(core).getByRole('list', { name: 'What happens to core' })
    expect(within(notice).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Updates code for core to main. Only api is rebuilt and restarted.',
      'worker keeps running its current image; it will pick up the new code the next time it is deployed or restarted.',
      'Other compose services in this checkout are not restarted.',
    ])
  })

  it('notice lists untracked compose services once preflight reports them, else says others are not restarted', async () => {
    const done = report({
      composeServices: { d3: ['site', 'site-worker', 'redis', 'db'] },
      composeDatabases: { d3: ['db'] },
      checks: [check({ id: 'repo', deploymentId: 'd3', hostId: 'h2' })],
    })
    const { user, dialog } = await mount({ preselect: ['s3'], persisted: events([{ type: 'preflight.done', report: done }]) })
    expect(within(group(dialog, 'site')).getByText('Other compose services in this checkout are not restarted.')).toBeInTheDocument()
    await preflight(user, dialog)
    const notice = await within(dialog).findByRole('list', { name: 'What happens to site' })
    await waitFor(() => expect(within(notice).getByText("Compose services OpsDeck doesn't track (redis) are not restarted.")).toBeInTheDocument())
    expect(within(notice).queryByText('Other compose services in this checkout are not restarted.')).not.toBeInTheDocument()
    expect(within(dialog).getByText('db (database, skipped)')).toBeInTheDocument()
  })

  it('a compose database shows as a skipped row with no checkbox and stays out of the notice', async () => {
    const done = report({
      composeServices: { d3: ['site', 'site-worker', 'redis', 'postgres'] },
      composeDatabases: { d3: ['postgres'] },
      checks: [check({ id: 'repo', deploymentId: 'd3', hostId: 'h2' })],
    })
    const { user, dialog } = await mount({ preselect: ['s3'], persisted: events([{ type: 'preflight.done', report: done }]) })
    await preflight(user, dialog)
    const row = await within(dialog).findByText('postgres (database, skipped)')
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox', { name: /postgres/ })).not.toBeInTheDocument()
    const notice = within(dialog).getByRole('list', { name: 'What happens to site' })
    await waitFor(() => expect(within(notice).getByText("Compose services OpsDeck doesn't track (redis) are not restarted.")).toBeInTheDocument())
    expect(notice.textContent).not.toContain('postgres')
  })

  it('without composeDatabases no database rows appear', async () => {
    const done = report({
      composeServices: { d3: ['site', 'site-worker', 'postgres'] },
      checks: [check({ id: 'repo', deploymentId: 'd3', hostId: 'h2' })],
    })
    const { user, dialog } = await mount({ preselect: ['s3'], persisted: events([{ type: 'preflight.done', report: done }]) })
    await preflight(user, dialog)
    const notice = await within(dialog).findByRole('list', { name: 'What happens to site' })
    await waitFor(() => expect(within(notice).getByText("Compose services OpsDeck doesn't track (postgres) are not restarted.")).toBeInTheDocument())
    expect(within(dialog).queryByRole('list', { name: 'Databases' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/\(database, skipped\)/)).not.toBeInTheDocument()
  })

  it('notice mentions the managed .env rewrite', async () => {
    const { dialog } = await mount({ preselect: ['s3'] })
    const notice = within(group(dialog, 'site')).getByRole('list', { name: 'What happens to site' })
    expect(within(notice).getByText('The managed .env is rewritten for the whole checkout.')).toBeInTheDocument()
    expect(within(notice).getByText('site-worker keeps running its current image; it will pick up the new code the next time it is deployed or restarted.')).toBeInTheDocument()
  })

  it('preselect ticks only that service', async () => {
    const { dialog } = await mount({ preselect: ['s3'] })
    expect(box(dialog, 'site')).toBeChecked()
    for (const name of ['api', 'worker', 'site-worker']) expect(box(dialog, name)).not.toBeChecked()
    expect(box(group(dialog, 'web'), 'Whole checkout')).not.toBeChecked()
    cleanup()
    const empty = await mount()
    expect(within(empty.dialog).getByRole('button', { name: 'Run preflight' })).toBeDisabled()
  })

  it('services without a checkout are greyed out with the reason', async () => {
    const { dialog } = await mount()
    const legacy = box(dialog, 'legacy')
    expect(legacy).toBeDisabled()
    expect(within(legacy.closest('li')!).getByText('No checkout')).toBeInTheDocument()
  })

  it('preflight sends serviceIds and checkoutIds', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'] })
    expect(within(dialog).getByText('v1.2.0 → v1.3.0')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'patch' }))
    expect(within(dialog).getByText('v1.2.0 → v1.2.1')).toBeInTheDocument()
    await user.click(box(group(dialog, 'web'), 'Whole checkout'))
    expect(within(group(dialog, 'web')).getByText('whole checkout')).toBeInTheDocument()
    expect(box(dialog, 'Notify')).toBeDisabled()
    expect(box(dialog, 'Notify').closest('label')).toHaveAttribute('title', 'Available with notifications (Phase 9)')
    await preflight(user, dialog)
    expect(calls(invoke, 'release:preflight')[0][1]).toEqual({
      environmentId: 'e1',
      serviceIds: ['s1'],
      checkoutIds: ['d2'],
      bump: 'patch',
      options: { backup: true, notify: false, qa: false },
    })
  })

  it('deps warning shows and does not block Start', async () => {
    const { user, dialog } = await mount({ preselect: ['s1'] })
    await preflight(user, dialog)
    const start = within(dialog).getByRole('button', { name: 'Start' })
    expect(start).toBeDisabled()
    const deps = check({ id: 'deps', deploymentId: 'd1', label: 'Dependencies on app1', level: 'warn', message: 'redis is not running' })
    act(() => emitBridgeEvent('deploy:event', events([{ type: 'preflight.check', check: check({ id: 'repo', deploymentId: 'd1', label: 'Repo on app1' }) }, { type: 'preflight.check', check: deps }])))
    const list = within(dialog).getByRole('list', { name: 'Preflight checks' })
    expect(within(list).getByText('redis is not running')).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    act(() => emitBridgeEvent('deploy:event', events([{ type: 'preflight.done', report: report({ checks: [deps] }) }], 3)))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Start' })).toBeEnabled())
  })

  it('a blocking check disables Start and shows its fix', async () => {
    const dirty = check({ id: 'clean', deploymentId: 'd1', label: 'Clean on app1', level: 'block', message: 'Uncommitted changes on app1:/srv/core' })
    const { user, dialog } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.check', check: dirty }, { type: 'preflight.done', report: report({ checks: [dirty], blocked: true }) }]) })
    await preflight(user, dialog)
    await within(dialog).findByText('Uncommitted changes on app1:/srv/core')
    expect(within(dialog).getByText('git -C /srv/core status')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Start' })).toBeDisabled()
  })

  it('commits are grouped by service and show +n more when unknown', async () => {
    const list = Array.from({ length: 12 }, (_, i) => commit(i + 1))
    const done = report({
      commits: { d1: { commits: list, hiddenPairs: 0, truncated: 3, firstDeploy: false, head: list[0].sha, tagCommit: null } },
      serviceCommits: { s1: { since: null, count: 12, known: false }, s2: { since: list[2].sha, count: 2, known: true } },
      commitsTotal: 12,
    })
    const { user, dialog } = await mount({ preselect: ['s1', 's2'], persisted: events([{ type: 'preflight.done', report: done }]) })
    await preflight(user, dialog)
    const commits = await within(dialog).findByRole('region', { name: 'Commits' })
    const api = within(commits).getByRole('list', { name: 'api' })
    expect(within(api).getAllByRole('listitem')).toHaveLength(10)
    expect(within(api).getByText('01ccccc')).toBeInTheDocument()
    expect(within(commits).getByText('+5 more')).toBeInTheDocument()
    const worker = within(commits).getByRole('list', { name: 'worker' })
    expect(within(worker).getAllByRole('listitem').map((li) => within(li).getByText(/^change/).textContent)).toEqual(['change 1', 'change 2'])
    expect(within(commits).getAllByText(/more$/)).toHaveLength(1)
  })

  it('zero commits offers Redeploy anyway and sends redeploy: true', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report({ commitsTotal: 0 }) }]) })
    await preflight(user, dialog)
    await within(dialog).findByText('Nothing new to deploy')
    expect(within(dialog).getByRole('button', { name: 'Start' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Redeploy anyway' }))
    expect(within(dialog).getByText('Deploying to staging · 1 host · 1 service')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(calls(invoke, 'release:start')[0].slice(1)).toEqual([REL, { redeploy: true }]))
  })

  it('protected start requires typing the environment name', async () => {
    const prod = environment({ ...staging, protected: true })
    const { user, dialog, invoke } = await mount({ env: prod, preselect: ['s1', 's3'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await user.click(await within(dialog).findByRole('button', { name: 'Start' }))
    expect(within(dialog).getByText('Deploying to staging · 2 hosts · 2 services')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Start' }))
    const confirm = await screen.findByRole('dialog', { name: 'Deploy to staging?' })
    const ok = within(confirm).getByRole('button', { name: 'Start' })
    expect(ok).toBeDisabled()
    await user.type(within(confirm).getByLabelText('Type staging to confirm'), 'stagin')
    expect(ok).toBeDisabled()
    expect(calls(invoke, 'release:start')).toHaveLength(0)
    await user.type(within(confirm).getByLabelText('Type staging to confirm'), 'g')
    await user.click(ok)
    await waitFor(() => expect(calls(invoke, 'release:start')[0].slice(1)).toEqual([REL, { typedName: 'staging', redeploy: false }]))
  })

  it('closing before start discards', async () => {
    const { user, dialog, invoke, closed } = await mount({ preselect: ['s1'] })
    await preflight(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual([REL])
    await preflight(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual([REL, REL])
    expect(closed()).toBe(1)
  })
})
