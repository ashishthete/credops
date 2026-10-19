import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { DeploymentsPage } from '../../src/renderer/src/pages/deployments/DeploymentsPage'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { defaultVault, deploymentMeta, envSettings, environment, host, emitBridgeEvent, mockBridge, product, toolingOk } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through its hook directly.
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => reduced.on,
}))

const SECRET_ID = '0190a5c2-7d3e-7000-8000-000000000001'
const MISSING = `Ansible isn't installed. Install it with "brew install ansible" (or "pipx install ansible-core"), then try again.`

const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }, { hostId: 'h2', role: 'app' }] })
const prod = environment({ id: 'e2', name: 'prod', protected: true, hosts: [{ hostId: 'h1', role: 'app' }] })

const world = (extra: Record<string, unknown> = {}) =>
  mockBridge({
    'product:list': [product({ id: 'p1', name: 'Shop', environmentIds: ['e1', 'e2'] })],
    'env:list': [staging, prod],
    'host:list': [host({ id: 'h1', label: 'app1' }), host({ id: 'h2', label: 'app2' })],
    'vault:list': [defaultVault],
    'deploy:tooling': toolingOk(),
    'deploy:settings': envSettings(),
    ...extra,
  })

async function open(path = '/deployments?env=e1') {
  await loadInventory()
  render(
    <MemoryRouter initialEntries={[path]}>
      <DeploymentsPage />
      <Toaster />
    </MemoryRouter>,
  )
}

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)

