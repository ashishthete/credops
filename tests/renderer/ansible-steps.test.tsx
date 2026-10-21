import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { initialPipeline, reducePipeline } from '../../src/renderer/src/deploy/pipeline'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { taskRows, type TaskRow } from '../../src/renderer/src/deploy/task-rows'
import { registerFailureAction, type FailureActionProps } from '../../src/renderer/src/pages/deployments/release/FailurePanel'
import { ReleaseView } from '../../src/renderer/src/pages/deployments/release/ReleaseView'
import type { ReleaseDetail, RunEvent, RunEventBody, TaskState } from '../../src/shared/deploy'
import { playbookSteps } from '../../src/shared/playbook-steps'
import { events, healthFailure, OK_RUN, playbookOf, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

const flush = () => act(async () => {})

const task = (stepId: string, name: string, state: TaskState, more: Partial<Extract<RunEventBody, { type: 'task.done' }>> = {}): RunEventBody => ({
  type: 'task.done',
  stepId,
  task: name,
  hostId: stepId.startsWith('r3') || stepId.includes('h2') ? 'h2' : 'h1',
  state,
  rc: state === 'failed' ? 1 : 0,
  attempts: null,
  durationMs: 800,
  ...more,
})

/** A token main redacted before storing; the raw value must never reach the view. */
const SECRET = 'hunter2-secret'

/**
 * r1 runs fine (its up changed something); r3's first health URL passes on the third attempt and the second
 * fails with rc 1, its output already redacted by main.
 */
function failingRun(): RunEventBody[] {
  const base = healthFailure(false)
  const at = base.findIndex((e) => e.type === 'step.failed')
  const kinds = ['record', 'fetch', 'checkout', 'build', 'up', 'health', 'tag'] as const
  const r1 = kinds.map((k) => task(`r1:${k}`, `${k} core`, k === 'up' ? 'changed' : 'ok'))
  return [
    ...base.slice(0, at),
    ...r1,
    task('host:h1:lock', 'lock od-1', 'ok'),
    task('host:h2:lock', 'lock od-2', 'ok'),
    ...['record', 'fetch', 'checkout', 'build', 'up'].map((k) => task(`r3:${k}`, `${k} site`, 'ok')),
    task('r3:health', 'health site 0', 'ok', { attempts: 3 }),
    { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'out', line: 'probe https://site.example/up?token=‹redacted›' },
    { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'err', line: 'GET /up 503' },
    task('r3:health', 'health site 1', 'failed'),
    ...base.slice(at),
  ]
}

const detailWithPlaybook = (over: Partial<ReleaseDetail> = {}) => {
  const d = releaseDetail(over)
  return { ...d, playbook: playbookOf(d, { r3: 2 }) }
}

function rowsOf(bodies: RunEventBody[], detail: ReleaseDetail = detailWithPlaybook()) {
  const s = reducePipeline(initialPipeline(detail), events(bodies))
  return taskRows(s, detail.playbook ? playbookSteps(detail.playbook) : [])
}

const brief = (rows: TaskRow[]) => rows.map((r) => `${r.label}|${r.name}|${r.state}`)

describe('taskRows', () => {
  it('gives one row per Ansible task in playbook order, per host and deployment, with each task state', () => {
    const { hosts, release } = rowsOf(failingRun())
    expect(hosts.map((h) => [h.hostLabel, h.runs.map((g) => g.title)])).toEqual([
      ['app1', ['core: api and worker', 'web: whole checkout']],
      ['app2', ['site: site']],
    ])
    const site = hosts[1].runs[0].rows
    expect(brief(site)).toEqual([
      'Record|record site|ok',
      'Fetch|fetch site|ok',
      'Checkout|checkout site|ok',
      'Build|build site|ok',
      'Up|up site|ok',
      'Health|health site 0|ok',
      'Health|health site 1|failed',
      'Tag|tag site|pending',
    ])
    expect(site[5]).toMatchObject({ attempts: 3, durationMs: 800 })
    expect(site[6]).toMatchObject({ rc: 1, error: 'health check failed on app2', failure: true })
    // the lock prep helper is part of the lock row; unlock is not in the release playbook but still shows
    expect(brief(hosts[1].before)).toEqual(['Lock|lock od-2|ok'])
    expect(brief(hosts[1].after)).toEqual(['Unlock||pending'])
    expect(brief(hosts[0].runs[0].rows).find((r) => r.startsWith('Up|'))).toBe('Up|up core|changed')
    expect(hosts[0].runs[1].rows.every((r) => r.state === 'pending')).toBe(true)
    expect(brief(release)).toEqual(['Version tag||pending'])
  })

  it('while a step runs, its next task without a result is running and the rest wait', () => {
    const all = failingRun()
    const { hosts } = rowsOf(all.slice(0, all.findIndex((e) => e.type === 'log')))
    expect(brief(hosts[1].runs[0].rows).slice(5)).toEqual(['Health|health site 0|ok', 'Health|health site 1|running', 'Tag|tag site|pending'])
    expect(hosts[1].runs[0].rows[6].startedAt).not.toBeNull()
  })

  it('a release from before task events still lists the playbook tasks, with their steps states', () => {
    const { hosts } = rowsOf(healthFailure(false))
    expect(brief(hosts[1].runs[0].rows).slice(4)).toEqual(['Up|up site|ok', 'Health|health site 0|failed', 'Health|health site 1|failed', 'Tag|tag site|pending'])
    // only the first failed row of a step carries the failure panel
    expect(hosts[1].runs[0].rows.filter((r) => r.failure).map((r) => r.name)).toEqual(['health site 0'])
    expect(hosts[1].runs[0].rows[3].durationMs).toBe(1000)
  })

  it('without a stored playbook the rows come from the steps', () => {
    const { hosts } = rowsOf(OK_RUN, releaseDetail())
    expect(brief(hosts[0].runs[0].rows)).toEqual(['Record||ok', 'Fetch||ok', 'Checkout||ok', 'Build||ok', 'Up||ok', 'Health||ok', 'Tag||ok'])
  })

  it('auto-rollback steps, which run from their own playbook, follow the deployment rows', () => {
    const { hosts } = rowsOf(healthFailure(true))
    expect(brief(hosts[0].runs[0].rows).slice(-3)).toEqual(['Tag|tag core|rolled_back', 'Rollback checkout||ok', 'Rollback up||ok'])
  })
})

/** `release:events` pages `stored` by afterSeq and limit, as main does. */
function world(stored: RunEvent[], detail: ReleaseDetail) {
  const invoke = mockBridge({ 'release:get': detail })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return stored.filter((e) => e.seq > after).slice(0, limit)
    }
    return base(channel)
  })
}

