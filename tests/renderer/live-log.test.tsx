import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { openRelease, resetReleases, startReleaseSync } from '../../src/renderer/src/deploy/releases'
import { LiveLog } from '../../src/renderer/src/pages/deployments/release/LiveLog'
import type { RunEvent, RunEventBody } from '../../src/shared/deploy'
import { events, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'

const flush = () => act(async () => {})

const log = (line: string, stepId = 'r1:build'): RunEventBody => ({ type: 'log', stepId, hostId: 'h1', stream: 'out', line })
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => log(`line ${from + i}`))

async function open(stored: RunEvent[]) {
  const invoke = mockBridge({ 'release:get': releaseDetail({ status: 'running' }) })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return stored.filter((e) => e.seq > after).slice(0, limit)
    }
    return base(channel)
  })
  const stop = startReleaseSync()
  await act(() => openRelease(REL))
  render(<LiveLog releaseId={REL} filter={{}} onFilterChange={() => {}} />)
  await flush()
  return stop
}

let stop: (() => void) | null = null

afterEach(() => {
  cleanup()
  stop?.()
  stop = null
  resetReleases()
})

describe('live log', () => {
  it('renders only a window of rows', async () => {
    stop = await open(events(lines(5000)))
    const rows = document.querySelectorAll('[data-row]')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(120)
    // Following: the window sits at the end.
    expect(screen.getByText('line 4999')).toBeInTheDocument()
    expect(screen.queryByText('line 0')).not.toBeInTheDocument()
  })

  it('scroll up pauses and shows Jump to live (+n)', async () => {
    stop = await open(events(lines(500)))
    const body = screen.getByRole('log', { name: 'Release log' })
    expect(screen.queryByRole('button', { name: /Jump to live/ })).not.toBeInTheDocument()

    body.scrollTop = 0
    fireEvent.scroll(body)
    expect(screen.getByRole('button', { name: 'Jump to live' })).toBeInTheDocument()
    expect(screen.getByText('line 0')).toBeInTheDocument()

    act(() => emitBridgeEvent('deploy:event', events(lines(3, 500), 501)))
    await flush()
    // Paused: the new lines are counted, not scrolled to.
    expect(screen.getByRole('button', { name: 'Jump to live (+3)' })).toBeInTheDocument()
    expect(screen.queryByText('line 502')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Jump to live (+3)' }))
    expect(screen.getByText('line 502')).toBeInTheDocument()
    // The pill fades out.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Jump to live/ })).not.toBeInTheDocument())
  })

  it('text is rendered as text, not HTML', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"> \u001b[31mred\u001b[0m'
    stop = await open(events([log(evil)]))
    const body = screen.getByRole('log', { name: 'Release log' })
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror="window.__pwned=1">')
    // The colour code is styled, not printed.
    expect(body.textContent).toContain('red')
    expect(body.textContent).not.toContain('\u001b[31m')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
