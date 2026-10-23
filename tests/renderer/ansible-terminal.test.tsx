import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openRelease, resetReleases, startReleaseSync } from '../../src/renderer/src/deploy/releases'
import { termText } from '../../src/renderer/src/deploy/term-color'
import { AnsibleTerminal } from '../../src/renderer/src/pages/deployments/release/AnsibleTerminal'
import { events, OK_RUN, REL, releaseDetail } from './fixtures/release-events'
import { emitBridgeEvent, mockBridge } from './helpers'
import { fake, resetFakeXterm } from './terminal-fakes'

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))

const term = (line: string) => ({ type: 'log' as const, stepId: null, hostId: null, stream: 'term' as const, line })
const ESC = '\x1b'

beforeEach(() => {
  resetFakeXterm()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  resetReleases()
  vi.unstubAllGlobals()
})

describe('termText', () => {
  it('colours ansible lines by what they are, and a task starts after a blank line', () => {
    expect(termText('TASK [lock]')).toBe(`\r\n${ESC}[1mTASK [lock]${ESC}[0m\r\n`)
    expect(termText('ok: [web-1]')).toBe(`${ESC}[32mok: [web-1]${ESC}[0m\r\n`)
    expect(termText('changed: [web-1]')).toContain(`${ESC}[33m`)
    expect(termText('fatal: [web-1]: FAILED! rc=2')).toContain(`${ESC}[31m`)
    expect(termText('skipping: [web-1]')).toContain(`${ESC}[36m`)
    expect(termText('[WARNING]: old')).toContain(`${ESC}[35m`)
    expect(termText('PLAY [preflight od-1]')).toBe(`\r\n${ESC}[1mPLAY [preflight od-1]${ESC}[0m\r\n`)
    expect(termText('skipping: no hosts matched')).toContain(`${ESC}[31m`)
    expect(termText('NO MORE HOSTS LEFT')).toContain(`${ESC}[31m`)
    expect(termText('    plain output')).toBe('    plain output\r\n')
    expect(termText('web-1 : ok=3  changed=0  unreachable=0  failed=0  skipped=0  rescued=0  ignored=0')).toContain(`${ESC}[32m`)
    expect(termText('web-1 : ok=3  changed=0  unreachable=0  failed=1  skipped=0  rescued=0  ignored=0')).toContain(`${ESC}[31m`)
  })

  it('drops a host\'s control characters, so output cannot move the cursor or retitle the view', () => {
    expect(termText(`    a${ESC}]0;pwned\x07b${ESC}[2Jc\tok`)).toBe('    a]0;pwnedb[2Jc\tok\r\n')
  })
})

describe('AnsibleTerminal', () => {
  it('is read-only, writes what arrived and then each live batch', async () => {
    const all = events([...OK_RUN.slice(0, 3), term('TASK [lock]'), term('ok: [web-1]'), ...OK_RUN.slice(3, 4)])
    mockBridge({ 'release:get': releaseDetail(), 'release:active': [], 'release:events': [] })
    const stop = startReleaseSync()
    await act(() => openRelease(REL))
    act(() => emitBridgeEvent('deploy:event', all.slice(0, 4)))
    render(<AnsibleTerminal releaseId={REL} />)
    const t = fake.terms[0]
    expect(t.options.disableStdin).toBe(true)
    expect(t.write.mock.calls.map((c) => c[0])).toEqual([termText('TASK [lock]')])
    expect(screen.queryByText('Waiting for ansible output')).toBeNull()
    act(() => emitBridgeEvent('deploy:event', all.slice(4)))
    expect(t.write.mock.calls.map((c) => c[0])).toEqual([termText('TASK [lock]'), termText('ok: [web-1]')])
    cleanup()
    expect(t.dispose).toHaveBeenCalled()
    stop()
  })

  it('says it is waiting until the first line', async () => {
    mockBridge({ 'release:get': releaseDetail(), 'release:active': [], 'release:events': [] })
    await act(() => openRelease(REL))
    render(<AnsibleTerminal releaseId={REL} />)
    expect(screen.getByText('Waiting for ansible output')).toBeTruthy()
    expect(fake.terms[0].write).not.toHaveBeenCalled()
  })
})
