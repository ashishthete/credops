import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { RunbooksSection } from '../../src/renderer/src/pages/products/RunbooksSection'
import type { Runbook } from '../../src/shared/runbooks'
import { releaseDetail } from './fixtures/release-events'
import { appService, deploymentMeta, environment, host, mockBridge } from './helpers'

const flush = () => act(async () => {})
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

const STAMP = '2026-10-16T09:00:00.000Z'
const SHA = 'f'.repeat(64)

const TAIL: Runbook = {
  id: 'rb1',
  environmentId: 'e1',
  name: 'Tail the api',
  description: '',
  targetServiceIds: ['s1'],
  items: [{ type: 'builtin', builtin: 'logs', tail: 100 }],
  params: [{ name: 'count', label: 'Line count', type: 'text', pattern: 'number', choices: [] }],
  lock: false,
  notify: false,
  createdAt: STAMP,
  updatedAt: STAMP,
}

async function mount({ protectedEnv = false, runbooks = [] as Runbook[] } = {}) {
  const invoke = mockBridge({
    'env:list': [environment({ id: 'e1', name: 'staging', protected: protectedEnv, hosts: [{ hostId: 'h1', role: 'app' }] })],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'deploy:list': [deploymentMeta({ id: 'dep-r1', name: 'core', hostId: 'h1' })],
    'service:list': [appService({ id: 's1', name: 'api', deploymentId: 'dep-r1' }), appService({ id: 's2', name: 'worker', deploymentId: 'dep-r1', position: 1 })],
    'runbook:list': runbooks,
    'runbook:save': TAIL,
    'release:preflightOperation': { releaseId: 'rel-op' },
    'deploy:previewPlaybook': { playbook: '- hosts: all\n  tasks: []\n', sha256: SHA },
    'release:start': null,
    'release:get': releaseDetail({ id: 'rel-op', status: 'ready' }),
  })
  await act(async () => {
    await loadInventory()
    await loadDeploy(['e1'])
  })
  render(
    <MemoryRouter>
      <RunbooksSection environmentId="e1" />
    </MemoryRouter>,
  )
  await flush()
  return { invoke, user: userEvent.setup() }
}

afterEach(() => {
  cleanup()
  resetReleases()
  resetDeploy()
  inventoryStore.set(null)
})

describe('runbooks section', () => {
  it('creating from the Show logs template saves a read-only runbook with the lock off', async () => {
    const { invoke, user } = await mount()
    await user.click(screen.getByRole('button', { name: 'New from template' }))
    expect(calls(invoke, 'runbook:save')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Show logs' }))
    await flush()
    const [[, input]] = calls(invoke, 'runbook:save') as [[string, Record<string, unknown>]]
    expect(input).toMatchObject({ environmentId: 'e1', name: 'Show logs', lock: false, targetServiceIds: ['s1', 's2'] })
    expect(input.items).toEqual([{ type: 'builtin', builtin: 'logs', tail: expect.any(Number) }])
  })

  it('refuses a number param that is not a number', async () => {
    const { invoke, user } = await mount({ runbooks: [TAIL] })
    await user.click(screen.getByRole('button', { name: 'Run Tail the api' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run Tail the api' })
    await user.type(within(dialog).getByLabelText('Line count'), '1;rm')
    await user.click(within(dialog).getByRole('button', { name: 'Review' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/count/)
    expect(calls(invoke, 'release:preflightOperation')).toHaveLength(0)
  })

  it('runs preflightOperation, then the preview, then start with the reviewed sha', async () => {
    const { invoke, user } = await mount({ runbooks: [TAIL] })
    await user.click(screen.getByRole('button', { name: 'Run Tail the api' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run Tail the api' })
    await user.type(within(dialog).getByLabelText('Line count'), '50')
    await user.click(within(dialog).getByRole('button', { name: 'Review' }))
    await flush()
    await user.click(await within(dialog).findByRole('button', { name: 'Run' }))
    await flush()
    const order = (invoke.mock.calls as unknown[][]).map((c) => c[0]).filter((c) => ['release:preflightOperation', 'deploy:previewPlaybook', 'release:start'].includes(c as string))
    expect(order).toEqual(['release:preflightOperation', 'deploy:previewPlaybook', 'release:start'])
    expect(calls(invoke, 'release:preflightOperation')[0][1]).toEqual({ environmentId: 'e1', runbookId: 'rb1', serviceIds: ['s1'], params: { count: '50' } })
    expect(calls(invoke, 'release:start')[0].slice(1)).toEqual(['rel-op', { playbookSha256: SHA }])
  })

  it('a protected environment needs the typed name to start', async () => {
    const { invoke, user } = await mount({ protectedEnv: true, runbooks: [{ ...TAIL, params: [] }] })
    await user.click(screen.getByRole('button', { name: 'Run Tail the api' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run Tail the api' })
    await user.click(within(dialog).getByRole('button', { name: 'Review' }))
    await flush()
    await user.click(await within(dialog).findByRole('button', { name: 'Run' }))
    const confirm = await screen.findByRole('dialog', { name: 'Run Tail the api in staging?' })
    expect(calls(invoke, 'release:start')).toHaveLength(0)
    await user.type(within(confirm).getByLabelText('Type staging to confirm'), 'staging')
    await user.click(within(confirm).getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(calls(invoke, 'release:start')).toHaveLength(1))
    expect(calls(invoke, 'release:start')[0].slice(1)).toEqual(['rel-op', { typedName: 'staging', playbookSha256: SHA }])
  })
})
