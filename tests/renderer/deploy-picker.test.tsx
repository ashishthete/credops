import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutNotice, pickerGroups, selectionRequest } from '../../src/renderer/src/deploy/picker'
import { releaseStore, resetReleases } from '../../src/renderer/src/deploy/releases'
import {
  registerNotesFlush,
  registerReleaseNotesEditor,
  registerReleaseOptions,
  RELEASE_OPTIONS_UNAVAILABLE,
  type ReleaseNotesSlotProps,
} from '../../src/renderer/src/deploy/slots'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeployWizard } from '../../src/renderer/src/pages/deployments/release/DeployWizard'
import { PreflightChecklist } from '../../src/renderer/src/pages/deployments/release/PreflightChecklist'
import { encodeIpcError } from '../../src/shared/ipc-error'
import { NOTHING_SELECTED_MESSAGE, ORIGIN_MOVED_MESSAGE, type CommitInfo, type PlaybookPreview, type PreflightCheck, type PreflightReport, type RunEvent } from '../../src/shared/deploy'
import type { ServiceMeta } from '../../src/shared/services'
import { events, REL, releaseDetail } from './fixtures/release-events'
import { appService, dbService, deploymentMeta, emitBridgeEvent, envSettings, environment, host, mockBridge, REGION } from './helpers'

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
const HASH = 'c'.repeat(64)
const task = (kind: string) => ({ name: `${kind} core`, 'ansible.builtin.command': 'true', tags: [`od_step=${kind}`, 'od_run=r1'] })
const PLAYBOOK = JSON.stringify(
  [
    {
      hosts: 'od-1',
      tasks: [
        { name: 'lock', tags: ['od_step=lock'] },
        {
          name: 'deployment core',
          vars: { d: { run: 'r1', name: 'core' } },
          block: ['fetch', 'build', 'up', 'health', 'tag'].map(task),
          rescue: [{ 'ansible.builtin.set_fact': { od_failed: true } }],
        },
      ],
    },
  ],
  null,
  2,
)
const PREVIEW = { playbook: PLAYBOOK, sha256: HASH }

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

