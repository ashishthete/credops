import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { HISTORY_PAGE, resetReleases } from '../../src/renderer/src/deploy/releases'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { ReleaseHistory } from '../../src/renderer/src/pages/deployments/release/ReleaseHistory'
import { ReleaseView } from '../../src/renderer/src/pages/deployments/release/ReleaseView'
import type { ReleaseDetail, ReleaseSummary } from '../../src/shared/deploy'
import { events, OK_RUN, REL, releaseDetail } from './fixtures/release-events'
import { appService, deploymentMeta, environment, host, mockBridge } from './helpers'

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

const HOSTS = [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2' })]
const CHECKOUTS = [deploymentMeta({ id: 'dep-r1', name: 'core', hostId: 'h1' }), deploymentMeta({ id: 'dep-r3', name: 'site', hostId: 'h2' })]
const SERVICES = [
  appService({ id: 's1', name: 'api', deploymentId: 'dep-r1', position: 0 }),
  appService({ id: 's2', name: 'worker', deploymentId: 'dep-r1', position: 1 }),
  appService({ id: 's3', name: 'site', deploymentId: 'dep-r3', position: 2 }),
]

const sha = (c: string) => c.repeat(40)

function summary(over: Partial<ReleaseSummary> & { id: string }): ReleaseSummary {
  const { options: _o, releaseNotes: _n, playbook: _p, runs: _r, preflight: _f, lastSeq: _l, ...rest } = releaseDetail()
  return { ...rest, status: 'succeeded', startedAt: '2026-10-19T10:00:00.000Z', finishedAt: '2026-10-19T10:02:05.000Z', ...over }
}

/** rel-3 deployed worker after rel-2 deployed api; rel-1 deployed both before that. */
const R3 = summary({ id: 'rel-3', version: 'v1.6.0', serviceIds: ['s2'], serviceCount: 1, createdAt: '2026-10-19T12:00:00.000Z' })
const R2 = summary({ id: 'rel-2', version: 'v1.5.0', serviceIds: ['s1'], serviceCount: 1, triggeredBy: 'ben@mbp', createdAt: '2026-10-19T11:00:00.000Z' })
const R1 = summary({ id: 'rel-1', version: 'v1.4.0', serviceIds: ['s1', 's2'], serviceCount: 2, createdAt: '2026-10-19T10:00:00.000Z' })

/** R2's run: api on app1 moved from aaaaaaa to bbbbbbb. */
const R2_DETAIL: ReleaseDetail = releaseDetail({
  id: 'rel-2',
  version: 'v1.5.0',
  status: 'succeeded',
  serviceIds: ['s1'],
  runs: [
    {
      ...releaseDetail().runs[0],
      releaseId: 'rel-2',
      previousCommit: sha('a'),
      deployedCommit: sha('b'),
      services: [{ id: 's1', name: 'api', composeService: 'api', previousCommit: sha('a'), previousReleaseId: 'rel-1', deployedCommit: sha('b') }],
    },
  ],
})

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname}</p>
}

