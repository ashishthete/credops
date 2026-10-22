import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialPipeline, reducePipeline } from '../../src/renderer/src/deploy/pipeline'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { allRows, taskRows } from '../../src/renderer/src/deploy/task-rows'
import { ReleasePage } from '../../src/renderer/src/pages/deployments/ReleasePage'
import { PlaybookLogsPage } from '../../src/renderer/src/pages/deployments/PlaybookLogsPage'
import type { ReleaseDetail, RunEvent, RunEventBody, TaskState } from '../../src/shared/deploy'
import { playbookSteps } from '../../src/shared/playbook-steps'
import { events, flowDetail, flowPlaybookOf, healthFailure, OK_RUN, playbookOf, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

const flush = () => act(async () => {})

/**
 * A token the fixtures hold raw, as a Hub release's text reaches the desktop. The mocked `release:get`,
 * `release:events` and live push hand the pages only what main sends: the text with the secret masked (main's own
 * masking of these shapes is tested in tests/main/release-mask.test.ts). So it must never reach either page.
 */
const SECRET = 'hunter2-secret'
const masked = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(SECRET, '‹redacted›')) as T
/** A live batch as main pushes it. */
const live = (batch: RunEvent[]) => masked(batch)

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

/** r1 runs fine; r3's first health URL passes, its second fails, with the raw secret in its output. */
function failingRun(): RunEventBody[] {
  const base = healthFailure(false)
  const at = base.findIndex((e) => e.type === 'step.failed')
  const kinds = ['record', 'fetch', 'checkout', 'build', 'up', 'health', 'tag'] as const
  return [
    ...base.slice(0, at),
    ...kinds.map((k) => task(`r1:${k}`, `${k} core`, 'ok')),
    task('host:h1:lock', 'lock od-1', 'ok'),
    task('host:h2:lock', 'lock od-2', 'ok'),
    ...['record', 'fetch', 'checkout', 'build', 'up'].map((k) => task(`r3:${k}`, `${k} site`, 'ok')),
    { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'out', line: 'GET /ready 200', task: 'health site 0' },
    task('r3:health', 'health site 0', 'ok', { attempts: 3, durationMs: 61000 }),
    { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'out', line: `probe https://site.example/up?token=${SECRET}`, task: 'health site 1' },
    { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'err', line: 'GET /up 503', task: 'health site 1' },
    task('r3:health', 'health site 1', 'failed'),
    ...base.slice(at),
  ]
}

/** The stored playbook as main writes it (indented JSON), holding the raw secret. */
function detailWithPlaybook(over: Partial<ReleaseDetail> = {}): ReleaseDetail {
  const d = releaseDetail(over)
  const plays = JSON.parse(playbookOf(d, { r3: 2 })) as { vars?: Record<string, string> }[]
  plays[0].vars = { od_url: `https://site.example/up?token=${SECRET}` }
  return { ...d, playbook: JSON.stringify(plays, null, 2), triggeredBy: 'ana@mbp' }
}

function world(stored: RunEvent[], detail: ReleaseDetail) {
  const invoke = mockBridge({ 'release:get': masked(detail), 'release:savePlaybook': { path: '/tmp/x/release.yml' }, 'release:list': [] })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return masked(stored.filter((e) => e.seq > after).slice(0, limit))
    }
    return base(channel)
  })
  return invoke
}

async function open(path: string, stored: RunEventBody[], detail: ReleaseDetail) {
  const invoke = world(events(stored), detail)
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deployments/release/:id" element={<ReleasePage />} />
        <Route path="/deployments/release/:id/logs" element={<PlaybookLogsPage />} />
        <Route path="/deployments" element={<p>Deployments</p>} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
  await flush()
  await flush()
  return invoke
}

const rowsOf = (bodies: RunEventBody[], detail: ReleaseDetail) => {
  const s = reducePipeline(initialPipeline(detail), events(bodies))
  return allRows(taskRows(s, playbookSteps(detail.playbook!)))
}

afterEach(() => {
  cleanup()
  resetReleases()
})