/** `persisted` is what `release:events` replays; a test can also push live batches. */
async function mount({ preselect = [] as string[], env = staging, persisted = [] as RunEvent[], detail = releaseDetail({ status: 'preflight', runs: [] }), preview = PREVIEW as PlaybookPreview, settings = envSettings(), hosts = HOSTS, regions = [REGION], extra = {} as Record<string, unknown> } = {}) {
  const invoke = mockBridge({
    ...extra,
    'env:list': [env],
    'host:list': hosts,
    'region:list': regions,
    'deploy:list': CHECKOUTS,
    'service:list': SERVICES,
    'deploy:settings': settings,
    'release:preflight': { releaseId: REL },
    'deploy:previewPlaybook': preview,
    'release:get': detail,
    'release:active': [],
    // Main answers these with nothing, as the real bridge does.
    'release:start': undefined,
    'release:break-lock': undefined,
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
      "Compose services CredOps doesn't track (redis) are not restarted.",
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
    await waitFor(() => expect(within(notice).getByText("Compose services CredOps doesn't track (redis) are not restarted.")).toBeInTheDocument())
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
    await within(dialog).findByText('postgres (database, skipped)')
    expect(within(dialog).queryByRole('checkbox', { name: /postgres/ })).not.toBeInTheDocument()
    const notice = within(dialog).getByRole('list', { name: 'What happens to site' })
    await waitFor(() => expect(within(notice).getByText("Compose services CredOps doesn't track (redis) are not restarted.")).toBeInTheDocument())
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
    await waitFor(() => expect(within(notice).getByText("Compose services CredOps doesn't track (postgres) are not restarted.")).toBeInTheDocument())
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
    expect(box(dialog, 'Notify').closest('label')).toHaveAttribute('title', RELEASE_OPTIONS_UNAVAILABLE)
    expect(box(dialog, 'QA')).toBeDisabled()
    await preflight(user, dialog)
    expect(calls(invoke, 'release:preflight')[0][1]).toEqual({
      environmentId: 'e1',
      serviceIds: ['s1'],
      checkoutIds: ['d2'],
      bump: 'patch',
      options: { backup: true, notify: false, qa: false },
    })
  })

  it('deps warning shows and does not block the review', async () => {
    const { user, dialog } = await mount({ preselect: ['s1'] })
    await preflight(user, dialog)
    const start = within(dialog).getByRole('button', { name: 'Review playbook' })
    expect(start).toBeDisabled()
    const deps = check({ id: 'deps', deploymentId: 'd1', label: 'Dependencies on app1', level: 'warn', message: 'redis is not running' })
    act(() => emitBridgeEvent('deploy:event', events([{ type: 'preflight.check', check: check({ id: 'repo', deploymentId: 'd1', label: 'Repo on app1' }) }, { type: 'preflight.check', check: deps }])))
    const list = within(dialog).getByRole('list', { name: 'Preflight checks' })
    expect(within(list).getByText('redis is not running')).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    act(() => emitBridgeEvent('deploy:event', events([{ type: 'preflight.done', report: report({ checks: [deps] }) }], 3)))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
  })

  it('a blocking check disables Start and shows its fix', async () => {
    const dirty = check({ id: 'clean', deploymentId: 'd1', label: 'Clean on app1', level: 'block', message: 'Uncommitted changes on app1:/srv/core' })
    const { user, dialog } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.check', check: dirty }, { type: 'preflight.done', report: report({ checks: [dirty], blocked: true }) }]) })
    await preflight(user, dialog)
    await within(dialog).findByText('Uncommitted changes on app1:/srv/core')
    expect(within(dialog).getByText('git -C /srv/core status')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeDisabled()
  })

  it('Show ansible output opens the preflight\'s console, read-only, with what ansible printed', async () => {
    const term = (line: string) => ({ type: 'log' as const, stepId: null, hostId: null, stream: 'term' as const, line })
    const { user, dialog } = await mount({
      preselect: ['s1'],
      persisted: events([term('TASK [tools check]'), term('fatal: [app1]: FAILED! rc=127'), { type: 'preflight.done', report: report() }]),
    })
    await preflight(user, dialog)
    expect(within(dialog).queryByTestId('ansible-terminal')).toBeNull()
    const toggle = await within(dialog).findByRole('button', { name: 'Show ansible output' })
    await user.click(toggle)
    expect(within(dialog).getByTestId('ansible-terminal')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Hide ansible output' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).queryByText('Waiting for ansible output')).toBeNull()
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
    expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Redeploy anyway' }))
    expect(within(dialog).getByText('Deploying to staging · 1 host · 1 service')).toBeInTheDocument()
    await user.click(await within(dialog).findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(calls(invoke, 'release:start')[0].slice(1)).toEqual([REL, { redeploy: true, playbookSha256: HASH }]))
  })

  it('breaking a stale lock runs preflight again', async () => {
    const holder = { releaseId: 'r-old', user: 'ash', machine: 'mac', environment: 'staging', version: null, startedAt: '2026-01-01T00:00:00.000Z' }
    const lock = check({ id: 'lock', level: 'block', message: 'locked' })
    const locked = report({ blocked: true, checks: [lock], locks: { h1: { holder, stale: true, raw: '{}' } } })
    const { user, dialog, invoke } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.check', check: lock }, { type: 'preflight.done', report: locked }]) })
    await preflight(user, dialog)
    await user.click(await within(dialog).findByRole('button', { name: 'Break lock' }))
    const confirm = await screen.findByRole('dialog', { name: 'Break the lock on app1?' })
    await user.type(within(confirm).getByLabelText('Type app1 to confirm'), 'app1')
    await user.click(within(confirm).getByRole('button', { name: 'Break lock' }))
    await waitFor(() => expect(calls(invoke, 'release:break-lock').map((c) => c.slice(1))).toEqual([[REL, 'h1', { typedLabel: 'app1' }]]))
    await waitFor(() => expect(calls(invoke, 'release:preflight')).toHaveLength(2))
  })

  it('protected start requires typing the environment name', async () => {
    const prod = environment({ ...staging, protected: true })
    const { user, dialog, invoke } = await mount({ env: prod, preselect: ['s1', 's3'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await user.click(await within(dialog).findByRole('button', { name: 'Review playbook' }))
    expect(within(dialog).getByText('Deploying to staging · 2 hosts · 2 services')).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    const confirm = await screen.findByRole('dialog', { name: 'Deploy to staging?' })
    const ok = within(confirm).getByRole('button', { name: 'Deploy' })
    expect(ok).toBeDisabled()
    await user.type(within(confirm).getByLabelText('Type staging to confirm'), 'stagin')
    expect(ok).toBeDisabled()
    expect(calls(invoke, 'release:start')).toHaveLength(0)
    await user.type(within(confirm).getByLabelText('Type staging to confirm'), 'g')
    await user.click(ok)
    await waitFor(() => expect(calls(invoke, 'release:start')[0].slice(1)).toEqual([REL, { typedName: 'staging', redeploy: false, playbookSha256: HASH }]))
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

  it('a refused discard stays out of the UI and logs no release detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { user, dialog, invoke } = await mount({ preselect: ['s1'] })
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'release:discard') throw new Error(`This release is busy: ${args[0] as string}`)
        return base(channel)
      })
      await preflight(user, dialog)
      await user.click(within(dialog).getByRole('button', { name: 'Back' }))
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
      expect(warn.mock.calls[0]).toEqual(["Couldn't discard an unused preflight release"])
      expect(within(dialog).queryByText(/busy/)).not.toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Run preflight' })).toBeInTheDocument()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('stale preflight releases', () => {
  /** Holds each `channel` call until the test settles it, in call order. */
  function hold(invoke: ReturnType<typeof mockBridge>, channel: string) {
    const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation((ch: string, ...args: unknown[]) => {
      if (ch !== channel) return base(ch, ...args)
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    })
    return {
      count: () => pending.length,
      settle: async (i: number, value: unknown) => {
        await act(async () => pending[i].resolve(value))
      },
      fail: async (i: number, err: Error) => {
        await act(async () => pending[i].reject(err))
      },
    }
  }
  const run = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => user.click(within(dialog).getByRole('button', { name: 'Run preflight' }))

  for (const how of ['Cancel', 'Back', 'Escape'] as const) {
    it(`a preflight that answers after ${how} is discarded and never opened`, async () => {
      const { user, dialog, invoke, closed } = await mount({ preselect: ['s1'] })
      const pre = hold(invoke, 'release:preflight')
      await run(user, dialog)
      expect(pre.count()).toBe(1)
      if (how === 'Escape') await user.keyboard('{Escape}')
      else await user.click(within(dialog).getByRole('button', { name: how }))
      expect(calls(invoke, 'release:discard')).toEqual([])
      await pre.settle(0, { releaseId: 'rel-late' })
      expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual(['rel-late'])
      expect(calls(invoke, 'release:get')).toEqual([])
      expect(closed()).toBe(how === 'Back' ? 0 : 1)
    })
  }

  it('a preflight that answers after the wizard unmounts is discarded', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'] })
    const pre = hold(invoke, 'release:preflight')
    await run(user, dialog)
    cleanup()
    await pre.settle(0, { releaseId: 'rel-late' })
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual(['rel-late'])
    expect(calls(invoke, 'release:get')).toEqual([])
  })

  it('double-clicking Bump further runs one preflight, and the release it replaces is discarded', async () => {
    const taken = check({ id: 'version-tag', label: 'Version tag', level: 'block', message: 'v1.3.0 already exists' })
    const { user, dialog, invoke } = await mount({
      preselect: ['s1'],
      persisted: events([{ type: 'preflight.check', check: taken }, { type: 'preflight.done', report: report({ checks: [taken], blocked: true }) }]),
    })
    await preflight(user, dialog)
    const bump = await within(dialog).findByRole('button', { name: 'Bump further' })
    const pre = hold(invoke, 'release:preflight')
    await user.dblClick(bump)
    expect(pre.count()).toBe(1)
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual([REL])
    expect(calls(invoke, 'release:preflight').at(-1)![1]).toMatchObject({ bump: 'major' })
    await pre.settle(0, { releaseId: 'rel-2' })
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual([REL])
    expect(calls(invoke, 'release:get').at(-1)).toEqual(['release:get', 'rel-2'])
  })

  it('Bump further and Break lock wait while a preflight run is in flight', () => {
    const taken = check({ id: 'version-tag', label: 'Version tag', level: 'block', message: 'v1.3.0 already exists' })
    const locked = check({ id: 'lock', label: 'Lock on app1', level: 'block', message: 'Held by ana@mbp' })
    const done = report({ checks: [taken, locked], blocked: true, locks: { h1: { stale: true } } as never })
    const fixes = { repoPath: () => null, onBreakLock: () => {}, onBumpFurther: () => {} }
    const { rerender } = render(<PreflightChecklist checks={[taken, locked]} report={done} fixes={{ ...fixes, busy: true }} />)
    expect(screen.getByRole('button', { name: 'Bump further' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Break lock' })).toBeDisabled()
    rerender(<PreflightChecklist checks={[taken, locked]} report={done} fixes={fixes} />)
    expect(screen.getByRole('button', { name: 'Bump further' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Break lock' })).toBeEnabled()
  })

  it('a failed preflight stops saying Checking', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'] })
    const pre = hold(invoke, 'release:preflight')
    await run(user, dialog)
    expect(within(dialog).getByText('Starting preflight')).toBeInTheDocument()
    await pre.fail(0, new Error('main is busy'))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('main is busy')
    expect(within(dialog).queryByText('Checking')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Starting preflight')).not.toBeInTheDocument()
  })

  it('a release that cannot be read says so', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'] })
    const get = hold(invoke, 'release:get')
    await run(user, dialog)
    await waitFor(() => expect(get.count()).toBe(1))
    await get.fail(0, new Error('release not found'))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('release not found')
  })

  it('the review names the services going out and the one region they run in, unemphasised', async () => {
    const { user, dialog } = await mount({ preselect: ['s1', 's2'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    const line = within(dialog).getByLabelText('Deploys api, worker · test-1')
    expect(within(line).getByText('test-1')).toHaveAttribute('title', 'Test')
    expect(within(line).getByText('test-1').className).not.toContain('warn')
    expect(within(line).queryByRole('img', { name: /regions/ })).toBeNull()
  })

  it('the review emphasises the regions when the checkouts span more than one', async () => {
    const us = { ...REGION, id: 'region-2', code: 'us-east-1', displayName: 'US East' }
    const hosts = [HOSTS[0], { ...HOSTS[1], regionId: us.id }]
    const { user, dialog } = await mount({ preselect: ['s1', 's3'], hosts, regions: [REGION, us], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    const line = within(dialog).getByLabelText('Deploys api, site · test-1, us-east-1')
    expect(within(line).getByRole('img', { name: 'Reaches 2 regions' })).toBeInTheDocument()
    expect(within(line).getByText('us-east-1').className).toContain('warn')
    // The protected confirmation is unchanged; staging isn't protected, so Deploy starts straight away.
    expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeInTheDocument()
  })

  it('Deploy is offered only on the review, once the playbook is shown, and starts bound to its hash', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    expect(within(dialog).queryByRole('button', { name: 'Deploy' })).toBeNull()
    const previewCall = hold(invoke, 'deploy:previewPlaybook')
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeDisabled()
    expect(within(dialog).getByText('Generating the playbook')).toBeInTheDocument()
    await previewCall.settle(0, PREVIEW)
    const steps = within(dialog).getByRole('list', { name: 'Playbook steps' })
    expect(within(steps).getByText('core')).toBeInTheDocument()
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining(['Lock', 'Fetch', 'Build', 'Up', 'Health', 'Tag', 'Stop if a step fails']))
    expect(within(dialog).getByText(/"deployment core"/)).toBeInTheDocument()
    expect(calls(invoke, 'release:start')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Save as .yml…' }))
    await waitFor(() => expect(calls(invoke, 'deploy:savePlaybook').map((c) => c.slice(1))).toEqual([[REL, HASH]]))
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(calls(invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { redeploy: false, playbookSha256: HASH }]]))
    // Started: the review gives way to the release, with no second Deploy on offer.
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument())
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it.each([
    ['changed since the review', 'PLAYBOOK_CHANGED', 'The playbook changed since you reviewed it. Review it again.'],
    ['reviewed too long ago', 'REVIEW_EXPIRED', 'Your review is more than 30 minutes old. Review the playbook again.'],
    // A Hub-run environment's refusal is the Hub's 409, which keeps the message but not main's code.
    ['changed since the review, refused by the Hub', 'conflict', 'The playbook changed since you reviewed it. Review it again.'],
    ['reviewed too long ago, refused by the Hub', 'conflict', 'Your review is more than 30 minutes old. Review the playbook again.'],
  ])('a playbook %s is shown again, and the next Deploy carries the new hash', async (_case, code, refusal) => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    const startCall = hold(invoke, 'release:start')
    const NEW = 'd'.repeat(64)
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation((ch: string, ...args: unknown[]) => (ch === 'deploy:previewPlaybook' ? Promise.resolve({ playbook: PLAYBOOK, sha256: NEW }) : base(ch, ...args)))
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    await startCall.fail(0, new Error(encodeIpcError(code, refusal)))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(refusal)
    await waitFor(() => expect(calls(invoke, 'deploy:previewPlaybook')).toHaveLength(2))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    expect(calls(invoke, 'release:start').map((c) => (c[2] as { playbookSha256: string }).playbookSha256)).toEqual([HASH, NEW])
  })

  it('Cancel, Back and Escape wait while release:start is in flight', async () => {
    const done = report()
    const { user, dialog, invoke, closed } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: done }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    const startCall = hold(invoke, 'release:start')
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    expect(startCall.count()).toBe(1)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(closed()).toBe(0)
    expect(calls(invoke, 'release:discard')).toEqual([])
    await startCall.settle(0, null)
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(calls(invoke, 'release:discard')).toEqual([])
  })

  it('a failed playbook preview says why and offers Retry, which generates it', async () => {
    const { user, dialog, invoke } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    const previewCall = hold(invoke, 'deploy:previewPlaybook')
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await previewCall.fail(0, new Error('ansible-playbook not found'))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('ansible-playbook not found')
    expect(within(dialog).queryByText('Generating the playbook')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByText('Generating the playbook')).toBeInTheDocument()
    await previewCall.settle(1, PREVIEW)
    expect(within(dialog).getByRole('list', { name: 'Playbook steps' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled()
  })

  it('the step indicator follows the wizard from Select to Running', async () => {
    const { user, dialog } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    const steps = within(dialog).getByRole('list', { name: 'Deploy steps' })
    const current = () => within(steps).getByRole('listitem', { current: 'step' })
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Select', '2Preflight', '3Review', '4Running'])
    expect(current()).toHaveTextContent('Select')
    await preflight(user, dialog)
    expect(current()).toHaveTextContent('Preflight')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    expect(current()).toHaveTextContent('Review')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(current()).toHaveTextContent('Running'))
  })

  it('Escape once preflight has run asks before discarding it; Keep editing stays on the preflight', async () => {
    const { user, dialog, invoke, closed } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: report() }]) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.keyboard('{Escape}')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Discard changes?')
    expect(closed()).toBe(0)
    expect(calls(invoke, 'release:discard')).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    await user.keyboard('{Escape}')
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(closed()).toBe(1)
    expect(calls(invoke, 'release:discard').map((c) => c[1])).toEqual([REL])
  })
})

describe('skipped services', () => {
  const skip = { since: '01' + 'c'.repeat(38), count: 0, known: true, skippable: true }
  const moved = { since: '02' + 'c'.repeat(38), count: 2, known: true }
  const skipping = report({ serviceCommits: { s1: skip, s2: moved }, commits: { d1: { commits: [commit(1), commit(2)], hiddenPairs: 0, truncated: 0, firstDeploy: false, head: commit(1).sha, tagCommit: null } }, commitsTotal: 2 })

  async function reviewable(over: Parameters<typeof mount>[0] = {}, done = skipping) {
    const m = await mount({ preselect: ['s1', 's2'], persisted: events([{ type: 'preflight.done', report: done }]), ...over })
    await preflight(m.user, m.dialog)
    await within(m.dialog).findByText('skipped: no changes')
    return m
  }

  it('a service with no changes shows as skipped; the preview and start leave it out until Deploy anyway', async () => {
    const { user, dialog, invoke } = await reviewable({ preview: { ...PREVIEW, skippedServiceIds: ['s1'] } })
    const row = within(dialog).getByRole('listitem', { name: 'api' })
    expect(row).toHaveTextContent('skipped: no changes')
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    expect(await within(dialog).findByText('Skipped, no changes: api')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(calls(invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { redeploy: false, playbookSha256: HASH }]]))
    expect(calls(invoke, 'deploy:previewPlaybook').map((c) => c.slice(1))).toEqual([[REL]])
  })

  it('Deploy anyway sends the service as forced to the preview and the start', async () => {
    const { user, dialog, invoke } = await reviewable()
    await user.click(within(within(dialog).getByRole('listitem', { name: 'api' })).getByRole('button', { name: 'Deploy anyway' }))
    expect(within(dialog).queryByText('skipped: no changes')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(calls(invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { redeploy: false, playbookSha256: HASH, forceServiceIds: ['s1'] }]]))
    expect(calls(invoke, 'deploy:previewPlaybook').map((c) => c.slice(1))).toEqual([[REL, ['s1']]])
  })

  describe('an edited playbook', () => {
    const EDIT_SHA = 'e'.repeat(64)
    const validating = (invoke: ReturnType<typeof mockBridge>, answer: (text: string) => unknown) => {
      const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
      invoke.mockImplementation(async (ch: string, ...args: unknown[]) => (ch === 'release:validateEdit' ? answer(args[1] as string) : base(ch, ...args)))
    }
    const toEditor = async (m: Awaited<ReturnType<typeof reviewable>>) => {
      await m.user.click(within(within(m.dialog).getByRole('listitem', { name: 'api' })).getByRole('button', { name: 'Deploy anyway' }))
      await m.user.click(within(m.dialog).getByRole('button', { name: 'Review playbook' }))
      await m.user.click(await within(m.dialog).findByRole('button', { name: 'Edit' }))
      const box = within(m.dialog).getByRole('textbox', { name: 'Edit playbook' })
      await m.user.type(box, ' ')
      return box as HTMLTextAreaElement
    }

    it('validates with the forced services and starts with the edited text, its sha and the same forced services', async () => {
      const m = await reviewable()
      validating(m.invoke, () => ({ ok: true, canonical: 'x', sha256: EDIT_SHA }))
      const box = await toEditor(m)
      await waitFor(() => expect(within(m.dialog).getByRole('button', { name: 'Run edited' })).toBeEnabled())
      expect(within(m.dialog).getByRole('button', { name: 'Deploy' })).toBeDisabled()
      await m.user.click(within(m.dialog).getByRole('button', { name: 'Run edited' }))
      expect(calls(m.invoke, 'release:validateEdit').map((c) => c.slice(1))).toEqual([[REL, box.value, ['s1']]])
      await waitFor(() => expect(calls(m.invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { redeploy: false, playbookSha256: EDIT_SHA, editedPlaybook: box.value, forceServiceIds: ['s1'] }]]))
    })

    it('a double click on Run edited sends one start', async () => {
      const m = await reviewable()
      validating(m.invoke, () => ({ ok: true, canonical: 'x', sha256: EDIT_SHA }))
      await toEditor(m)
      await waitFor(() => expect(within(m.dialog).getByRole('button', { name: 'Run edited' })).toBeEnabled())
      const base = m.invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
      m.invoke.mockImplementation((ch: string, ...args: unknown[]) => (ch === 'release:start' ? new Promise(() => {}) : base(ch, ...args)))
      await m.user.dblClick(within(m.dialog).getByRole('button', { name: 'Run edited' }))
      expect(calls(m.invoke, 'release:start')).toHaveLength(1)
    })

    it('a protected environment still needs the typed name for an edited start', async () => {
      const prod = environment({ id: 'e1', name: 'staging', protected: true, hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] })
      const m = await reviewable({ env: prod })
      validating(m.invoke, () => ({ ok: true, canonical: 'x', sha256: EDIT_SHA }))
      const box = await toEditor(m)
      await waitFor(() => expect(within(m.dialog).getByRole('button', { name: 'Run edited' })).toBeEnabled())
      await m.user.click(within(m.dialog).getByRole('button', { name: 'Run edited' }))
      expect(calls(m.invoke, 'release:start')).toEqual([])
      const confirm = await screen.findByRole('dialog', { name: 'Deploy to staging?' })
      await m.user.type(within(confirm).getByLabelText('Type staging to confirm'), 'staging')
      await m.user.click(within(confirm).getByRole('button', { name: 'Deploy' }))
      await waitFor(() => expect(calls(m.invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { typedName: 'staging', redeploy: false, playbookSha256: EDIT_SHA, editedPlaybook: box.value, forceServiceIds: ['s1'] }]]))
    })

    it('a rejected validation shows its message, offers a new preview, and starts nothing', async () => {
      const m = await reviewable()
      validating(m.invoke, () => Promise.reject(new Error('Your preview is gone, preview again')))
      await toEditor(m)
      expect(await within(m.dialog).findByText(/Your preview is gone/)).toBeInTheDocument()
      expect(within(m.dialog).getByRole('button', { name: 'Run edited' })).toBeDisabled()
      await m.user.click(within(m.dialog).getByRole('button', { name: 'Preview again' }))
      expect(calls(m.invoke, 'deploy:previewPlaybook')).toHaveLength(2)
      expect(calls(m.invoke, 'release:start')).toEqual([])
    })
  })

  it('when every selected service is skipped, Review waits until one is deployed anyway', async () => {
    const all = report({ serviceCommits: { s1: skip }, commitsTotal: 1 })
    const m = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: all }]) })
    await preflight(m.user, m.dialog)
    expect(await within(m.dialog).findByText(NOTHING_SELECTED_MESSAGE)).toBeInTheDocument()
    expect(within(m.dialog).getByRole('button', { name: 'Review playbook' })).toBeDisabled()
    await m.user.click(within(m.dialog).getByRole('button', { name: 'Deploy anyway' }))
    expect(within(m.dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled()
  })

  it('a flow preview shows its inventory next to the playbook', async () => {
    const inventory = JSON.stringify({ all: { hosts: { 'od-1': { od: { version: 'v1.4.0' } } } } })
    const { user, dialog } = await reviewable({ preview: { ...PREVIEW, inventory } })
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    const inv = await within(dialog).findByLabelText('Inventory (hashed with the playbook)')
    expect(inv).toHaveTextContent('v1.4.0')
  })

  it('a service a flow step stage is bound to is never shown skipped, even by a preflight from before the flow', async () => {
    const step = { id: 'migrate', name: 'migrate', run: 'shell' as const, service: null, script: 'make migrate', cwd: null, sudo: 'docker' as const, timeoutSec: 600, onFailure: 'stop' as const, when: { kind: 'always' as const }, secrets: [] }
    const flow = { onFailure: 'stop-all' as const, stages: [{ kind: 'step' as const, serviceId: 's1', step }] }
    const stale = report({ serviceCommits: { s1: skip }, commitsTotal: 1 })
    const { user, dialog } = await mount({ preselect: ['s1'], persisted: events([{ type: 'preflight.done', report: stale }]), settings: envSettings({ flow }) })
    await preflight(user, dialog)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    expect(within(dialog).queryByText('skipped: no changes')).toBeNull()
    expect(within(dialog).queryByText(NOTHING_SELECTED_MESSAGE)).toBeNull()
  })

  it('a release refused because origin moved says so; Preview again starts over on a new release, nothing forced or reviewed carried', async () => {
    const REL2 = 'rel-2'
    const NEW = 'd'.repeat(64)
    const { user, dialog, invoke } = await reviewable({ detail: releaseDetail({ status: 'preflight' }) })
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    let preflights = 0
    invoke.mockImplementation((ch: string, ...args: unknown[]) => {
      if (ch === 'release:preflight') return Promise.resolve({ releaseId: ++preflights === 1 ? REL2 : 'rel-3' })
      if (ch === 'deploy:previewPlaybook' && args[0] === REL2) return Promise.resolve({ playbook: PLAYBOOK, sha256: NEW })
      if (ch === 'release:get' && args[0] === REL2) return Promise.resolve(releaseDetail({ id: REL2, status: 'preflight' }))
      return base(ch, ...args)
    })
    await user.click(within(within(dialog).getByRole('listitem', { name: 'api' })).getByRole('button', { name: 'Deploy anyway' }))
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Deploy' }))
    await within(dialog).findByRole('button', { name: 'Close' })
    expect(calls(invoke, 'release:start').map((c) => c.slice(1))).toEqual([[REL, { redeploy: false, playbookSha256: HASH, forceServiceIds: ['s1'] }]])
    act(() =>
      emitBridgeEvent(
        'deploy:event',
        events(
          [
            { type: 'step.started', stepId: 'r1:fetch', kind: 'fetch', name: 'fetch', hostId: 'h1', deploymentRunId: 'r1' },
            { type: 'step.failed', stepId: 'r1:fetch', error: `fetch failed: ${ORIGIN_MOVED_MESSAGE}`, durationMs: 5 },
          ],
          2,
        ),
      ),
    )
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(ORIGIN_MOVED_MESSAGE)
    await user.click(within(alert).getByRole('button', { name: 'Preview again' }))
    // the failed release is no longer watched
    expect(releaseStore.get().pipelines[REL]).toBeUndefined()
    await waitFor(() => expect(calls(invoke, 'release:preflight')).toHaveLength(2))
    // nothing forced carries over: api is skipped again until deployed anyway
    expect(await within(dialog).findByText('skipped: no changes')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Deploy' })).toBeNull()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Deploy' }))
    expect(calls(invoke, 'deploy:previewPlaybook').map((c) => c.slice(1))).toEqual([[REL, ['s1']], [REL2]])
    // the new review's hash, bound to the new release
    await waitFor(() => expect(calls(invoke, 'release:start').map((c) => c.slice(1))[1]).toEqual([REL2, { redeploy: false, playbookSha256: NEW }]))
  })
})

