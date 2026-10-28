import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { registerFailureAction, type FailureActionProps } from '../../src/renderer/src/deploy/slots'
import { ReleaseView } from '../../src/renderer/src/pages/deployments/release/ReleaseView'
import { DRAIN_TRANSITION, StepChip } from '../../src/renderer/src/pages/deployments/release/StepChip'
import type { ChipState } from '../../src/renderer/src/deploy/pipeline'
import { spring } from '../../src/renderer/src/ui/motion'
import type { ReleaseDetail, RunEvent, RunEventBody } from '../../src/shared/deploy'
import { events, healthFailure, OK_RUN, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

// these tests read the Steps view; the release page opens on the Terminal by default
beforeEach(() => localStorage.setItem('opsdeck.release.view', 'steps'))
afterEach(() => localStorage.removeItem('opsdeck.release.view'))

// framer-motion caches matchMedia, so reduced motion is driven through its hook directly.
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => reduced.on,
}))

// Every counter a chip hands useShake, so a test can tell whether it shook.
const shakes = vi.hoisted(() => ({ seen: [] as number[] }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()
  return {
    ...mod,
    useShake: (counter: number) => {
      shakes.seen.push(counter)
      return mod.useShake(counter)
    },
  }
})

const flush = () => act(async () => {})

const chipOf = (state: ChipState['state']): ChipState => ({ stepId: 'r1:up', kind: 'up', label: 'Up', state, startedAt: null, durationMs: null, error: null })

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
  shakes.seen = []
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

  it('every step state has its icon and words', () => {
    const want: [ChipState['state'], string, string][] = [
      ['pending', 'pending', 'pending'],
      ['running', 'spinner', 'running'],
      ['ok', 'check', 'done'],
      ['warn', 'triangle', 'warning'],
      ['failed', 'cross', 'failed'],
      ['skipped', 'dashed', 'skipped'],
      ['cancelled', 'slash', 'cancelled'],
      ['rolled_back', 'undo', 'rolled back'],
    ]
    for (const [state, icon, word] of want) {
      render(<StepChip chip={chipOf(state)} host="app1" />)
      const el = chip('r1:up')
      expect(el).toHaveAttribute('data-state', state)
      expect(el).toHaveAccessibleName(`Up on app1: ${word}`)
      expect(el.querySelector('[data-icon]')).toHaveAttribute('data-icon', icon)
      cleanup()
    }
    // A cancel asked for shows on the running step until it stops.
    render(<StepChip chip={chipOf('running')} host={null} cancelling />)
    expect(chip('r1:up')).toHaveAccessibleName('Up: cancelling')
  })

  it('a rolled-back step drains its fill quickly under motion', () => {
    render(<StepChip chip={chipOf('rolled_back')} host="app1" />)
    expect(document.querySelector('[data-reverse]')).not.toBeNull()
    // The spring settles well inside the 300 ms limit; no fixed 0.3 s tween.
    expect(DRAIN_TRANSITION).toEqual(spring)
  })

  it('a chip shakes when it turns failed, not when it mounts failed', () => {
    render(<StepChip chip={chipOf('failed')} host="app1" />)
    expect(Math.max(...shakes.seen)).toBe(0)
    cleanup()
    shakes.seen = []
    const live = render(<StepChip chip={chipOf('running')} host="app1" />)
    live.rerender(<StepChip chip={chipOf('failed')} host="app1" />)
    expect(Math.max(...shakes.seen)).toBe(1)
    // Staying failed does not shake again.
    live.rerender(<StepChip chip={{ ...chipOf('failed'), durationMs: 5000 }} host="app1" />)
    expect(Math.max(...shakes.seen)).toBe(1)
  })

  it('a rollback in progress offers no Cancel, since main lets it finish', async () => {
    await view(healthFailure(true).slice(0, -3))
    expect(screen.getByText('rolling back')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})

describe('release view switch', () => {
  beforeEach(() => localStorage.removeItem('opsdeck.release.view'))
  const radio = (name: string) => screen.getByRole('radio', { name })

  it('opens on ansible\'s console, and a choice on the switch is remembered', async () => {
    await view(OK_RUN.slice(0, 6))
    expect(radio('Terminal')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('ansible-terminal')).toBeInTheDocument()
    act(() => radio('Steps').click())
    expect(screen.queryByTestId('ansible-terminal')).toBeNull()
    expect(localStorage.getItem('opsdeck.release.view')).toBe('steps')
  })

  it('a failed release names the failure over the console and opens it in Steps, without changing the default', async () => {
    await view(healthFailure(false))
    const alert = screen.getByTestId('terminal-failure')
    expect(alert).toHaveTextContent(/Health failed on app2/)
    act(() => within(alert).getByRole('button', { name: 'Open in Steps' }).click())
    expect(screen.getByRole('region', { name: 'Health on app2 failed' })).toBeInTheDocument()
    expect(localStorage.getItem('opsdeck.release.view')).toBeNull()
  })

  it("shows the release's own error when it says more than the failed step, and not when it repeats it", async () => {
    const restored = 'Build failed for backend: no service was restarted; the checkout is back on the previous commit'
    const body = healthFailure(false)
    body[body.length - 1] = { type: 'run.finished', status: 'failed', error: restored }
    await view(body)
    expect(screen.getByRole('alert')).toHaveTextContent(restored)
    cleanup()
    resetReleases()
    await view(healthFailure(false))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('picking a step in the pipeline shows it in Steps', async () => {
    await view(OK_RUN.slice(0, 6))
    const first = document.querySelector<HTMLElement>('[data-step]')!
    act(() => first.click())
    expect(radio('Steps')).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('opsdeck.release.view')).toBeNull()
  })
})