describe('deployments page', () => {
  beforeEach(() => {
    reduced.on = false
    inventoryStore.set(null)
    resetDeploy()
    clearToasts()
  })

  it('lists deployments grouped by host for the env in the URL', async () => {
    world({
      'deploy:list': [
        deploymentMeta({ id: 'd1', name: 'api', hostId: 'h1', position: 1, dbBackup: true, urls: [{ url: 'https://a.example.com', from: 'host' }] }),
        deploymentMeta({ id: 'd2', name: 'web', hostId: 'h2', position: 0 }),
        deploymentMeta({ id: 'd3', name: 'worker', hostId: 'h1', position: 0 }),
        deploymentMeta({ id: 'd4', name: 'prod-api', environmentId: 'e2', hostId: 'h1' }),
      ],
    })
    await open()
    const app1 = await screen.findByRole('region', { name: 'app1' })
    const app2 = screen.getByRole('region', { name: 'app2' })
    // Run order within a host follows `position`.
    expect(within(app1).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['worker', 'api'])
    expect(within(app2).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['web'])
    expect(screen.queryByText('prod-api')).not.toBeInTheDocument()
    expect(within(app1).getByText('Backup')).toBeInTheDocument()
    expect(within(app1).getByText('1 URL')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'staging', pressed: true })).toBeInTheDocument()
    expect(screen.getByTestId('current-version')).toHaveTextContent('v1.2.0')
  })

  it('shows the empty state for an environment with no deployments', async () => {
    const user = userEvent.setup()
    world()
    await open()
    expect(await screen.findByText('No deployments in staging yet')).toBeInTheDocument()
    // The header's button and the empty state's action both open it.
    await user.click(screen.getAllByRole('button', { name: 'New deployment' })[1])
    expect(await screen.findByRole('dialog', { name: 'New checkout' })).toBeInTheDocument()
  })

  it('create dialog validates repo path and branch inline and submits', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:create': deploymentMeta({ id: 'new', name: 'api' }),
    })
    await open()
    await screen.findByText('No deployments in staging yet')
    await user.click(screen.getAllByRole('button', { name: 'New deployment' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'New checkout' })
    const create = within(dialog).getByRole('button', { name: 'Create deployment' })
    expect(create).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Name'), 'api')
    await user.selectOptions(within(dialog).getByLabelText('Host'), 'h1')
    await user.type(within(dialog).getByLabelText('Repo path'), 'srv/app')
    expect(within(dialog).getByText(/Use an absolute path/)).toBeInTheDocument()
    // The message names the rule, never the value typed.
    expect(within(dialog).queryByText(/srv\/app/)).not.toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Repo path'))
    await user.type(within(dialog).getByLabelText('Repo path'), '/srv/app')
    await waitFor(() => expect(within(dialog).queryByText(/Use an absolute path/)).not.toBeInTheDocument())

    await user.clear(within(dialog).getByLabelText('Branch'))
    await user.type(within(dialog).getByLabelText('Branch'), 'bad..ref')
    expect(within(dialog).getByText(/A branch name uses/)).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Branch'))
    await user.type(within(dialog).getByLabelText('Branch'), 'main')
    await user.type(within(dialog).getByLabelText('Deploy tag'), 'deployed-staging')

    expect(create).toBeEnabled()
    await user.click(create)
    await waitFor(() => expect(calls(invoke, 'deploy:create')).toHaveLength(1))
    expect(calls(invoke, 'deploy:create')[0][1]).toMatchObject({
      name: 'api',
      environmentId: 'e1',
      hostId: 'h1',
      repoPath: '/srv/app',
      defaultBranch: 'main',
      deployTag: 'deployed-staging',
      composeFile: 'docker-compose.yml',
      repoUrl: null,
      composeProject: null,
      envTemplate: null,
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New checkout' })).not.toBeInTheDocument())
  })

  it('env template shows secret chips by name and blocks a plain DB_PASSWORD', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:list': [
        deploymentMeta({
          id: 'd1',
          name: 'api',
          managedEnv: true,
          envTemplate: `APP_ENV=production\nSTRIPE=\${secret:${SECRET_ID}}\n`,
          vaultIds: [DEFAULT_VAULT_ID],
        }),
      ],
      'secret:list': [{ id: SECRET_ID, vaultId: DEFAULT_VAULT_ID, name: 'Stripe key', kind: 'password', createdAt: '', updatedAt: '' }],
    })
    await open()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit checkout' })
    const chips = await within(dialog).findAllByTestId('secret-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Stripe key'])
    // The reference id is not shown, and no secret value was ever requested.
    expect(within(dialog).getByRole('list', { name: 'Secret references' })).not.toHaveTextContent(SECRET_ID)
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('secret:get')
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('secret:reveal')

    const area = within(dialog).getByLabelText('Environment file')
    fireEvent.change(area, { target: { value: `APP_ENV=production\nDB_PASSWORD=hunter2\n` } })
    const problem = await within(dialog).findByText(/DB_PASSWORD looks sensitive/)
    // The message names the key, never the value typed.
    expect(problem.textContent).not.toContain('hunter2')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('reorder with alt+arrow calls deploy:reorder', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:list': [
        deploymentMeta({ id: 'd1', name: 'api', position: 0 }),
        deploymentMeta({ id: 'd2', name: 'worker', position: 1 }),
      ],
    })
    await open()
    const grip = await screen.findByRole('button', { name: 'Reorder api' })
    grip.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(calls(invoke, 'deploy:reorder')).toHaveLength(1))
    expect(calls(invoke, 'deploy:reorder')[0].slice(1)).toEqual(['e1', ['d2', 'd1']])
    // The list already shows the new order, and the grip kept focus.
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['worker', 'api'])
    expect(screen.getByRole('button', { name: 'Reorder api' })).toHaveFocus()
  })

  it('a refused reorder puts the old order back', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', position: 0 }), deploymentMeta({ id: 'd2', name: 'worker', position: 1 })],
    })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'deploy:reorder') throw new Error('Not allowed')
      return (base as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
    })
    await open()
    const grip = await screen.findByRole('button', { name: 'Reorder api' })
    grip.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['api', 'worker']))
  })

  it('missing ansible shows the install banner with the exact text', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    world({ 'deploy:tooling': toolingOk({ ansiblePlaybook: null, ansibleStatus: 'missing', problems: [MISSING] }) })
    await open()
    const banner = await screen.findByRole('alert')
    expect(within(banner).getByText(MISSING)).toBeInTheDocument()
    expect(within(banner).getByRole('link', { name: /Docs/ })).toHaveAttribute('href', expect.stringContaining('ansible'))
    await user.click(within(banner).getByRole('button', { name: /Copy/ }))
    expect(writeText).toHaveBeenCalledWith('brew install ansible')
  })

  it('shows no banner when ansible is fine', async () => {
    world({ 'deploy:list': [deploymentMeta({ id: 'd1', name: 'api' })] })
    await open()
    await screen.findByRole('region', { name: 'app1' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('protected delete needs the typed env name', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:list': [deploymentMeta({ id: 'd4', name: 'prod-api', environmentId: 'e2', hostId: 'h1' })],
      'deploy:delete': null,
    })
    await open('/deployments?env=e2')
    await user.click(await screen.findByRole('button', { name: 'prod-api options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete prod-api?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete deployment' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'pro')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type prod to confirm'), 'd')
    await user.click(confirm)
    await waitFor(() => expect(calls(invoke, 'deploy:delete')).toEqual([['deploy:delete', 'd4']]))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'prod-api' })).not.toBeInTheDocument())
  })

  it('an unprotected delete only asks once', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'deploy:list': [deploymentMeta({ id: 'd1', name: 'api' })], 'deploy:delete': null })
    await open()
    await user.click(await screen.findByRole('button', { name: 'api options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete api?' })
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete deployment' }))
    await waitFor(() => expect(calls(invoke, 'deploy:delete')).toHaveLength(1))
  })

  it('picking an environment updates the URL selection and the list', async () => {
    const user = userEvent.setup()
    world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api' }), deploymentMeta({ id: 'd4', name: 'prod-api', environmentId: 'e2' })],
    })
    await open()
    await screen.findByRole('listitem', { name: 'api' })
    await user.click(screen.getByRole('button', { name: 'prod' }))
    expect(await screen.findByRole('listitem', { name: 'prod-api' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: 'api' })).not.toBeInTheDocument()
  })

  it('checkout dialog has Repository URL and Compose project and no app picker', async () => {
    const user = userEvent.setup()
    const invoke = world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', repoUrl: 'git@github.com:acme/api.git', composeProject: 'api_stg' })],
      'deploy:update': deploymentMeta({ id: 'd1', name: 'api' }),
    })
    await open()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit checkout' })
    expect(within(dialog).queryByLabelText('App')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /app/i })).not.toBeInTheDocument()
    const repo = within(dialog).getByLabelText('Repository URL')
    const project = within(dialog).getByLabelText('Compose project')
    expect(repo).toHaveValue('git@github.com:acme/api.git')
    expect(project).toHaveValue('api_stg')
    await user.clear(repo)
    await user.type(repo, 'ftp://x')
    expect(within(dialog).getByText(/Use an http\(s\), ssh:\/\/ or git@ URL/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(repo)
    await user.type(repo, 'https://github.com/acme/api')
    await user.clear(project)
    await user.type(project, '--rm')
    expect(within(dialog).getByText(/A compose project uses/)).toBeInTheDocument()
    await user.clear(project)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'deploy:update')).toHaveLength(1))
    expect(calls(invoke, 'deploy:update')[0][2]).toEqual({ repoUrl: 'https://github.com/acme/api', composeProject: null })
  })

  it('saves a corrected current version', async () => {
    const user = userEvent.setup()
    const invoke = world({ 'deploy:updateSettings': envSettings({ currentVersion: 'v1.3.0' }) })
    await open()
    await user.click(await screen.findByRole('button', { name: 'Correct' }))
    const field = screen.getByLabelText('Current version')
    await user.clear(field)
    await user.type(field, '1.3')
    expect(screen.getByText('A version looks like v1.2.3')).toBeInTheDocument()
    await user.clear(field)
    await user.type(field, 'v1.3.0')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls(invoke, 'deploy:updateSettings')[0].slice(1)).toEqual(['e1', { currentVersion: 'v1.3.0' }]))
    expect(await screen.findByTestId('current-version')).toHaveTextContent('v1.3.0')
  })

  it('reduced motion: no transform on card reorder', async () => {
    reduced.on = true
    const user = userEvent.setup()
    world({
      'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', position: 0 }), deploymentMeta({ id: 'd2', name: 'worker', position: 1 })],
    })
    await open()
    const grip = await screen.findByRole('button', { name: 'Reorder api' })
    grip.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['worker', 'api']))
    for (const li of screen.getAllByRole('listitem')) {
      expect(li.getAttribute('style') ?? '').not.toMatch(/transform/)
    }
  })

  it('a burst of deploy:changed events shares one refetch', async () => {
    const invoke = world({ 'deploy:list': [deploymentMeta({ id: 'd1', name: 'api', position: 0 })] })
    await open()
    await screen.findByText('api')
    const before = calls(invoke, 'deploy:list').length
    act(() => {
      for (let i = 0; i < 5; i++) emitBridgeEvent('deploy:changed', { environmentId: 'e1' })
    })
    await waitFor(() => expect(calls(invoke, 'deploy:list').length).toBe(before + 1))
    await new Promise((r) => setTimeout(r, 250))
    expect(calls(invoke, 'deploy:list').length).toBe(before + 1)
  })
})
