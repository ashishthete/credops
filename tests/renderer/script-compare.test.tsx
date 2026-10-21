import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { DeploymentMeta } from '../../src/shared/deploy'
import type { QaWorkflow } from '../../src/shared/settings'
import { deploymentMeta, envSettings, environment, host, mockBridge, product, toolingOk } from './helpers'

const alpha = environment({ id: 'e1', name: 'alpha', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const prod = environment({ id: 'e2', name: 'live', protected: true, productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] })
const QA: QaWorkflow = { repo: 'acme/qa', workflow: 'playwright.yml', ref: 'main' }

const compatible = (over: Partial<DeploymentMeta> & { id: string }) =>
  deploymentMeta({ composeFile: '', useSudo: 'yes', buildTimeoutSec: 3600, composeTimeoutSec: 900, ...over })

function world(opts: { deployments: DeploymentMeta[]; versioned?: boolean; qa?: QaWorkflow | null; envId?: string }) {
  const envId = opts.envId ?? 'e1'
  return mockBridge({
    'product:list': [product({ id: 'p1', name: 'Essentials', environmentIds: ['e1', 'e2'] })],
    'env:list': [alpha, prod],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'deploy:tooling': toolingOk(),
    'deploy:settings': envSettings({ environmentId: envId, versioned: opts.versioned ?? false }),
    'deploy:list': opts.deployments,
    'integration:get': { environmentId: envId, qa: opts.qa === undefined ? QA : opts.qa, qaOnDeploy: true, qaWait: true },
    'deploy:applyBatch': { settings: envSettings({ environmentId: envId, versioned: false }), deployments: opts.deployments },
  })
}

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

async function open(envId = 'e1') {
  await loadInventory()
  render(
    <MemoryRouter initialEntries={[`/deployments?env=${envId}`]}>
      <Routes>
        <Route path="/deployments" element={<DeploymentsPage />} />
        <Route path="/products" element={<Where />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Compared with unified_release\.sh/ }))
  return { user, panel: screen.getByRole('region', { name: 'Compared with unified_release.sh' }) }
}

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

describe('Compared with unified_release.sh', () => {
  beforeEach(() => {
    inventoryStore.set(null)
    resetDeploy()
    clearToasts()
  })

  it('shows each check with its level', async () => {
    world({ deployments: [deploymentMeta({ id: 'd1', name: 'backend' })], versioned: true })
    const { panel } = await open()
    const row = (title: string) => within(panel).getByRole('listitem', { name: title })
    await waitFor(() => expect(row('QA workflow')).toHaveAttribute('data-level', 'ok'))
    expect(row('Build and start time limits')).toHaveAttribute('data-level', 'risk')
    expect(row('Docker runs with sudo')).toHaveAttribute('data-level', 'differs')
    expect(row('Version tags')).toHaveAttribute('data-level', 'risk')
    expect(row('Failed builds')).toHaveAttribute('data-level', 'differs')
    expect(within(row('QA workflow')).getByText(/environment set to "alpha"/)).toBeInTheDocument()
    expect(panel.textContent).not.toMatch(/parity/i)
  })

  it('applies every change in one save after a confirm, and Undo restores the previous values', async () => {
    const d1 = deploymentMeta({ id: 'd1', name: 'backend' })
    const d2 = compatible({ id: 'd2', name: 'frontend', useSudo: 'auto' })
    const invoke = world({ deployments: [d1, d2], versioned: true })
    const { user, panel } = await open()
    await user.click(within(panel).getByRole('button', { name: 'Apply script-compatible settings' }))
    const dialog = await screen.findByRole('dialog')
    for (const line of [
      'Versioned releases: on → off',
      'backend: build limit 300 s → 3600 s',
      'backend: start limit 120 s → 900 s',
      'backend: sudo auto → yes',
      'backend: compose file docker-compose.yml → found by Compose',
      'frontend: sudo auto → yes',
    ]) {
      expect(dialog).toHaveTextContent(line)
    }
    expect(calls(invoke, 'deploy:applyBatch')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(calls(invoke, 'deploy:applyBatch')).toHaveLength(1))
    expect(calls(invoke, 'deploy:applyBatch')[0].slice(1)).toEqual([
      'e1',
      {
        settings: { versioned: false },
        deployments: [
          { id: 'd1', patch: { buildTimeoutSec: 3600, composeTimeoutSec: 900, useSudo: 'yes', composeFile: '' } },
          { id: 'd2', patch: { useSudo: 'yes' } },
        ],
      },
    ])
    // Nothing else saves on its own.
    expect(calls(invoke, 'deploy:update')).toHaveLength(0)
    expect(calls(invoke, 'deploy:updateSettings')).toHaveLength(0)

    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls(invoke, 'deploy:applyBatch')).toHaveLength(2))
    expect(calls(invoke, 'deploy:applyBatch')[1].slice(1)).toEqual([
      'e1',
      {
        settings: { versioned: true },
        deployments: [
          { id: 'd1', patch: { buildTimeoutSec: 300, composeTimeoutSec: 120, useSudo: 'auto', composeFile: 'docker-compose.yml' } },
          { id: 'd2', patch: { useSudo: 'auto' } },
        ],
      },
    ])
  })

  it('a protected environment keeps its versioned flag', async () => {
    const invoke = world({ envId: 'e2', deployments: [deploymentMeta({ id: 'd1', name: 'backend', environmentId: 'e2', useSudo: 'auto' })], versioned: true })
    const { user, panel } = await open('e2')
    expect(within(panel).getByRole('listitem', { name: 'Version tags' })).toHaveAttribute('data-level', 'risk')
    await user.click(within(panel).getByRole('button', { name: 'Apply script-compatible settings' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).not.toHaveTextContent('Versioned releases')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(calls(invoke, 'deploy:applyBatch')).toHaveLength(1))
    expect(calls(invoke, 'deploy:applyBatch')[0][2]).not.toHaveProperty('settings')
  })

  it('nothing to apply on a compatible environment', async () => {
    world({ deployments: [compatible({ id: 'd1', name: 'backend' })] })
    const { panel } = await open()
    expect(within(panel).getByRole('button', { name: 'Apply script-compatible settings' })).toBeDisabled()
  })

  it('a short QA wait points to the Notifications settings instead of a field here', async () => {
    world({ deployments: [compatible({ id: 'd1', name: 'backend' })], qa: { ...QA, waitMinutes: 30 } })
    const { user, panel } = await open()
    const row = within(panel).getByRole('listitem', { name: 'QA result wait' })
    await waitFor(() => expect(row).toHaveAttribute('data-level', 'differs'))
    expect(within(panel).getByRole('button', { name: 'Apply script-compatible settings' })).toBeDisabled()
    await user.click(within(row).getByRole('button', { name: 'Open notification settings' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/products?node=p%3Ap1%2Fe%3Ae1')
  })
})
