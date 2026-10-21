import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deployStore, resetDeploy } from '../../src/renderer/src/deploy/store'
import { resetHub } from '../../src/renderer/src/hub/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_GROUP_ID, type HubCatalogEnv, type HubEnvLock, type HubStatus } from '../../src/shared/hub'
import { events, REL, releaseDetail } from './fixtures/release-events'
import { appService, defaultVault, deploymentMeta, emitBridgeEvent, envSettings, environment, host, mockBridge, product, toolingOk } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const STAMP = '2026-10-16T09:00:00.000Z'
const ME = { oid: 'o-me', upn: 'me@corp.example', name: 'Me', role: 'maintainer' as const, status: 'active' as const, groupIds: [DEFAULT_GROUP_ID], createdAt: STAMP, lastSeenAt: null }
const status = (user: Partial<Omit<typeof ME, 'status'>> & { status?: 'active' | 'pending' } = {}): HubStatus => ({
  linked: true,
  url: 'https://hub.corp.example',
  hubId: 'hub-1',
  hubName: 'Corp Hub',
  signedIn: true,
  signingIn: false,
  online: true,
  user: { ...ME, ...user } as never,
  sessionExpiresAt: null,
})

const lock = (over: Partial<HubEnvLock> = {}): HubEnvLock => ({
  environmentId: 'hub-prod',
  kind: 'manual',
  releaseId: null,
  holder: { oid: 'o-bob', name: 'Bob' },
  reason: 'db migration',
  createdAt: STAMP,
  expiresAt: '2026-10-16T13:00:00.000Z',
  ...over,
})
const teamEnv = (over: Partial<HubCatalogEnv['environment']> = {}, extra: Partial<HubCatalogEnv> = {}): HubCatalogEnv => ({
  environment: { id: 'hub-prod', name: 'prod-eu', protected: true, versioned: false, autoRollback: false, currentVersion: null, ...over },
  hosts: [{ id: 'hh1', label: 'eu-app1' }],
  services: [],
  deployments: [deploymentMeta({ id: 'hd1', name: 'core', environmentId: 'hub-prod', hostId: 'hh1' }) as never],
  missingSecrets: 0,
  deployKey: null,
  lock: null,
  publishedAt: STAMP,
  publishedBy: 'ada@corp.example',
  ...extra,
})

const staging = environment({ id: 'e1', name: 'staging', productId: 'p1', hosts: [{ hostId: 'h1', role: 'app' }] })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

async function open(results: Record<string, unknown> = {}, path = '/deployments?env=hub-prod') {
  const invoke = mockBridge({
    'hub:status': status(),
    'product:list': [product({ id: 'p1', name: 'Shop', environmentIds: ['e1'] })],
    'env:list': [staging],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'vault:list': [defaultVault],
    'deploy:tooling': toolingOk(),
    'deploy:settings': envSettings(),
    'hub:catalog': [teamEnv()],
    'hub:locks': [],
    'deploy:list': [deploymentMeta({ id: 'hd1', name: 'core', environmentId: 'hub-prod', hostId: 'hh1' })],
    'service:list': [appService({ id: 'hs1', name: 'api', environmentId: 'hub-prod', deploymentId: 'hd1' })],
    ...results,
  })
  await act(async () => {
    await loadInventory()
  })
  render(
    <MemoryRouter initialEntries={[path]}>
      <DeploymentsPage />
      <Toaster />
    </MemoryRouter>,
  )
  await act(async () => {})
  return invoke
}

