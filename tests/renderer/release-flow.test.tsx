import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { EnvDeploySettings } from '../../src/renderer/src/pages/deployments/EnvDeploySettings'
import { PlaybookReview } from '../../src/renderer/src/pages/deployments/release/PlaybookReview'
import { ReleaseFlowSection, flowPreview } from '../../src/renderer/src/pages/products/services/ReleaseFlowSection'
import type { ReleaseFlow } from '../../src/shared/deploy'
import type { StepBody } from '../../src/shared/steps'
import { appService, envSettings, mockBridge } from './helpers'

const SERVICES = [
  appService({ id: 'sb', name: 'backend', deploymentId: 'd1' }),
  appService({ id: 'sf', name: 'frontend', deploymentId: 'd2', position: 1 }),
  appService({ id: 'sa', name: 'fastapi', deploymentId: 'd3', position: 2 }),
]
const NAMES = { sb: 'backend', sf: 'frontend', sa: 'fastapi' }

const migrate: StepBody = {
  id: 'migrate',
  name: 'migrate',
  run: 'shell',
  service: null,
  script: 'make migrate',
  cwd: null,
  sudo: 'docker',
  timeoutSec: 600,
  onFailure: 'stop',
  when: { kind: 'always' },
  secrets: [],
}

const FLOW: ReleaseFlow = {
  onFailure: 'stop-all',
  stages: [
    { kind: 'services', serviceIds: ['sb'] },
    { kind: 'step', serviceId: 'sb', step: migrate },
    { kind: 'services', serviceIds: ['sf', 'sa'] },
  ],
}

afterEach(() => {
  cleanup()
  resetDeploy()
})

function section(flow: ReleaseFlow | null) {
  const invoke = mockBridge({ 'secret:list': [{ id: 'k1', name: 'DB_URL', vaultId: 'v1' }] })
  const onSave = vi.fn(async () => true)
  render(<ReleaseFlowSection services={SERVICES} flow={flow} onSave={onSave} />)
  return { onSave, invoke }
}

describe('flowPreview', () => {
  it('reads stages left to right: parallel services joined by ∥, a step stage by its step name', () => {
    expect(flowPreview(FLOW, NAMES)).toBe('backend → migrate → frontend ∥ fastapi')
  })

  it('names a service it does not know as unknown rather than by its id', () => {
    expect(flowPreview({ onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: ['gone'] }] }, NAMES)).toBe('unknown service')
  })
})

