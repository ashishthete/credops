import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { resetHub } from '../../src/renderer/src/hub/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { GrantPicker } from '../../src/renderer/src/pages/hub/GrantPicker'
import { HubPage } from '../../src/renderer/src/pages/hub/HubPage'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_GROUP_ID, type GrantScope, type HubCatalogEnv, type HubGroup, type HubSecretList, type HubStatus } from '../../src/shared/hub'
import { deploymentMeta, environment, host, mockBridge, product } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

const STAMP = '2026-10-16T09:00:00.000Z'
const VALUE = 'sk-live-THIS-IS-A-SECRET-VALUE'
const admin: HubStatus = {
  linked: true,
  url: 'https://hub.corp.example',
  hubId: 'hub-1',
  hubName: 'Corp Hub',
  signedIn: true,
  signingIn: false,
  online: true,
  user: { oid: 'o-admin', upn: 'ada@corp.example', name: 'Ada', role: 'admin', status: 'active', groupIds: [DEFAULT_GROUP_ID], createdAt: STAMP, lastSeenAt: null },
  sessionExpiresAt: null,
}
const catalogEnv = (id: string, name: string, extra: Partial<HubCatalogEnv> = {}): HubCatalogEnv => ({
  environment: { id, name, protected: false, versioned: false, autoRollback: false, currentVersion: null },
  hosts: [{ id: 'hh1', label: 'app1' }],
  services: [],
  deployments: [deploymentMeta({ id: `${id}-d1`, name: 'core', environmentId: id }) as never],
  missingSecrets: 0,
  deployKey: null,
  lock: null,
  publishedAt: STAMP,
  publishedBy: 'ada@corp.example',
  ...extra,
})
const group = (over: Partial<HubGroup> = {}): HubGroup => ({ id: 'g-ops', name: 'Ops', description: '', builtin: false, memberOids: [], grants: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

const secretList: HubSecretList = {
  secrets: [
    { id: 'sec1', environmentId: 'e1', name: 'DB_PASSWORD', kind: 'env', updatedBy: 'ada@corp.example', updatedAt: STAMP },
    // The Hub returns the global integration secrets with every environment's list.
    { id: 'glob1', environmentId: null, name: 'SENDGRID_API_KEY', kind: 'sendgrid_api_key', updatedBy: 'ada@corp.example', updatedAt: STAMP },
    { id: 'other1', environmentId: 'e9', name: 'QA_ONLY', kind: 'env', updatedBy: 'ada@corp.example', updatedAt: STAMP },
  ],
  missing: { e1: [{ secretId: 'req-2', name: 'API_TOKEN' }] },
}

async function renderHub(results: Record<string, unknown> = {}, tab?: string) {
  const invoke = mockBridge({
    'hub:status': admin,
    'hub:users': [],
    'hub:groups': [group({ id: DEFAULT_GROUP_ID, name: 'Default', builtin: true })],
    'hub:audit': [],
    'hub:catalog': [],
    'hub:locks': [],
    'hub:adminEnvironments': [catalogEnv('e1', 'staging', { missingSecrets: 1, deployKey: { fingerprint: 'SHA256:abc' } })],
    'env:list': [environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }] }), environment({ id: 'e9', name: 'qa' })],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'hub:secrets': secretList,
    'secret:list': [{ id: 'v1', vaultId: 'default', name: 'sendgrid-prod', kind: 'api_key', createdAt: STAMP, updatedAt: STAMP }],
    ...results,
  })
  await act(async () => {
    await loadInventory()
  })
  render(
    <MemoryRouter initialEntries={['/hub']}>
      <HubPage />
      <Toaster />
    </MemoryRouter>,
  )
  await act(async () => {})
  if (tab) {
    await userEvent.setup().click(await screen.findByRole('tab', { name: tab }))
    await act(async () => {})
  }
  return invoke
}

