import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { EnvironmentNotifications } from '../../src/renderer/src/pages/products/EnvironmentNotifications'
import { useSettingsCommands } from '../../src/renderer/src/settings/commands'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { toast } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_NOTIFY_EVENTS, type EnvironmentIntegrations, type NotificationRecord } from '../../src/shared/settings'
import { DEFAULT_VAULT_ID, type SecretMeta } from '../../src/shared/vault'
import { environment, mockBridge } from './helpers'

const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))
vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const TS = '2026-10-19T12:00:00.000Z'
const ENV = '33333333-3333-4333-8333-333333333333'
const PROD = '99999999-9999-4999-8999-999999999999'
const HOOK = '77777777-7777-4777-8777-777777777777'
const webhook: SecretMeta = { id: HOOK, vaultId: DEFAULT_VAULT_ID, name: 'Teams #deploys', kind: 'webhook', createdAt: TS, updatedAt: TS }
const blank = (environmentId: string): EnvironmentIntegrations => ({
  environmentId, notifyEvents: DEFAULT_NOTIFY_EVENTS, teamsWebhookSecretId: null, emailTo: [], emailCc: [], qaOnDeploy: false, qa: null, qaWait: false, updatedAt: null,
})
const log: NotificationRecord[] = [
  { id: 'n1', at: TS, sourceType: 'release', sourceId: 'r1', event: 'release.succeeded', channel: 'teams', status: 'sent', detail: null },
  { id: 'n2', at: TS, sourceType: 'release', sourceId: 'r1', event: 'release.succeeded', channel: 'email', status: 'failed', detail: 'SendGrid rejected the key' },
]

function bridge(env = environment({ id: ENV, name: 'staging' }), saved?: EnvironmentIntegrations) {
  return mockBridge({
    'integration:get': saved ?? blank(env.id),
    'secret:list': [webhook],
    'notify:log': log,
    'integration:update': { ...blank(env.id), updatedAt: TS },
  })
}
const renderSection = (env = environment({ id: ENV, name: 'staging' })) =>
  render(
    <MemoryRouter>
      <EnvironmentNotifications environment={env} />
    </MemoryRouter>,
  )
const section = () => screen.getByRole('region', { name: 'Notifications and QA' })

beforeEach(() => vi.mocked(toast).mockClear())
afterEach(() => inventoryStore.set(null))

