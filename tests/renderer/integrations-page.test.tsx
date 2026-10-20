import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { SettingsPage } from '../../src/renderer/src/pages/settings/SettingsPage'
import { AppEvents } from '../../src/renderer/src/settings/events'
import { resetIntegrations } from '../../src/renderer/src/settings/store'
import { toast } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_SETTINGS, type IntegrationSettings, type IntegrationStatus, type NotificationRecord } from '../../src/shared/settings'
import { DEFAULT_VAULT_ID, type SecretMeta } from '../../src/shared/vault'
import { emitBridgeEvent, environment, mockBridge } from './helpers'

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
const REL = '44444444-4444-4444-8444-444444444444'
const KEY = '77777777-7777-4777-8777-777777777777'
const NEW_KEY = '88888888-8888-4888-8888-888888888888'
const secret = (over: Partial<SecretMeta> & { id: string; name: string }): SecretMeta => ({
  vaultId: DEFAULT_VAULT_ID, kind: 'api_key', createdAt: TS, updatedAt: TS, ...over,
})
const STATUS: IntegrationStatus = { ai: { configured: true, model: 'claude-opus-5-5' }, sendgrid: false, github: false, macosSupported: true }
const SETTINGS: IntegrationSettings = { ...DEFAULT_SETTINGS, aiApiKeySecretId: KEY }

function bridge(over: Record<string, unknown> = {}) {
  return mockBridge({
    'settings:get': SETTINGS,
    'settings:status': STATUS,
    'secret:list': [secret({ id: KEY, name: 'Anthropic key' })],
    'env:list': [environment({ id: ENV, name: 'staging' })],
    ...over,
  })
}
function Location() {
  const l = useLocation()
  return <output data-testid="location">{l.pathname + l.search}</output>
}
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsPage />
    </MemoryRouter>,
  )
const card = (name: string) => screen.getByRole('region', { name })

beforeEach(() => {
  resetIntegrations()
  vi.mocked(toast).mockClear()
})
afterEach(() => inventoryStore.set(null))

describe('IntegrationsPage', () => {
  it('shows configured state per card', async () => {
    bridge()
    renderPage()
    await waitFor(() => expect(within(card('AI')).getByText('Configured')).toBeInTheDocument())
    expect(within(card('SendGrid')).getByText('Not configured')).toBeInTheDocument()
    expect(within(card('GitHub')).getByText('Not configured')).toBeInTheDocument()
    expect(within(card('macOS')).getByText('Configured')).toBeInTheDocument()
    expect(within(card('AI')).getByLabelText('API key')).toHaveValue(KEY)
  })

  it('new API key creates a secret and selects it; value never rendered back', async () => {
    const invoke = bridge({
      'secret:create': secret({ id: NEW_KEY, name: 'Anthropic API key' }),
      'settings:update': { ...SETTINGS, aiApiKeySecretId: NEW_KEY },
    })
    renderPage()
    const ai = await waitFor(() => card('AI'))
    await waitFor(() => expect(within(ai).getByLabelText('API key')).toHaveValue(KEY))
    fireEvent.change(within(ai).getByLabelText('API key'), { target: { value: '__new' } })
    fireEvent.change(within(ai).getByLabelText('New API key'), { target: { value: 'sk-ant-secret-123' } })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'secret:create') return secret({ id: NEW_KEY, name: 'Anthropic API key' })
      if (channel === 'settings:update') return { ...SETTINGS, aiApiKeySecretId: NEW_KEY }
      if (channel === 'settings:status') return STATUS
      if (channel === 'secret:list') return [secret({ id: KEY, name: 'Anthropic key' }), secret({ id: NEW_KEY, name: 'Anthropic API key' })]
      return null
    })
    fireEvent.click(within(ai).getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(within(ai).getByLabelText('API key')).toHaveValue(NEW_KEY))
    expect(invoke).toHaveBeenCalledWith('secret:create', { vaultId: DEFAULT_VAULT_ID, name: 'Anthropic API key', kind: 'api_key', value: 'sk-ant-secret-123' })
    expect(invoke).toHaveBeenCalledWith('settings:update', { aiApiKeySecretId: NEW_KEY })
    expect(within(ai).queryByLabelText('New API key')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-ant-secret-123')
  })

  it('model validation error inline', async () => {
    const invoke = bridge()
    renderPage()
    const ai = await waitFor(() => card('AI'))
    const model = await waitFor(() => within(ai).getByLabelText('Model'))
    await waitFor(() => expect(model).toHaveValue('claude-opus-5-5'))
    fireEvent.change(model, { target: { value: 'gpt-4' } })
    fireEvent.blur(model)
    expect(within(ai).getByText(/Use a Claude model id/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.anything())
    fireEvent.change(model, { target: { value: 'claude-sonnet-5-5' } })
    fireEvent.blur(model)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:update', { aiModel: 'claude-sonnet-5-5' }))
  })

  it('test notification calls notify:test', async () => {
    const invoke = bridge()
    renderPage()
    const mac = await waitFor(() => card('macOS'))
    fireEvent.click(within(mac).getByRole('button', { name: 'Send test notification' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('notify:test', { channel: 'macos' }))
  })
})

describe('AppEvents', () => {
  const renderEvents = () =>
    render(
      <MemoryRouter initialEntries={['/products']}>
        <AppEvents />
        <Routes>
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    )

  it('app:navigate routes', async () => {
    bridge()
    renderEvents()
    act(() => emitBridgeEvent('app:navigate', { route: '#/tunnels' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/tunnels')
    act(() => emitBridgeEvent('app:navigate', { route: '/deployments?env=x' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/deployments?env=x')
  })

  it('failed notify:sent shows error toast', async () => {
    bridge({ 'release:get': { id: REL, environmentId: ENV, environmentName: 'staging' } })
    renderEvents()
    const rec = (over: Partial<NotificationRecord>): NotificationRecord => ({
      id: 'n1', at: TS, sourceType: 'release', sourceId: REL, event: 'release.failed', channel: 'teams', status: 'sent', detail: null, ...over,
    })
    act(() => emitBridgeEvent('notify:sent', rec({})))
    act(() => emitBridgeEvent('notify:sent', rec({ id: 'n2', status: 'failed', detail: 'HTTP 500' })))
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    const opts = vi.mocked(toast).mock.calls[0][0]
    expect(opts).toMatchObject({ title: 'Teams notification to staging failed', tone: 'error', description: 'HTTP 500' })
    act(() => opts.action!.run())
    expect(screen.getByTestId('location')).toHaveTextContent(`/deployments?env=${ENV}`)
  })
})