describe('hub admin panels', () => {
  beforeEach(() => {
    motion.safe = true
    resetHub()
    resetDeploy()
    inventoryStore.set(null)
    clearToasts()
  })
  afterEach(cleanup)

  it('secrets panel never renders a value and has no reveal control', async () => {
    const invoke = await renderHub({ 'hub:secrets': { ...secretList, secrets: secretList.secrets.map((m, i) => (i === 0 ? { ...m, value: VALUE } : m)) } }, 'Secrets')
    const panel = await screen.findByRole('region', { name: 'Secrets for staging' })
    expect(await within(panel).findByText('DB_PASSWORD')).toBeInTheDocument()
    expect(within(panel).queryByText('SENDGRID_API_KEY')).not.toBeInTheDocument()
    expect(within(panel).queryByText('QA_ONLY')).not.toBeInTheDocument()
    expect(within(panel).getByText(/Set · ada@corp.example/)).toBeInTheDocument()
    expect(within(panel).getByText('API_TOKEN')).toBeInTheDocument()
    expect(within(panel).getAllByText('Missing')).toHaveLength(2)
    expect(document.body.innerHTML).not.toContain(VALUE)
    expect(screen.queryByRole('button', { name: /reveal|show value|copy value/i })).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"], textarea')).toBeNull()
    // Upload goes by id from the vault; one or all.
    const user = userEvent.setup()
    await user.click(within(panel).getByRole('button', { name: 'Upload API_TOKEN from vault' }))
    await waitFor(() => expect(calls(invoke, 'hub:uploadSecrets')[0].slice(1)).toEqual(['e1', ['req-2']]))
    await user.click(within(panel).getByRole('button', { name: 'Upload all from vault for staging' }))
    await waitFor(() => expect(calls(invoke, 'hub:uploadSecrets')[1].slice(1)).toEqual(['e1', undefined]))
  })

  it('integrations are picked from the vault by id', async () => {
    const invoke = await renderHub({}, 'Secrets')
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('SendGrid API key'), 'v1')
    await user.click(screen.getByRole('button', { name: 'Set SendGrid API key' }))
    await waitFor(() => expect(calls(invoke, 'hub:setIntegrationSecret')[0].slice(1)).toEqual([null, 'sendgrid_api_key', 'v1']))
    await user.selectOptions(screen.getByLabelText('Teams webhook for staging'), 'v1')
    await user.click(screen.getByRole('button', { name: 'Set Teams webhook for staging' }))
    await waitFor(() => expect(calls(invoke, 'hub:setIntegrationSecret')[1].slice(1)).toEqual(['e1', 'teams_webhook', 'v1']))
  })

  it('deploy key copy puts the public key on the clipboard', async () => {
    const PUB = 'ssh-ed25519 AAAAC3Nza deploy@hub'
    const writeText = vi.fn(async () => undefined)
    const invoke = await renderHub({ 'hub:deployKey': { publicKey: PUB, fingerprint: 'SHA256:abc' } }, 'Environments')
    const user = userEvent.setup()
    // userEvent installs its own clipboard stub; ours goes in after it.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    expect(await screen.findByText(/Add this key to/)).toHaveTextContent('authorized_keys on every host and jump host of staging')
    expect(screen.getByText('SHA256:abc')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show public key for staging' }))
    expect(calls(invoke, 'hub:deployKey')[0].slice(1)).toEqual(['e1', false])
    await user.click(await screen.findByRole('button', { name: 'Copy public key for staging' }))
    expect(writeText).toHaveBeenCalledWith(PUB)
    // Rotating asks first, then regenerates.
    await user.click(screen.getByRole('button', { name: 'Rotate deploy key for staging' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Rotate the deploy key for staging?' })).getByRole('button', { name: 'Rotate' }))
    await waitFor(() => expect(calls(invoke, 'hub:deployKey')[1].slice(1)).toEqual(['e1', true]))
  })

  it('publishes, re-publishes with a count diff, unpublishes after a confirm, and links to missing secrets', async () => {
    const invoke = await renderHub({ 'hub:publish': { manifestHash: 'h', missingSecrets: ['A'] }, 'hub:unpublish': null }, 'Environments')
    const user = userEvent.setup()
    // qa is local only; staging is published and its Hub copy has no services while this machine's may differ.
    await user.click(await screen.findByRole('button', { name: 'Publish to Hub qa' }))
    await waitFor(() => expect(calls(invoke, 'hub:publish')[0].slice(1)).toEqual(['e9']))
    expect(await screen.findByText('Published. 1 secret still missing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-publish staging' })).toBeInTheDocument()
    expect(screen.getByText(/On the Hub: 1 host, 0 services, 1 deployment/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unpublish staging' }))
    expect(calls(invoke, 'hub:unpublish')).toHaveLength(0)
    await user.click(within(await screen.findByRole('dialog', { name: 'Unpublish staging?' })).getByRole('button', { name: 'Unpublish' }))
    await waitFor(() => expect(calls(invoke, 'hub:unpublish')[0].slice(1)).toEqual(['e1']))
    await user.click(screen.getByRole('button', { name: 'Missing secrets (1)' }))
    expect(await screen.findByRole('region', { name: 'Secrets for staging' })).toBeInTheDocument()
  })

  it('grant picker builds each scope', async () => {
    const user = userEvent.setup()
    const added: GrantScope[] = []
    mockBridge({ 'hub:status': admin, 'hub:adminEnvironments': [catalogEnv('e1', 'staging'), catalogEnv('e2', 'prod')] })
    const { startHubSync } = await import('../../src/renderer/src/hub/store')
    const stop = startHubSync()
    render(<GrantPicker groupName="Ops" onAdd={(s) => void added.push(s)} />)
    await act(async () => {})
    const add = screen.getByRole('button', { name: 'Add grant to Ops' })
    await user.click(add)
    await user.selectOptions(screen.getByLabelText('Grant scope for Ops'), 'environment')
    expect(add).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Environment for Ops'), 'e2')
    await user.click(add)
    await user.selectOptions(screen.getByLabelText('Grant scope for Ops'), 'deployment')
    await user.selectOptions(screen.getByLabelText('Environment for Ops'), 'e1')
    expect(add).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Deployment for Ops'), 'e1-d1')
    await user.click(add)
    expect(added).toEqual([{ kind: 'all' }, { kind: 'environment', environmentId: 'e2' }, { kind: 'deployment', environmentId: 'e1', deploymentId: 'e1-d1' }])
    stop()
  })

  it("groups local environments under their product; Hub-only ones stay as they are", async () => {
    const shop = product({ id: 'p1', name: 'Shop', environmentIds: ['e9', 'e1'] })
    const env = (id: string, name: string) => environment({ id, name, productId: 'p1' })
    await renderHub({ 'product:list': [shop], 'env:list': [env('e1', 'staging'), env('e9', 'qa')], 'hub:adminEnvironments': [catalogEnv('e1', 'staging'), catalogEnv('e5', 'team-only')] }, 'Environments')
    const group = await screen.findByRole('region', { name: 'Shop' })
    // In the product's order, not the inventory's.
    expect(within(group).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Shop', 'qa', 'staging'])
    expect(within(group).queryByText('team-only')).toBeNull()
    expect(screen.getByText('team-only')).toBeInTheDocument()

    // The grant picker groups the same way, with the inventory already loaded.
    cleanup()
    render(<GrantPicker groupName="Ops" onAdd={() => {}} />)
    await userEvent.setup().selectOptions(screen.getByLabelText('Grant scope for Ops'), 'environment')
    const select = screen.getByLabelText('Environment for Ops')
    const optgroup = within(select).getByRole('group', { name: 'Shop' })
    expect(within(optgroup).getAllByRole('option').map((o) => o.textContent)).toEqual(['staging'])
    // The Hub-only environment stays a plain option.
    expect(within(select).getByRole('option', { name: 'team-only' }).closest('optgroup')).toBeNull()
  })

  it('groups Hub-only environments by their product name, joining a local product of that name', async () => {
    const shop = product({ id: 'p1', name: 'Shop', environmentIds: ['e1'] })
    const hubEnv = (id: string, name: string, productName?: string) =>
      catalogEnv(id, name, productName ? { environment: { id, name, protected: false, versioned: false, autoRollback: false, currentVersion: null, product: { id: `remote-${id}`, name: productName } } } : {})
    const adminEnvs = [catalogEnv('e1', 'staging'), hubEnv('e5', 'shop-eu', 'SHOP'), hubEnv('e6', 'pay-eu', 'Payments'), hubEnv('e7', 'old-eu')]
    await renderHub({ 'product:list': [shop], 'env:list': [environment({ id: 'e1', name: 'staging', productId: 'p1' })], 'hub:adminEnvironments': adminEnvs }, 'Environments')
    const heads = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(await screen.findByRole('region', { name: 'Shop' })).toBeInTheDocument()
    expect(heads('Shop')).toEqual(['Shop', 'staging', 'shop-eu'])
    expect(heads('Payments')).toEqual(['Payments', 'pay-eu'])
    // A manifest from an older desktop names no product: ungrouped, as before.
    expect(screen.getByText('old-eu').closest('section')).toBeNull()

    cleanup()
    render(<GrantPicker groupName="Ops" onAdd={() => {}} />)
    await userEvent.setup().selectOptions(screen.getByLabelText('Grant scope for Ops'), 'environment')
    const select = screen.getByLabelText('Environment for Ops')
    const options = (name: string) => within(within(select).getByRole('group', { name })).getAllByRole('option').map((o) => o.textContent)
    expect(options('Shop')).toEqual(['staging', 'shop-eu'])
    expect(options('Payments')).toEqual(['pay-eu'])
    expect(within(select).getByRole('option', { name: 'old-eu' }).closest('optgroup')).toBeNull()
  })

  it('groups panel adds a scoped grant through the picker', async () => {
    const invoke = await renderHub({ 'hub:groups': [group()], 'hub:addGrant': null }, 'Groups')
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('Grant scope for Ops'), 'environment')
    await user.selectOptions(screen.getByLabelText('Environment for Ops'), 'e1')
    await user.click(screen.getByRole('button', { name: 'Add grant to Ops' }))
    await waitFor(() => expect(calls(invoke, 'hub:addGrant')[0].slice(1)).toEqual(['g-ops', { kind: 'environment', environmentId: 'e1' }]))
  })

  it('reduced motion renders with no transforms', async () => {
    motion.safe = false
    await renderHub({}, 'Environments')
    const panel = await screen.findByRole('tabpanel')
    expect(panel.getAttribute('data-motion')).toBe('reduced')
    expect(panel.getAttribute('style') ?? '').not.toMatch(/transform|translate/)
  })
})
