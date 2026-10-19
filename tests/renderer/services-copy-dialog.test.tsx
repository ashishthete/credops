import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDeploy, resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { CopyServicesDialog } from '../../src/renderer/src/pages/products/services/CopyServicesDialog'
import type { CopyServicesResult, ServiceMeta } from '../../src/shared/services'
import { appService, dbService, deploymentMeta, environment, host, mockBridge } from './helpers'

const staging = environment({ id: 'e1', name: 'staging', hosts: [{ hostId: 'h1', role: 'app' }] })
const prod = environment({ id: 'e2', name: 'prod', hosts: [{ hostId: 'h3', role: 'app' }, { hostId: 'h4', role: 'bastion' }] })
const dev = environment({ id: 'e3', name: 'dev', hosts: [] })

const CHECKOUTS = [
  deploymentMeta({ id: 'd1', name: 'core', environmentId: 'e1', hostId: 'h1', position: 0, defaultBranch: 'main', repoPath: '/srv/core', deployTag: 'deployed-staging' }),
  deploymentMeta({ id: 'd2', name: 'web', environmentId: 'e1', hostId: 'h1', position: 1, defaultBranch: 'release', repoPath: '/srv/web', deployTag: 'web-live' }),
]
const SERVICES: ServiceMeta[] = [
  appService({ id: 's1', name: 'api', environmentId: 'e1', deploymentId: 'd1' }),
  appService({ id: 's2', name: 'site', environmentId: 'e1', deploymentId: 'd2' }),
  dbService({ id: 'b1', name: 'main-db', environmentId: 'e1', dbAddress: '10.0.0.5', dbPort: 5432, viaHostId: 'h1' }),
]
const HOSTS = [host({ id: 'h1', label: 'stg1' }), host({ id: 'h3', label: 'prod1' }), host({ id: 'h4', label: 'jump1' }), host({ id: 'h5', label: 'spare1' })]

const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) => (invoke.mock.calls as unknown[][]).filter((x) => x[0] === channel)

async function mount(result: CopyServicesResult = { created: { services: 3, checkouts: 2 }, skipped: [], addedHosts: 0 }) {
  const invoke = mockBridge({ 'env:list': [staging, prod, dev], 'host:list': HOSTS, 'deploy:list': CHECKOUTS, 'service:list': SERVICES, 'service:copy': result })
  await act(async () => {
    await loadInventory()
    await loadDeploy()
  })
  const user = userEvent.setup()
  render(<CopyServicesDialog source={staging} onClose={() => {}} />)
  const dialog = await screen.findByRole('dialog', { name: 'Copy services from staging' })
  return { invoke, user, dialog }
}

const pickProd = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
  user.selectOptions(within(dialog).getByLabelText('Target environment'), 'prod')

afterEach(() => {
  cleanup()
  resetDeploy()
  inventoryStore.set(null)
})

describe('copy services dialog', () => {
  it('rows per checkout and db, prefilled; tag shown only when it can\'t be derived', async () => {
    const { user, dialog } = await mount()
    const targets = [...(within(dialog).getByLabelText('Target environment') as HTMLSelectElement).options].map((o) => o.textContent)
    expect(targets).not.toContain('staging')
    expect(targets).toEqual(expect.arrayContaining(['prod', 'dev']))
    expect(within(dialog).queryByRole('group', { name: 'core' })).not.toBeInTheDocument()

    await pickProd(user, dialog)
    const core = within(dialog).getByRole('group', { name: 'core' })
    expect(within(core).getByLabelText('Branch')).toHaveValue('main')
    expect(within(core).getByLabelText('Path')).toHaveValue('/srv/core')
    expect(within(core).getByLabelText('Host')).toHaveValue('h3')
    expect(within(core).queryByLabelText('Tag')).not.toBeInTheDocument()
    expect(within(core).getByText('deployed-prod')).toBeInTheDocument()

    const web = within(dialog).getByRole('group', { name: 'web' })
    expect(within(web).getByLabelText('Branch')).toHaveValue('release')
    expect(within(web).getByLabelText('Tag')).toHaveValue('')

    const db = within(dialog).getByRole('group', { name: 'main-db' })
    expect(within(db).getByLabelText('Address')).toHaveValue('10.0.0.5')
    expect(within(db).getByLabelText('Port')).toHaveValue('5432')
    expect(within(db).getByLabelText('Via host')).toHaveDisplayValue('App host (prod1)')

    expect(
      within(dialog).getByText('Vault links, secrets, URLs and tunnels are not copied. Managed .env templates are copied with secret values cleared and turned off.'),
    ).toBeInTheDocument()
    // The underived tag is required.
    expect(within(dialog).getByRole('button', { name: 'Copy services' })).toBeDisabled()
  })

  it('submit sends exactly the request shape', async () => {
    const { invoke, user, dialog } = await mount()
    await pickProd(user, dialog)
    const web = within(dialog).getByRole('group', { name: 'web' })
    await user.type(within(web).getByLabelText('Tag'), 'web-prod')
    await user.selectOptions(within(web).getByLabelText('Host'), 'spare1')
    const db = within(dialog).getByRole('group', { name: 'main-db' })
    await user.clear(within(db).getByLabelText('Address'))
    await user.type(within(db).getByLabelText('Address'), '10.1.0.5')
    await user.click(within(dialog).getByRole('button', { name: 'Copy services' }))
    await waitFor(() => expect(calls(invoke, 'service:copy')).toHaveLength(1))
    expect(calls(invoke, 'service:copy')[0][1]).toEqual({
      sourceEnvironmentId: 'e1',
      targetEnvironmentId: 'e2',
      checkouts: [
        { deploymentId: 'd1', branch: 'main', repoPath: '/srv/core', hostId: 'h3', deployTag: 'deployed-prod' },
        { deploymentId: 'd2', branch: 'release', repoPath: '/srv/web', hostId: 'h5', deployTag: 'web-prod' },
      ],
      dbs: [{ serviceId: 'b1', dbAddress: '10.1.0.5', dbPort: 5432, viaHostId: null }],
    })
  })

  it('result lists copied counts, skipped rows and added hosts', async () => {
    const { user, dialog } = await mount({
      created: { services: 2, checkouts: 2 },
      skipped: [{ kind: 'service', name: 'api', reason: 'prod already has a service named api' }],
      addedHosts: 2,
    })
    await pickProd(user, dialog)
    await user.type(within(within(dialog).getByRole('group', { name: 'web' })).getByLabelText('Tag'), 'web-prod')
    await user.click(within(dialog).getByRole('button', { name: 'Copy services' }))
    expect(await within(dialog).findByText('Copied 2 services and 2 checkouts to prod')).toBeInTheDocument()
    const skipped = within(dialog).getByRole('list', { name: 'Skipped' })
    expect(within(skipped).getByRole('listitem')).toHaveTextContent('api (service): prod already has a service named api')
    expect(within(dialog).getByText('Added 2 hosts to prod as app hosts')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('no added hosts, no added line', async () => {
    const { user, dialog } = await mount()
    await pickProd(user, dialog)
    await user.type(within(within(dialog).getByRole('group', { name: 'web' })).getByLabelText('Tag'), 'web-prod')
    await user.click(within(dialog).getByRole('button', { name: 'Copy services' }))
    expect(await within(dialog).findByText('Copied 3 services and 2 checkouts to prod')).toBeInTheDocument()
    expect(within(dialog).queryByText(/as app hosts/)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('list', { name: 'Skipped' })).not.toBeInTheDocument()
  })
})