describe('the release page', () => {
  it('heads the release with its environment, deployments, who started it and its status', async () => {
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    const header = screen.getByRole('banner', { name: 'Release summary' })
    expect(within(header).getByText('staging')).toBeInTheDocument()
    expect(within(header).getByText('core, web, site')).toBeInTheDocument()
    expect(within(header).getByText('Started by ana@mbp')).toBeInTheDocument()
    expect(within(header).getByText('failed')).toBeInTheDocument()
  })

  it("shows the release's regions in its header, emphasised when there is more than one", async () => {
    const eu = { id: 'r-eu', code: 'eu-west-1', displayName: 'EU West' }
    const us = { id: 'r-us', code: 'us-east-1', displayName: 'US East' }
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed', regions: [eu, us] }))
    const header = screen.getByRole('banner', { name: 'Release summary' })
    expect(within(header).getByText('eu-west-1')).toHaveAttribute('title', 'EU West')
    expect(within(header).getByText('us-east-1').className).toContain('warn')
  })

  it('a release without regions (a Hub one) shows no region chips', async () => {
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    expect(within(screen.getByRole('banner', { name: 'Release summary' })).queryByTitle(/./)).toBeNull()
  })

  it('the progress bar counts finished tasks out of all of them, and moves live', async () => {
    const all = failingRun()
    const at = all.findIndex((e) => e.type === 'task.done' && e.task === 'health site 1')
    const detail = detailWithPlaybook({ status: 'running' })
    await open(`/deployments/release/${REL}`, all.slice(0, at), detail)
    const rows = rowsOf(all.slice(0, at), detail)
    const done = rows.filter((r) => r.state !== 'pending' && r.state !== 'running').length
    const bar = screen.getByRole('progressbar', { name: 'Tasks done' })
    expect(bar).toHaveAttribute('aria-valuemax', String(rows.length))
    expect(bar).toHaveAttribute('aria-valuenow', String(done))
    expect(screen.getByText(`${done} of ${rows.length} tasks done`)).toBeInTheDocument()
    expect(done).toBeGreaterThan(0)
    act(() => emitBridgeEvent('deploy:event', live(events(all).slice(at, at + 1))))
    await flush()
    expect(bar).toHaveAttribute('aria-valuenow', String(done + 1))
  })

  it('highlights the task running now, and none once the release is over', async () => {
    const all = failingRun()
    const at = all.findIndex((e) => e.type === 'task.done' && e.task === 'health site 1')
    await open(`/deployments/release/${REL}`, all.slice(0, at), detailWithPlaybook({ status: 'running' }))
    const steps = screen.getByRole('region', { name: 'Ansible steps' })
    const current = steps.querySelectorAll('[aria-current="step"]')
    expect(current).toHaveLength(1)
    expect(current[0].closest('[data-task]')).toHaveAttribute('data-task', 'health site 1')
    expect(screen.getByText('Now: Health 2 on app2')).toBeInTheDocument()
    act(() => emitBridgeEvent('deploy:event', live(events(all).slice(at))))
    await flush()
    expect(steps.querySelectorAll('[aria-current="step"]')).toHaveLength(0)
  })

  it('while a cancel is under way, neither page names a task as running now', async () => {
    const all = failingRun()
    const at = all.findIndex((e) => e.type === 'task.done' && e.task === 'health site 1')
    await open(`/deployments/release/${REL}`, all.slice(0, at), detailWithPlaybook({ status: 'running' }))
    expect(screen.getByText('Now: Health 2 on app2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel release' }))
    await flush()
    expect(screen.queryByText(/^Now:/)).toBeNull()
    expect(screen.getByText('Cancelling')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Playbook & logs' }))
    await flush()
    await flush()
    const steps = screen.getByRole('navigation', { name: 'Steps' })
    expect(within(steps).getByRole('button', { name: /^Health 2 on app2: cancelling/ })).not.toHaveAttribute('aria-current')
  })

  it('keeps the full log off the page; a failed task still opens with its own output', async () => {
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    expect(screen.queryByRole('log', { name: 'Release log' })).toBeNull()
    const panel = screen.getByRole('region', { name: 'Health 2 on app2 failed' })
    expect(within(panel).getByText('GET /up 503')).toBeInTheDocument()
    expect(within(panel).getByText('probe https://site.example/up?token=‹redacted›')).toBeInTheDocument()
    expect(JSON.stringify(failingRun())).toContain(SECRET)
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('Show in All logs opens Playbook & logs on the full log, filtered to that step', async () => {
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    const panel = screen.getByRole('region', { name: 'Health 2 on app2 failed' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Show in All logs' }))
    await flush()
    await flush()
    expect(screen.getByRole('heading', { name: 'Playbook & logs' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Release log' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear the step filter' })).toBeInTheDocument()
  })
})

describe('a release flow on the release page', () => {
  it('a custom step chip shows its own label and the warning with its message; a skipped run says it had no changes', async () => {
    const d = flowDetail({ status: 'running' })
    const detail = { ...d, playbook: flowPlaybookOf(d, [{ r1: ['up', 'c_21'], r3: ['up', 'health'] }, { r1: ['health'] }]) }
    await open(`/deployments/release/${REL}`, [
      { type: 'run.started', kind: 'release', version: 'v1.5.0' },
      { type: 'step.started', stepId: 'r1:c_21', kind: 'custom', name: 'migrate', hostId: 'h1', deploymentRunId: 'r1' },
      { type: 'step.done', stepId: 'r1:c_21', state: 'warn', durationMs: 10, message: 'migration took long' },
      { type: 'deployment.updated', deploymentRunId: 'r2', status: 'skipped' },
    ], detail)
    const pipeline = screen.getByRole('group', { name: 'Pipeline' })
    const chip = within(pipeline).getByRole('button', { name: 'migrate on app1: warning' })
    expect(chip).toHaveAttribute('data-state', 'warn')
    expect(chip.getAttribute('title')).toContain('migration took long')
    const r2 = pipeline.querySelector('[data-run="r2"]') as HTMLElement
    expect(within(r2).getByText('skipped: no changes')).toBeInTheDocument()
    expect(pipeline.querySelector('[data-run="r1"]')!.textContent).not.toContain('skipped')
  })
})

describe('the Playbook & logs page', () => {
  it('is linked from the release page header, and back returns to the release', async () => {
    await open(`/deployments/release/${REL}`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Playbook & logs' }))
    await flush()
    await flush()
    expect(screen.getByRole('heading', { name: 'Playbook & logs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    await flush()
    await flush()
    expect(screen.getByRole('heading', { name: 'Release' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ansible steps' })).toBeInTheDocument()
  })

  it('shows the exact stored playbook, saves it, and never shows the secret', async () => {
    const detail = detailWithPlaybook({ status: 'failed' })
    const invoke = await open(`/deployments/release/${REL}/logs`, failingRun(), detail)
    const viewer = screen.getByRole('region', { name: 'Playbook' })
    expect(detail.playbook).toContain(SECRET)
    expect(viewer.querySelector('pre')!.textContent).toBe(detail.playbook!.replaceAll(SECRET, '‹redacted›'))
    expect(viewer.querySelector('pre')).toHaveAttribute('tabindex', '0')
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save as .yml…' }))
    await flush()
    expect(invoke.mock.calls.filter((c) => c[0] === 'release:savePlaybook').map((c) => c.slice(1))).toEqual([[REL]])
    expect(within(viewer).getByRole('status')).toHaveTextContent('Saved to /tmp/x/release.yml')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: 'All logs' }))
    expect(screen.getByRole('log', { name: 'Release log' })).toHaveTextContent('probe https://site.example/up?token=‹redacted›')
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('opens on the failed task: its own output, and its task marked in the playbook', async () => {
    await open(`/deployments/release/${REL}/logs`, failingRun(), detailWithPlaybook({ status: 'failed' }))
    const steps = screen.getByRole('navigation', { name: 'Steps' })
    expect(within(steps).getByRole('button', { name: /^Health 2 on app2: failed/ })).toHaveAttribute('aria-pressed', 'true')
    const out = screen.getByRole('region', { name: 'Health 2 on app2' })
    expect(within(out).getByText('GET /up 503')).toBeInTheDocument()
    expect(within(out).queryByText('GET /ready 200')).toBeNull()
    const marked = screen.getByRole('region', { name: 'Playbook' }).querySelectorAll('[data-highlight]')
    expect([...marked].map((l) => l.textContent?.trim())).toEqual(['"name": "health site 1",'])
  })

  it('picking a step shows that task’s output and marks it in the playbook; All logs shows the whole stream', async () => {
    const scroll = vi.fn()
    const was = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      await open(`/deployments/release/${REL}/logs`, failingRun(), detailWithPlaybook({ status: 'failed' }))
      const steps = screen.getByRole('navigation', { name: 'Steps' })
      fireEvent.click(within(steps).getByRole('button', { name: /^Health 1 on app2: done/ }))
      const out = screen.getByRole('region', { name: 'Health 1 on app2' })
      expect(within(out).getByText('GET /ready 200')).toBeInTheDocument()
      expect(within(out).queryByText('GET /up 503')).toBeNull()
      const line = screen.getByRole('region', { name: 'Playbook' }).querySelector('[data-highlight]')!
      expect(line.textContent?.trim()).toBe('"name": "health site 0",')
      expect(scroll.mock.contexts.at(-1)).toBe(line)
      fireEvent.click(within(steps).getByRole('button', { name: 'All logs' }))
      expect(within(steps).getByRole('button', { name: 'All logs' })).toHaveAttribute('aria-pressed', 'true')
      const log = screen.getByRole('log', { name: 'Release log' })
      expect(log).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Playbook' }).querySelector('[data-highlight]')).toBeNull()
    } finally {
      Element.prototype.scrollIntoView = was
    }
  })

  it('updates live while the release runs', async () => {
    const all = failingRun()
    const at = all.findIndex((e) => e.type === 'log' && e.task === 'health site 1')
    await open(`/deployments/release/${REL}/logs`, all.slice(0, at), detailWithPlaybook({ status: 'running' }))
    const steps = screen.getByRole('navigation', { name: 'Steps' })
    const toggle = within(steps).getByRole('button', { name: /^Health 2 on app2: running/ })
    fireEvent.click(toggle)
    const out = screen.getByRole('region', { name: 'Health 2 on app2' })
    expect(within(out).getByText('No output')).toBeInTheDocument()
    act(() => emitBridgeEvent('deploy:event', live(events(all).slice(at))))
    await flush()
    expect(within(out).getByText('GET /up 503')).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: /^Health 2 on app2: failed/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a release without a stored playbook says so and still lists its steps and output', async () => {
    await open(`/deployments/release/${REL}/logs`, OK_RUN, releaseDetail({ status: 'succeeded' }))
    expect(within(screen.getByRole('region', { name: 'Playbook' })).getByText('Playbook not stored for this release')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save as .yml…' })).toBeNull()
    const steps = screen.getByRole('navigation', { name: 'Steps' })
    fireEvent.click(within(within(steps).getByRole('list', { name: 'core' })).getByRole('button', { name: /^Build on app1: done/ }))
    expect(within(screen.getByRole('region', { name: 'Build on app1' })).getByText('built')).toBeInTheDocument()
  })
  it('a playbook that could not be read says so, and Retry reads it again', async () => {
    const detail = detailWithPlaybook({ status: 'failed' })
    const invoke = await open(`/deployments/release/${REL}/logs`, failingRun(), detail)
    cleanup()
    resetReleases()
    const base = invoke.getMockImplementation()!
    // The release itself loads (the first read); the playbook's own read fails until Retry.
    let fail = true
    let gets = 0
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'release:get' && gets++ > 0 && fail) throw new Error('Hub unreachable')
      return (base as (...a: unknown[]) => Promise<unknown>)(channel, ...args)
    })
    render(
      <MemoryRouter initialEntries={[`/deployments/release/${REL}/logs`]}>
        <Routes>
          <Route path="/deployments/release/:id/logs" element={<PlaybookLogsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await flush()
    await flush()
    const viewer = screen.getByRole('region', { name: 'Playbook' })
    expect(within(viewer).getByText("Couldn't read the playbook: Hub unreachable")).toBeInTheDocument()
    expect(within(viewer).queryByText('Playbook not stored for this release')).toBeNull()
    fail = false
    fireEvent.click(within(viewer).getByRole('button', { name: 'Retry' }))
    await flush()
    expect(viewer.querySelector('pre')!.textContent).toContain('"name": "health site 1"')
  })

  it('a playbook left out because it covers deployments the viewer cannot see says that, not "not stored"', async () => {
    await open(`/deployments/release/${REL}/logs`, failingRun(), { ...detailWithPlaybook({ status: 'failed' }), playbook: null, playbookHidden: true })
    const viewer = screen.getByRole('region', { name: 'Playbook' })
    expect(within(viewer).getByText("This playbook also covers deployments you don't have access to, so it isn't shown.")).toBeInTheDocument()
    expect(within(viewer).queryByText('Playbook not stored for this release')).toBeNull()
  })

  it('marks the task, not a play of the same name, and picking it again scrolls back to it', async () => {
    const scroll = vi.fn()
    const was = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      const detail = detailWithPlaybook({ status: 'failed' })
      const plays = JSON.parse(detail.playbook!) as { name?: string }[]
      plays[0].name = 'health site 0'
      await open(`/deployments/release/${REL}/logs`, failingRun(), { ...detail, playbook: JSON.stringify(plays, null, 2) })
      const steps = screen.getByRole('navigation', { name: 'Steps' })
      const pick = () => fireEvent.click(within(steps).getByRole('button', { name: /^Health 1 on app2: done/ }))
      pick()
      const marked = screen.getByRole('region', { name: 'Playbook' }).querySelectorAll('[data-highlight]')
      expect(marked).toHaveLength(1)
      // A play's name sits at the play's level; a task's is nested in the play's tasks.
      expect(marked[0].textContent).toMatch(/^ {8,}"name": "health site 0",/)
      const calls = scroll.mock.calls.length
      pick()
      expect(scroll.mock.calls.length).toBe(calls + 1)
      expect(scroll.mock.contexts.at(-1)).toBe(marked[0])
    } finally {
      Element.prototype.scrollIntoView = was
    }
  })
})