describe('team deployments', () => {
  beforeEach(() => {
    motion.safe = true
    resetHub()
    resetDeploy()
    inventoryStore.set(null)
    clearToasts()
  })
  afterEach(cleanup)

  it('team environments appear in a Hub group with lock badges', async () => {
    await open({ 'hub:locks': [lock()], 'hub:catalog': [teamEnv(), teamEnv({ id: 'hub-stg', name: 'stg-eu', protected: false }, { lock: null })] }, '/deployments')
    const group = await screen.findByRole('group', { name: 'Team (Hub)' })
    const row = within(group).getByRole('listitem', { name: 'prod-eu' })
    expect(within(group).getByRole('listitem', { name: 'stg-eu' })).toBeInTheDocument()
    // Local environments keep their own group; a team environment gets no Add service here.
    expect(screen.getByRole('group', { name: 'Shop' })).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /^Add service/ })).not.toBeInTheDocument()
    expect(within(row).getByText('eu-app1 · 1 service')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(row).getByRole('button', { name: /^prod-eu,/ }))
    expect(await screen.findByText(/Frozen by Bob until .+: db migration/)).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Deployments›Team (Hub)›prod-eu')
    // A team environment's cards are read only.
    expect(screen.queryByRole('button', { name: 'New deployment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'eu-app1' })).toBeInTheDocument()
  })

  it('a release lock reads Releasing and a local env published to the Hub gets the chip', async () => {
    const invoke = await open(
      { 'hub:catalog': [teamEnv({ id: 'e1', name: 'staging', protected: false })], 'hub:locks': [lock({ environmentId: 'e1', kind: 'release', releaseId: REL, reason: null, expiresAt: null })] },
      '/deployments?env=e1',
    )
    expect(await screen.findByText('Releasing — Bob')).toBeInTheDocument()
    expect(screen.getByText('Published to Hub')).toBeInTheDocument()
    // A live lock event re-fetches the locks and updates the badge.
    const before = calls(invoke, 'hub:locks').length
    invoke.mockImplementation(async (channel: string) => (channel === 'hub:locks' ? [] : null))
    await act(async () => emitBridgeEvent('hub:locks', undefined))
    await waitFor(() => expect(calls(invoke, 'hub:locks').length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.queryByText('Releasing — Bob')).not.toBeInTheDocument())
  })

  it('a team environment that arrives after the first deploy load becomes deployable', async () => {
    const invoke = await open({ 'hub:catalog': [], 'deploy:list': [] }, '/deployments')
    await screen.findByRole('group', { name: 'Shop' })
    expect(screen.queryByRole('group', { name: 'Team (Hub)' })).not.toBeInTheDocument()
    // The catalog arrives over HTTP after sign-in; main now lists its deployments in deploy:list.
    const arrived = deploymentMeta({ id: 'hd1', name: 'core', environmentId: 'hub-prod', hostId: 'hh1' })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:catalog') return [teamEnv()]
      if (channel === 'hub:locks') return []
      if (channel === 'deploy:list') return [arrived]
      if (channel === 'deploy:settings') return envSettings()
      if (channel === 'hub:status') return status()
      if (channel === 'service:list') return []
      return null
    })
    await act(async () => emitBridgeEvent('hub:catalog', undefined))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Deploy to prod-eu' }))
    expect(await screen.findByRole('dialog', { name: 'Deploy to prod-eu' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: /^prod-eu,/ }))
    expect(await screen.findByRole('region', { name: 'eu-app1' })).toBeInTheDocument()
    expect(screen.queryByText(/No deployments in/)).not.toBeInTheDocument()
  })

  it('Hub sign-out removes the team environments from the deploy store', async () => {
    const invoke = await open()
    expect(await screen.findByRole('region', { name: 'eu-app1' })).toBeInTheDocument()
    expect(deployStore.get().deployments.some((d) => d.environmentId === 'hub-prod')).toBe(true)
    // Main empties the catalog on sign-out and announces it; deploy:list then lists no Hub deployments.
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hub:status') return { ...status(), signedIn: false, user: null }
      if (channel === 'deploy:list' || channel === 'hub:catalog' || channel === 'hub:locks') return []
      return null
    })
    await act(async () => emitBridgeEvent('hub:state', { ...status(), signedIn: false, user: null }))
    await act(async () => emitBridgeEvent('hub:catalog', undefined))
    await waitFor(() => expect(deployStore.get().deployments.some((d) => d.environmentId === 'hub-prod')).toBe(false))
    expect(screen.queryByRole('group', { name: 'Team (Hub)' })).not.toBeInTheDocument()
  })

  it('a pending user sees the pending empty state in place of team environments', async () => {
    const invoke = await open({ 'hub:status': status({ status: 'pending' }), 'hub:catalog': [] }, '/deployments?env=e1')
    expect(await screen.findByText('Waiting for a Hub admin')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Team (Hub)' })).not.toBeInTheDocument()
    expect(calls(invoke, 'hub:catalog')).toHaveLength(0)
  })

  it('wizard on a Hub env calls the routed release IPC', async () => {
    const user = userEvent.setup()
    const invoke = await open({
      'release:preflight': { releaseId: REL },
      'deploy:previewPlaybook': { playbook: '[]', sha256: 'e'.repeat(64) },
      'release:get': releaseDetail({ status: 'preflight', runs: [] }),
      'release:active': [],
    })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:events') return events([{ type: 'preflight.done', report: { releaseId: REL, checks: [], commits: {}, dockerModes: {}, composeServices: {}, serviceCommits: {}, locks: {}, commitsTotal: 3, blocked: false } }])
      return (base as (...a: unknown[]) => unknown)(channel, ...args)
    })
    await user.click(await screen.findByRole('button', { name: 'Deploy…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deploy to prod-eu' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'api' }))
    await user.click(within(dialog).getByRole('button', { name: 'Run preflight' }))
    expect(calls(invoke, 'release:preflight')[0][1]).toMatchObject({ environmentId: 'hub-prod', serviceIds: ['hs1'] })
    await user.click(await within(dialog).findByRole('button', { name: 'Review playbook' }))
    expect(calls(invoke, 'deploy:previewPlaybook').map((c) => c[1])).toEqual([REL])
    // prod-eu is protected: the typed name is required, from the catalog's own flag.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deploy' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Deploy' }))
    const confirm = await screen.findByRole('dialog', { name: 'Deploy to prod-eu?' })
    const ok = within(confirm).getByRole('button', { name: 'Deploy' })
    expect(ok).toBeDisabled()
    await user.type(within(confirm).getByLabelText('Type prod-eu to confirm'), 'prod-eu')
    await user.click(ok)
    await waitFor(() => expect(calls(invoke, 'release:start')[0].slice(1)).toEqual([REL, { typedName: 'prod-eu', redeploy: false, playbookSha256: 'e'.repeat(64) }]))
  })

  it('env_locked error shows the holder', async () => {
    const user = userEvent.setup()
    const invoke = await open({ 'release:preflight': { releaseId: REL } })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:preflight') throw new Error('Locked by Bob since 2026-10-16T09:00:00.000Z: db migration')
      return (base as (...a: unknown[]) => unknown)(channel, ...args)
    })
    await user.click(await screen.findByRole('button', { name: 'Deploy…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deploy to prod-eu' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'api' }))
    await user.click(within(dialog).getByRole('button', { name: 'Run preflight' }))
    expect(await within(dialog).findByText(/Locked by Bob/)).toBeInTheDocument()
  })

  it('lifting another\'s freeze on a protected env needs the typed name', async () => {
    const user = userEvent.setup()
    const invoke = await open({ 'hub:status': status({ role: 'admin' as never }), 'hub:locks': [lock()], 'hub:unfreeze': null })
    await user.click(await screen.findByRole('button', { name: 'Lift freeze' }))
    const confirm = await screen.findByRole('dialog', { name: "Lift Bob's freeze on prod-eu?" })
    const ok = within(confirm).getByRole('button', { name: 'Lift freeze' })
    expect(ok).toBeDisabled()
    expect(calls(invoke, 'hub:unfreeze')).toHaveLength(0)
    await user.type(within(confirm).getByLabelText('Type prod-eu to confirm'), 'prod-eu')
    await user.click(ok)
    await waitFor(() => expect(calls(invoke, 'hub:unfreeze')[0].slice(1)).toEqual(['hub-prod', 'prod-eu']))
  })

  it('lifting your own freeze needs no confirmation, and Freeze… sends reason and hours', async () => {
    const user = userEvent.setup()
    const invoke = await open({ 'hub:locks': [lock({ holder: { oid: 'o-me', name: 'Me' } })], 'hub:unfreeze': null })
    await user.click(await screen.findByRole('button', { name: 'Lift freeze' }))
    await waitFor(() => expect(calls(invoke, 'hub:unfreeze')[0].slice(1)).toEqual(['hub-prod', null]))
    cleanup()
    resetHub()
    resetDeploy()
    inventoryStore.set(null)
    const invoke2 = await open({ 'hub:freeze': lock() })
    await user.click(await screen.findByRole('button', { name: 'Freeze…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Freeze prod-eu' })
    await user.type(within(dialog).getByLabelText('Reason'), 'release window')
    await user.click(within(dialog).getByRole('button', { name: 'Freeze' }))
    await waitFor(() => expect(calls(invoke2, 'hub:freeze')[0].slice(1)).toEqual(['hub-prod', 'release window', 4]))
  })

  it('Lift freeze is offered only to the holder or an admin', async () => {
    await open({ 'hub:locks': [lock()] })
    expect(await screen.findByText(/Frozen by Bob/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lift freeze' })).not.toBeInTheDocument()
  })

  it('Freeze needs a reason and whole hours', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(await screen.findByRole('button', { name: 'Freeze…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Freeze prod-eu' })
    const go = within(dialog).getByRole('button', { name: 'Freeze' })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Reason'), '   ')
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Reason'), 'window')
    expect(go).toBeEnabled()
    await user.clear(within(dialog).getByLabelText('Hours'))
    await user.type(within(dialog).getByLabelText('Hours'), '1.5')
    expect(go).toBeDisabled()
  })

  it('reduced motion renders with no transforms', async () => {
    motion.safe = false
    await open({ 'hub:locks': [lock()] })
    const card = await screen.findByRole('listitem', { name: 'core' })
    expect(card.getAttribute('style') ?? '').not.toMatch(/transform|translate/)
  })
})