describe('EnvironmentNotifications', () => {
  it('environment notifications round-trip events, recipients and QA', async () => {
    const invoke = bridge()
    renderSection()
    await waitFor(() => expect(within(section()).getByRole('button', { name: 'Release failed' })).toHaveAttribute('aria-pressed', 'true'))
    const s = section()
    expect(within(s).getByRole('button', { name: 'Release started' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(s).getByRole('button', { name: 'Release started' }))
    fireEvent.click(within(s).getByRole('button', { name: 'Tunnel failed' }))
    fireEvent.change(within(s).getByLabelText('Teams webhook'), { target: { value: HOOK } })
    const to = within(s).getByLabelText('Email to')
    fireEvent.change(to, { target: { value: 'ops@example.com, qa@example.com' } })
    fireEvent.keyDown(to, { key: 'Enter' })
    fireEvent.change(within(s).getByLabelText('Email cc'), { target: { value: 'lead@example.com' } })
    fireEvent.change(within(s).getByLabelText('QA repository'), { target: { value: 'acme/qa' } })
    fireEvent.change(within(s).getByLabelText('Workflow'), { target: { value: 'qa.yml' } })
    fireEvent.change(within(s).getByLabelText('Ref'), { target: { value: 'main' } })
    // Not prod-like and never set up: QA after deploy starts on.
    expect(within(s).getByRole('switch', { name: 'Run QA after deploy' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(s).getByRole('switch', { name: 'Wait for result' }))
    fireEvent.click(within(s).getByRole('button', { name: 'Save notifications' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('integration:update', ENV, {
        notifyEvents: ['release.started', 'release.succeeded', 'release.failed', 'release.rolled_back', 'qa.finished'],
        teamsWebhookSecretId: HOOK,
        emailTo: ['ops@example.com', 'qa@example.com'],
        emailCc: ['lead@example.com'],
        qa: { repo: 'acme/qa', workflow: 'qa.yml', ref: 'main' },
        qaOnDeploy: true,
        qaWait: true,
      }),
    )
    // The log lists this environment's rows with a status each.
    expect(invoke).toHaveBeenCalledWith('notify:log', { environmentId: ENV, limit: 20 })
    const rows = within(s).getAllByRole('listitem')
    expect(rows[1]).toHaveTextContent('Failed')
    expect(rows[1]).toHaveTextContent('SendGrid rejected the key')
  })

  it('QA wait time is optional, validated 5..180, and saved with the workflow (row 46)', async () => {
    const saved = { ...blank(ENV), qa: { repo: 'acme/qa', workflow: 'qa.yml', ref: 'main' }, updatedAt: TS }
    const invoke = bridge(environment({ id: ENV, name: 'staging' }), saved)
    renderSection()
    const s = section()
    const field = await waitFor(() => within(s).getByLabelText('Wait up to (minutes)'))
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('placeholder', '45')
    const save = within(s).getByRole('button', { name: 'Save notifications' })
    for (const bad of ['4', '181', '1.5', 'abc']) {
      fireEvent.change(field, { target: { value: bad } })
      expect(save, bad).toBeDisabled()
    }
    fireEvent.change(field, { target: { value: '10' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('integration:update', ENV, expect.objectContaining({ qa: { repo: 'acme/qa', workflow: 'qa.yml', ref: 'main', waitMinutes: 10 } })),
    )
  })

  it('send test card calls notify:test for this environment', async () => {
    const invoke = bridge(environment({ id: ENV, name: 'staging' }), { ...blank(ENV), teamsWebhookSecretId: HOOK, updatedAt: TS })
    renderSection()
    const btn = await waitFor(() => within(section()).getByRole('button', { name: 'Send test card' }))
    await waitFor(() => expect(btn).toBeEnabled())
    fireEvent.click(btn)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('notify:test', { channel: 'teams', environmentId: ENV }))
  })

  it('prod environment hints QA off by default', async () => {
    const prod = environment({ id: PROD, name: 'prod' })
    bridge(prod)
    renderSection(prod)
    const sw = await waitFor(() => within(section()).getByRole('switch', { name: 'Run QA after deploy' }))
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(within(section()).getByText(/QA stays off on prod-like environments/)).toBeInTheDocument()
  })

  it('invalid email shows inline error', async () => {
    const invoke = bridge()
    renderSection()
    const to = await waitFor(() => within(section()).getByLabelText('Email to'))
    fireEvent.change(to, { target: { value: 'not-an-email' } })
    fireEvent.blur(to)
    expect(within(section()).getByText(/isn't an email address/)).toBeInTheDocument()
    expect(within(section()).getByRole('button', { name: 'Save notifications' })).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('integration:update', expect.anything(), expect.anything())
  })
})

describe('settings palette', () => {
  function Host() {
    useSettingsCommands()
    return null
  }
  it('palette registers settings and per-env test commands', async () => {
    const invoke = bridge()
    inventoryStore.set({ products: [], environments: [environment({ id: ENV, name: 'staging' })], hosts: [], identities: [], vaults: [] })
    const { unmount } = render(
      <MemoryRouter>
        <Host />
      </MemoryRouter>,
    )
    const titles = () => commandStore.get().map((c) => c.title)
    expect(titles()).toEqual(expect.arrayContaining(['Settings: AI & integrations', 'Send test Teams message to staging', 'Run QA for staging']))
    await act(async () => commandStore.get().find((c) => c.title === 'Send test Teams message to staging')!.run())
    expect(invoke).toHaveBeenCalledWith('notify:test', { channel: 'teams', environmentId: ENV })
    await act(async () => commandStore.get().find((c) => c.title === 'Run QA for staging')!.run())
    expect(invoke).toHaveBeenCalledWith('qa:dispatch', ENV)
    unmount()
    expect(titles()).not.toContain('Settings: AI & integrations')
  })
})