describe('the release flow section', () => {
  it('shows the saved flow as its one-line preview and its failure policy', () => {
    section(FLOW)
    const region = screen.getByRole('region', { name: 'Release flow' })
    expect(within(region).getByTestId('flow-preview')).toHaveTextContent('backend → migrate → frontend ∥ fastapi')
    expect(within(region).getByText(/stop every host/i)).toBeInTheDocument()
  })

  it('without a flow, setting one up starts from every service in one stage and saves it', async () => {
    const user = userEvent.setup()
    const { onSave } = section(null)
    expect(screen.getByText(/each host releases in turn/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Set up flow' }))
    await user.click(screen.getByRole('button', { name: 'Save flow' }))
    expect(onSave).toHaveBeenCalledWith({ onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: ['sb', 'sf', 'sa'] }] })
  })

  it('editing a stage, moving it, changing the failure policy and saving sends the whole flow', async () => {
    const user = userEvent.setup()
    const { onSave } = section(FLOW)
    await user.click(screen.getByRole('button', { name: 'Edit flow' }))
    const third = screen.getByRole('group', { name: 'Stage 3' })
    await user.click(within(third).getByRole('button', { name: 'Remove fastapi from stage 3' }))
    await user.click(within(third).getByRole('button', { name: 'Move stage 3 up' }))
    await user.selectOptions(screen.getByLabelText('If a stage fails'), 'continue-other-hosts')
    // the draft's preview follows the edit
    expect(screen.getByTestId('flow-preview')).toHaveTextContent('backend → frontend → migrate')
    await user.click(screen.getByRole('button', { name: 'Save flow' }))
    expect(onSave).toHaveBeenCalledWith({
      onFailure: 'continue-other-hosts',
      stages: [
        { kind: 'services', serviceIds: ['sb'] },
        { kind: 'services', serviceIds: ['sf'] },
        { kind: 'step', serviceId: 'sb', step: migrate },
      ],
    })
  })

  it('adds a service to a stage and a step stage; a step without a script cannot be saved until it has one', async () => {
    const user = userEvent.setup()
    const { onSave } = section(FLOW)
    await user.click(screen.getByRole('button', { name: 'Edit flow' }))
    await user.selectOptions(screen.getByLabelText('Add a service to stage 1'), 'sa')
    await user.click(screen.getByRole('button', { name: 'Add step stage' }))
    const fourth = screen.getByRole('group', { name: 'Stage 4' })
    expect(within(fourth).getByLabelText('Runs in the checkout of')).toHaveValue('sb')
    expect(screen.getByRole('button', { name: 'Save flow' })).toBeDisabled()
    await user.type(within(fourth).getByLabelText('Script'), 'echo done')
    await user.click(screen.getByRole('button', { name: 'Save flow' }))
    const saved = (onSave.mock.calls[0] as unknown as [ReleaseFlow])[0]
    expect(saved.stages[0]).toEqual({ kind: 'services', serviceIds: ['sb', 'sa'] })
    expect(saved.stages[3]).toMatchObject({ kind: 'step', serviceId: 'sb', step: { script: 'echo done', run: 'shell' } })
    // a new step's id never clashes with the flow's other steps
    expect((saved.stages[3] as { step: StepBody }).step.id).not.toBe('migrate')
    // a body only: no anchor or rollback flag on a flow step
    expect(Object.keys((saved.stages[3] as { step: StepBody }).step)).not.toContain('anchor')
  })

  it('an emptied services stage blocks saving and says why', async () => {
    const user = userEvent.setup()
    section(FLOW)
    await user.click(screen.getByRole('button', { name: 'Edit flow' }))
    await user.click(screen.getByRole('button', { name: 'Remove backend from stage 1' }))
    expect(screen.getByText('Stage 1 has no services')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save flow' })).toBeDisabled()
  })

  it('removing the flow saves null; cancel drops the draft', async () => {
    const user = userEvent.setup()
    const { onSave } = section(FLOW)
    await user.click(screen.getByRole('button', { name: 'Edit flow' }))
    await user.click(screen.getByRole('button', { name: 'Remove stage 2' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('flow-preview')).toHaveTextContent('backend → migrate → frontend ∥ fastapi')
    await user.click(screen.getByRole('button', { name: 'Remove flow' }))
    // asked inline first: nothing is saved until the removal is confirmed
    const ask = screen.getByRole('group', { name: 'Remove the release flow?' })
    expect(ask).toHaveTextContent(/step stages/i)
    await user.click(within(ask).getByRole('button', { name: 'Keep flow' }))
    expect(screen.queryByRole('group', { name: 'Remove the release flow?' })).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove flow' }))
    await user.click(within(screen.getByRole('group', { name: 'Remove the release flow?' })).getByRole('button', { name: 'Remove' }))
    expect(onSave).toHaveBeenCalledWith(null)
  })
})

describe('parallel prepare', () => {
  it('toggles parallel prepare and sets its cap of 1 to 8; the cap is off while parallel prepare is', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'deploy:updateSettings': envSettings({ parallelPrepare: false }) })
    const { rerender } = render(<EnvDeploySettings settings={envSettings({ parallelPrepare: true, prepareCap: 3 })} />)
    const cap = screen.getByLabelText('Hosts at once')
    expect(cap).toHaveValue('3')
    expect([...(cap as HTMLSelectElement).options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    await user.selectOptions(cap, '5')
    await user.click(screen.getByRole('switch', { name: 'Parallel prepare' }))
    const sent = () => invoke.mock.calls.filter((c) => c[0] === 'deploy:updateSettings').map((c) => c.slice(1))
    await waitFor(() => expect(sent()).toHaveLength(2))
    expect(sent()).toEqual([
      ['e1', { prepareCap: 5 }],
      ['e1', { parallelPrepare: false }],
    ])
    rerender(<EnvDeploySettings settings={envSettings({ parallelPrepare: false, prepareCap: 3 })} />)
    expect(screen.getByLabelText('Hosts at once')).toBeDisabled()
  })
})

describe('a flow playbook under review', () => {
  it('heads its plays as prepare, the stages counted from 1, and tag', () => {
    const play = (name: string) => ({ name, hosts: 'od-1', tasks: [{ name: `flow gate 0`, tags: [] }] })
    const playbook = JSON.stringify([play('release prepare'), play('release stage 0'), play('release stage 1'), play('release tag')])
    render(<PlaybookReview playbook={playbook} autoRollback={false} onSave={() => {}} />)
    const steps = screen.getByRole('list', { name: 'Playbook steps' })
    for (const heading of ['Prepare', 'Stage 1', 'Stage 2', 'Tag']) expect(within(steps).getByText(heading)).toBeInTheDocument()
    expect(screen.queryByLabelText('Inventory (hashed with the playbook)')).toBeNull()
  })
})