async function view(stored: RunEventBody[], detail: ReleaseDetail) {
  world(events(stored), detail)
  render(
    <MemoryRouter>
      <ReleaseView releaseId={REL} />
    </MemoryRouter>,
  )
  await flush()
  await flush()
}

const stepList = () => screen.getByRole('region', { name: 'Ansible steps' })
const rowText = () =>
  [...stepList().querySelectorAll<HTMLElement>('[data-task]')].map((r) => `${r.getAttribute('data-task')}|${r.getAttribute('data-state')}`)

afterEach(() => {
  cleanup()
  resetReleases()
})

describe('Ansible steps in the release view', () => {
  it('a failed task auto-expands with its redacted output, exit code, failure message and the AI help', async () => {
    const seen: FailureActionProps[] = []
    const off = registerFailureAction((p: FailureActionProps) => {
      seen.push(p)
      return <button type="button">Explain the failure</button>
    })
    try {
      await view(failingRun(), detailWithPlaybook({ status: 'failed' }))
      const row = stepList().querySelector<HTMLElement>('[data-task="health site 1"]')!
      expect(within(row).getByRole('button', { name: /health site 1/ })).toHaveAttribute('aria-expanded', 'true')
      const panel = within(row).getByRole('region', { name: 'Health on app2 failed' })
      expect(within(panel).getByText('Health on app2 failed: health check failed on app2')).toBeInTheDocument()
      expect(within(panel).getByText('exit code 1')).toBeInTheDocument()
      expect(within(panel).getByText('probe https://site.example/up?token=‹redacted›')).toBeInTheDocument()
      expect(within(panel).getByText('GET /up 503')).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Explain the failure' })).toBeInTheDocument()
      expect(seen.at(-1)).toMatchObject({ stepId: 'r3:health', error: 'health check failed on app2' })
      expect(document.body.textContent).not.toContain(SECRET)
      // the passing health task shows its attempts; it stays closed
      const first = stepList().querySelector<HTMLElement>('[data-task="health site 0"]')!
      expect(within(first).getByText('3 attempts')).toBeInTheDocument()
      expect(within(first).getByRole('button', { name: /health site 0/ })).toHaveAttribute('aria-expanded', 'false')
      // one failure panel, inside its row
      expect(screen.getAllByRole('region', { name: 'Health on app2 failed' })).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('clicking a row opens its output; Show in All logs filters the full log to that step', async () => {
    await view([...OK_RUN.slice(0, -1), task('r1:build', 'build core', 'changed'), OK_RUN.at(-1)!], detailWithPlaybook({ status: 'succeeded' }))
    const row = stepList().querySelector<HTMLElement>('[data-task="build core"]')!
    expect(row).toHaveAttribute('data-state', 'changed')
    const toggle = within(row).getByRole('button', { name: /build core/ })
    expect(within(row).queryByText('built')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(row).getByText('built')).toBeInTheDocument()
    expect(within(row).getByText('exit code 0')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Show in All logs' }))
    expect(screen.getByRole('button', { name: 'Clear the step filter' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Release log' })).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(within(row).queryByText('built')).toBeNull()
  })

  it('a stored release renders the same rows as the one watched live', async () => {
    const all = failingRun()
    await view(all.slice(0, 3), detailWithPlaybook({ status: 'running' }))
    act(() => emitBridgeEvent('deploy:event', events(all).slice(3)))
    await flush()
    const live = rowText()
    expect(live).toContain('health site 1|failed')
    cleanup()
    resetReleases()
    await view(all, detailWithPlaybook({ status: 'failed' }))
    expect(rowText()).toEqual(live)
  })
})