describe('deploy slots in the wizard', () => {
  it('the notes editor and notify/QA options registered through deploy/slots show, and Deploy waits for the notes', async () => {
    const seen: ReleaseNotesSlotProps[] = []
    const flushes: string[] = []
    let finish = () => {}
    function Editor(p: ReleaseNotesSlotProps) {
      seen.push(p)
      const id = p.release?.id
      useEffect(
        () =>
          id
            ? registerNotesFlush(id, () => {
                flushes.push(id)
                return new Promise<void>((r) => (finish = r))
              })
            : undefined,
        [id],
      )
      return <p>{id ? `notes for ${id}` : 'notes after preflight'}</p>
    }
    const offEditor = registerReleaseNotesEditor(Editor)
    const offOptions = registerReleaseOptions({ notify: true, qa: true })
    try {
      const { user, dialog, invoke } = await mount({
        preselect: ['s1'],
        persisted: events([{ type: 'preflight.done', report: report() }]),
        extra: { 'integration:get': { environmentId: 'e1', qaOnDeploy: true, qa: { repo: 'o/r', workflow: 'qa.yml', ref: 'main' } } },
      })
      expect(within(dialog).getByText('notes after preflight')).toBeInTheDocument()
      expect(seen.at(-1)).toMatchObject({ environmentId: 'e1', release: null })
      expect(box(dialog, 'Notify')).toBeEnabled()
      expect(box(dialog, 'Notify')).toBeChecked()
      expect(box(dialog, 'Notify').closest('label')!.getAttribute('title')).toMatch(/Notifications and QA settings/)
      // QA follows the environment's qaOnDeploy.
      await waitFor(() => expect(box(dialog, 'QA')).toBeChecked())
      await user.click(box(dialog, 'Notify'))
      await preflight(user, dialog)
      expect(calls(invoke, 'release:preflight')[0][1]).toMatchObject({ options: { backup: true, notify: false, qa: true } })
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review playbook' })).toBeEnabled())
      await user.click(within(dialog).getByRole('button', { name: 'Review playbook' }))
      expect(await within(dialog).findByText(`notes for ${REL}`)).toBeInTheDocument()
      expect(seen.at(-1)).toMatchObject({ environmentId: 'e1', release: { id: REL } })
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
      await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
      await waitFor(() => expect(flushes).toEqual([REL]))
      expect(calls(invoke, 'release:start')).toHaveLength(0)
      await act(async () => finish())
      await waitFor(() => expect(calls(invoke, 'release:start')).toHaveLength(1))
    } finally {
      offEditor()
      offOptions()
    }
  })
})