async function mount({ protectedEnv = false, pages = [[R3, R2, R1]] as ReleaseSummary[][], detail = R2_DETAIL } = {}) {
  const invoke = mockBridge({
    'env:list': [environment({ id: 'e1', name: 'staging', protected: protectedEnv, hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] })],
    'host:list': HOSTS,
    'deploy:list': CHECKOUTS,
    'service:list': SERVICES,
    'release:rollback': { releaseId: 'rel-rb' },
  })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:list') {
      const { before } = args[0] as { before?: string }
      return before ? (pages[1] ?? []) : pages[0]
    }
    if (channel === 'release:get') return detail
    return base(channel)
  })
  await act(async () => {
    await loadInventory()
    await loadDeploy(['e1'])
  })
  render(
    <MemoryRouter initialEntries={['/deployments']}>
      <Routes>
        <Route path="/deployments" element={<ReleaseHistory environmentId="e1" />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
  await flush()
  return { invoke, user: userEvent.setup() }
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-release="${id}"]`)!

afterEach(() => {
  cleanup()
  resetReleases()
  resetDeploy()
  inventoryStore.set(null)
})

describe('release history', () => {
  it('history lists releases with service counts and pages', async () => {
    const first = Array.from({ length: HISTORY_PAGE }, (_, i) =>
      summary({ id: `p1-${i}`, version: `v2.${HISTORY_PAGE - i}.0`, serviceIds: ['s3'], serviceCount: i === 0 ? 1 : 3, createdAt: `2026-10-19T11:${String(59 - i).padStart(2, '0')}:00.000Z` }),
    )
    const { invoke, user } = await mount({ pages: [first, [R1]] })
    const list = screen.getByRole('list', { name: 'Release history' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(HISTORY_PAGE)
    expect(within(row('p1-0')).getByText('1 service')).toBeInTheDocument()
    expect(within(row('p1-1')).getByText('3 services')).toBeInTheDocument()
    expect(within(row('p1-0')).getByText('triggered by ana@mbp')).toBeInTheDocument()
    expect(within(row('p1-0')).getByText('2:05')).toBeInTheDocument()
    expect(within(row('p1-0')).getByText('release')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await flush()
    expect(calls(invoke, 'release:list').map((c) => c[1])).toEqual([
      { environmentId: 'e1', limit: HISTORY_PAGE },
      { environmentId: 'e1', limit: HISTORY_PAGE, before: `p1-${HISTORY_PAGE - 1}` },
    ])
    expect(within(list).getAllByRole('listitem')).toHaveLength(HISTORY_PAGE + 1)
    expect(within(row('rel-1')).getByText('2 services')).toBeInTheDocument()
    // A short page is the last one.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()

    await user.click(within(row('p1-3')).getByRole('button', { name: /v2/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/deployments/release/p1-3')
  })

  it('rollback offered only when every service of the release is still latest', async () => {
    const running = summary({ id: 'rel-4', status: 'running', finishedAt: null, serviceIds: ['s3'], createdAt: '2026-10-19T13:00:00.000Z' })
    const rb = summary({ id: 'rel-5', kind: 'rollback', rollbackOf: 'rel-6', serviceIds: ['s3'], createdAt: '2026-10-19T09:00:00.000Z' })
    await mount({ pages: [[running, R3, R2, R1, rb]] })
    // rel-3 is the newest for worker, rel-2 for api.
    expect(within(row('rel-3')).getByRole('button', { name: 'Rollback' })).toBeInTheDocument()
    expect(within(row('rel-2')).getByRole('button', { name: 'Rollback' })).toBeInTheDocument()
    // rel-1's api and worker were both deployed again since.
    expect(within(row('rel-1')).queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    // Still running, and a rollback itself: neither is offered.
    expect(within(row('rel-4')).queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    expect(within(row('rel-5')).getByText('rollback')).toBeInTheDocument()
    expect(within(row('rel-5')).queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
  })

  it('rollback confirm names siblings whose code moves back', async () => {
    const { invoke, user } = await mount()
    await user.click(within(row('rel-2')).getByRole('button', { name: 'Rollback' }))
    const dialog = await screen.findByRole('dialog', { name: 'Roll back v1.5.0 in staging?' })
    expect(within(dialog).getByText(/api on app1: bbbbbbb → aaaaaaa/)).toBeInTheDocument()
    // worker shares the checkout and a later release deployed it.
    expect(within(dialog).getByText(/Code for core moves back to aaaaaaa; worker keep running their current images\./)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/Type .* to confirm/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }))
    await flush()
    expect(calls(invoke, 'release:rollback')).toEqual([['release:rollback', 'rel-2', {}]])
    expect(screen.getByTestId('where')).toHaveTextContent('/deployments/release/rel-rb')
  })

  it('protected rollback needs the typed name', async () => {
    const { invoke, user } = await mount({ protectedEnv: true })
    await user.click(within(row('rel-2')).getByRole('button', { name: 'Rollback' }))
    const dialog = await screen.findByRole('dialog', { name: 'Roll back v1.5.0 in staging?' })
    const confirm = within(dialog).getByRole('button', { name: 'Roll back' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type staging to confirm'), 'stagin')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type staging to confirm'), 'g')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await flush()
    expect(calls(invoke, 'release:rollback')).toEqual([['release:rollback', 'rel-2', { typedName: 'staging' }]])
  })

  it('cancel confirm then cancelling state', async () => {
    const stored = events(OK_RUN.slice(0, 10))
    const invoke = mockBridge({ 'release:get': releaseDetail({ status: 'running', startedAt: '2026-10-19T10:00:00.000Z' }), 'release:cancel': null })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:events') return stored.filter((e) => e.seq > (args[1] as number))
      return base(channel)
    })
    render(
      <MemoryRouter>
        <ReleaseView releaseId={REL} />
      </MemoryRouter>,
    )
    await flush()
    await flush()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel the release?' })
    expect(within(dialog).getByText('Cancel the release? Running steps are stopped and the lock is released.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel release' }))
    await flush()
    expect(calls(invoke, 'release:cancel')).toEqual([['release:cancel', REL]])
    await waitFor(() => expect(screen.getByText('cancelling')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    // The running step says so until main stops it.
    const running = document.querySelector('[data-state="cancelling"]')
    expect(running).not.toBeNull()
    expect(running).toHaveAccessibleName(/: cancelling$/)
  })
})
