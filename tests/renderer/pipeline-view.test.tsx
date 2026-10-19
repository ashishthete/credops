import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { registerFailureAction, type FailureActionProps } from '../../src/renderer/src/pages/deployments/release/FailurePanel'
import { ReleaseView } from '../../src/renderer/src/pages/deployments/release/ReleaseView'
import type { ReleaseDetail, RunEvent, RunEventBody } from '../../src/shared/deploy'
import { events, healthFailure, OK_RUN, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through its hook directly.
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => reduced.on,
}))

const flush = () => act(async () => {})

/** `release:events` pages `stored` by afterSeq and limit, as main does. */
function world(stored: RunEvent[], detail: ReleaseDetail = releaseDetail({ status: 'running' })) {
  const invoke = mockBridge({ 'release:get': detail })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return stored.filter((e) => e.seq > after).slice(0, limit)
    }
    return base(channel)
  })
  return invoke
}

async function view(stored: RunEventBody[], detail?: ReleaseDetail) {
  world(events(stored), detail)
  const out = render(
    <MemoryRouter>
      <ReleaseView releaseId={REL} />
    </MemoryRouter>,
  )
  await flush()
  await flush()
  return out
}

const chip = (stepId: string) => document.querySelector<HTMLElement>(`[data-step="${stepId}"]`)!

beforeEach(() => {
  reduced.on = false
})

afterEach(() => {
  cleanup()
  resetReleases()
})

describe('pipeline view', () => {
  it('renders a lane per host with run rows labelled by services or whole checkout', async () => {
    await view(OK_RUN)
    const pipeline = screen.getByRole('group', { name: 'Pipeline' })
    const lanes = [...pipeline.querySelectorAll('[data-lane]')].map((l) => l.getAttribute('data-lane'))
    expect(lanes).toEqual(['h1', 'h2', 'release'])
    const app1 = within(pipeline).getByRole('region', { name: 'app1' })
    expect(within(app1).getByText('core: api and worker')).toBeInTheDocument()
    expect(within(app1).getByText('web: whole checkout')).toBeInTheDocument()
    expect(within(within(pipeline).getByRole('region', { name: 'app2' })).getByText('site: site')).toBeInTheDocument()
  })

  it('chip states map to icons and aria-labels', async () => {
    await view(healthFailure(false))
    const health = chip('r3:health')
    expect(health).toHaveAttribute('data-state', 'failed')
    expect(health).toHaveAccessibleName('Health on app2: failed')
    expect(health.querySelector('[data-icon]')).toHaveAttribute('data-icon', 'cross')
    expect(chip('r1:build')).toHaveAccessibleName('Build on app1: done')
    expect(chip('r1:build').querySelector('[data-icon]')).toHaveAttribute('data-icon', 'check')
    // r3 never reached its tag step.
    expect(chip('r3:tag')).toHaveAccessibleName('Tag on app2: pending')
    expect(chip('r3:tag').querySelector('[data-icon]')).toHaveAttribute('data-icon', 'pending')
  })

  it('failure shows FailurePanel with registered actions', async () => {
    const seen: FailureActionProps[] = []
    const Action = (p: FailureActionProps) => {
      seen.push(p)
      return <button type="button">Explain the failure</button>
    }
    const off = registerFailureAction(Action)
    try {
      await view([
        ...healthFailure(false).slice(0, -2),
        { type: 'log', stepId: 'r3:health', hostId: 'h2', stream: 'err', line: 'GET /health 503' },
        ...healthFailure(false).slice(-2),
      ])
      const panel = screen.getByRole('region', { name: 'Health on app2 failed' })
      expect(within(panel).getByText('Health on app2 failed: health check failed on app2')).toBeInTheDocument()
      expect(within(panel).getByText('GET /health 503')).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Explain the failure' })).toBeInTheDocument()
      expect(seen.at(-1)).toMatchObject({ releaseId: REL, stepId: 'r3:health', error: 'health check failed on app2', lines: ['GET /health 503'] })
    } finally {
      off()
    }
  })

  /** Opens mid-run, then the rest arrives live: the view saw it running before it succeeded. */
  async function liveSuccess() {
    const all = events(OK_RUN)
    const cut = 10
    await view(OK_RUN.slice(0, cut))
    expect(screen.queryByText('running')).toBeInTheDocument()
    act(() => emitBridgeEvent('deploy:event', all.slice(cut)))
    await flush()
  }

  it('success shows Celebrate, reduced motion does not', async () => {
    await liveSuccess()
    expect(screen.getByText('succeeded')).toBeInTheDocument()
    expect(document.querySelector('[data-celebrate]')).not.toBeNull()
    cleanup()
    resetReleases()

    // A release that had already succeeded when it opened does not celebrate.
    await view(OK_RUN, releaseDetail({ status: 'succeeded', startedAt: '2026-10-19T10:00:01.000Z', finishedAt: '2026-10-19T10:01:00.000Z' }))
    expect(screen.getByText('succeeded')).toBeInTheDocument()
    expect(document.querySelector('[data-celebrate]')).toBeNull()
    cleanup()
    resetReleases()

    reduced.on = true
    await liveSuccess()
    expect(screen.getByText('succeeded')).toBeInTheDocument()
    expect(document.querySelector('[data-celebrate]')).toBeNull()
  })

  it('reduced motion shows state by icon and text only', async () => {
    reduced.on = true
    const running: RunEventBody[] = [
      ...healthFailure(true).slice(0, 4),
      { type: 'step.started', stepId: 'r1:record', kind: 'record', name: 'record', hostId: 'h1', deploymentRunId: 'r1' },
    ]
    await view(running)
    const record = chip('r1:record')
    expect(record).toHaveAttribute('data-state', 'running')
    expect(record).toHaveAccessibleName('Record on app1: running')
    expect(record.querySelector('[data-icon]')).toHaveAttribute('data-icon', 'spinner')
    // No shimmer, no transform anywhere in the pipeline.
    expect(record.className).not.toContain('od-chip-running')
    const pipeline = screen.getByRole('group', { name: 'Pipeline' })
    for (const el of pipeline.querySelectorAll<HTMLElement>('*')) expect(el.style.transform).toBe('')
    cleanup()
    resetReleases()

    await view(healthFailure(true))
    // A rolled-back step shows its undo icon and words; the draining fill only runs with motion.
    const build = chip('r1:build')
    expect(build).toHaveAttribute('data-state', 'rolled_back')
    expect(build).toHaveAccessibleName('Build on app1: rolled back')
    expect(build.querySelector('[data-icon]')).toHaveAttribute('data-icon', 'undo')
    expect(document.querySelector('[data-reverse]')).toBeNull()
    expect(chip('r3:health')).toHaveAccessibleName('Health on app2: failed')
  })
})
