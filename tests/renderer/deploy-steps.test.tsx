import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { ServiceDialog } from '../../src/renderer/src/pages/products/services/ServiceDialog'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { appService, defaultVault, deploymentMeta, envSettings, environment, host, mockBridge, product, toolingOk } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through its hook directly.
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => true,
}))

const SECRET_ID = '0190a5c2-7d3e-7000-8000-000000000001'
const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }] })

const world = (extra: Record<string, unknown> = {}) =>
  mockBridge({
    'product:list': [product({ id: 'p1', name: 'Shop', environmentIds: ['e1'] })],
    'env:list': [staging],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'vault:list': [defaultVault],
    'deploy:tooling': toolingOk(),
    'deploy:settings': envSettings(),
    'secret:list': [{ id: SECRET_ID, vaultId: DEFAULT_VAULT_ID, name: 'Stripe key', kind: 'password', createdAt: '', updatedAt: '' }],
    ...extra,
  })

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

async function openEdit(dep: Parameters<typeof deploymentMeta>[0], extra: Record<string, unknown> = {}) {
  const user = userEvent.setup()
  const invoke = world({ 'deploy:list': [deploymentMeta(dep)], 'deploy:update': deploymentMeta(dep), ...extra })
  await loadInventory()
  render(
    <MemoryRouter initialEntries={['/deployments?env=e1']}>
      <DeploymentsPage />
      <Toaster />
    </MemoryRouter>,
  )
  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  const dialog = await screen.findByRole('dialog', { name: 'Edit checkout' })
  return { user, invoke, dialog }
}

describe('deployment steps', () => {
  beforeEach(() => {
    inventoryStore.set(null)
    resetDeploy()
    clearToasts()
  })

  it('shows a legacy pre-hook as a pre-hook step under before build, and saves nothing while untouched', async () => {
    const { user, invoke, dialog } = await openEdit({ id: 'd1', name: 'api', preHook: 'echo hi' })
    const group = within(dialog).getByRole('group', { name: 'before build' })
    expect(within(group).getByText('pre-hook')).toBeInTheDocument()
    expect(within(dialog).getByRole('group', { name: 'after health check' })).not.toHaveTextContent('post-hook')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(calls(invoke, 'deploy:update')).toHaveLength(0)
  })

  it('adds a step at after up and saves steps with the hooks cleared', async () => {
    const { user, invoke, dialog } = await openEdit({ id: 'd1', name: 'api', preHook: 'echo hi' })
    await user.click(within(dialog).getByRole('button', { name: 'Add step after up' }))
    await user.type(within(dialog).getByLabelText('Script'), 'echo up')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'deploy:update')).toHaveLength(1))
    const patch = calls(invoke, 'deploy:update')[0][2] as { steps: { id: string; anchor: string; script: string }[]; preHook: null; postHook: null }
    expect(patch.preHook).toBeNull()
    expect(patch.postHook).toBeNull()
    expect(patch.steps.map((s) => [s.id, s.anchor])).toEqual([
      ['pre-hook', 'before_build'],
      ['step-2', 'after_up'],
    ])
    expect(patch.steps[1].script).toBe('echo up')
  })

  it('denies PATH as a secret env name and disables Save', async () => {
    const { user, invoke, dialog } = await openEdit({ id: 'd1', name: 'api', vaultIds: [DEFAULT_VAULT_ID], preHook: 'echo hi' })
    await user.click(within(dialog).getByRole('button', { name: 'pre-hook' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add secret' }))
    await user.type(within(dialog).getByLabelText('Secret 1 env name'), 'PATH')
    await user.selectOptions(within(dialog).getByLabelText('Secret 1'), 'Stripe key')
    expect(within(dialog).getByText('step secret env name is not allowed')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    // Secrets are listed by name, never by value.
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('secret:get')
  })

  it('locks the failure policy to continue after the tag', async () => {
    const { user, dialog } = await openEdit({ id: 'd1', name: 'api' })
    await user.click(within(dialog).getByRole('button', { name: 'Add step after tag' }))
    const policy = within(dialog).getByLabelText('On failure')
    expect(policy).toHaveValue('continue')
    expect(policy).toBeDisabled()
  })

  it('moves a step up and down within its anchor', async () => {
    const { user, invoke, dialog } = await openEdit({ id: 'd1', name: 'api' })
    await user.click(within(dialog).getByRole('button', { name: 'Add step after up' }))
    await user.type(within(dialog).getByLabelText('Script'), 'echo a')
    await user.click(within(dialog).getByRole('button', { name: 'Add step after up' }))
    await user.type(within(dialog).getByLabelText('Script'), 'echo b')
    await user.click(within(dialog).getByRole('button', { name: 'Move step-2 up' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'deploy:update')).toHaveLength(1))
    const steps = (calls(invoke, 'deploy:update')[0][2] as { steps: { id: string }[] }).steps
    expect(steps.map((s) => s.id)).toEqual(['step-2', 'step-1'])
  })
})

describe('skip unchanged toggle', () => {
  beforeEach(() => {
    inventoryStore.set(null)
    resetDeploy()
  })

  it('saves skipUnchanged', async () => {
    const user = userEvent.setup()
    const svc = appService({ id: 's1', name: 'api', deploymentId: 'd1' })
    const invoke = world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'core' })],
      'service:list': [svc],
      'service:update': { service: { ...svc, skipUnchanged: true }, tunnelRestartNeeded: false },
    })
    await loadInventory()
    await loadDeploy(['e1'])
    render(<ServiceDialog env={staging} service={svc} kind="service" onClose={() => {}} />)
    await user.click(screen.getByRole('switch', { name: 'Skip if no new commits' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'service:update')).toHaveLength(1))
    expect(calls(invoke, 'service:update')[0].slice(1)).toEqual(['s1', { skipUnchanged: true }])
  })
})
