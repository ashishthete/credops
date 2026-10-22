import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lineDiff } from '../../src/renderer/src/deploy/line-diff'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { PlaybookReview } from '../../src/renderer/src/pages/deployments/release/PlaybookReview'
import { PlaybookLogsPage } from '../../src/renderer/src/pages/deployments/PlaybookLogsPage'
import { ReleasePage } from '../../src/renderer/src/pages/deployments/ReleasePage'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import type { ReleaseDetail } from '../../src/shared/deploy'
import { events, OK_RUN, playbookOf, REL, releaseDetail } from './fixtures/release-events'
import { mockBridge } from './helpers'

const PLAYBOOK = JSON.stringify([{ name: 'release', hosts: 'od-1', tasks: [{ name: 'step', shell: 'true' }] }], null, 2)
const SHA = 'a'.repeat(64)

afterEach(() => {
  cleanup()
  resetDeploy()
  resetReleases()
})

describe('lineDiff', () => {
  it('marks nothing for equal texts and handles empty input', () => {
    expect(lineDiff('', '')).toEqual([])
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { op: ' ', text: 'a' },
      { op: ' ', text: 'b' },
    ])
    expect(lineDiff('', 'x')).toEqual([{ op: '+', text: 'x' }])
    expect(lineDiff('x', '')).toEqual([{ op: '-', text: 'x' }])
  })

  it('shows a pure insert as one + line between unchanged ones', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { op: ' ', text: 'a' },
      { op: '+', text: 'b' },
      { op: ' ', text: 'c' },
    ])
  })

  it('shows a changed line as - then +', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc').filter((l) => l.op !== ' ')).toEqual([
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
    ])
  })
})

function review(over: Partial<React.ComponentProps<typeof PlaybookReview>> = {}) {
  const onRunEdited = vi.fn()
  render(<PlaybookReview playbook={PLAYBOOK} autoRollback={false} onSave={() => {}} editable releaseId="r1" onRunEdited={onRunEdited} {...over} />)
  return { onRunEdited }
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByRole('textbox', { name: 'Edit playbook' })
  await user.click(box)
  await user.type(box, text)
}

describe('editing a playbook under review', () => {
  it('has no Edit button when not editable', () => {
    review({ editable: false })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('shows a validation error next to its line and keeps Run edited off', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge({ 'release:validateEdit': { ok: false, errors: [{ line: 12, message: 'The module "copy" is not allowed' }] } })
    review({ forceServiceIds: ['s1'] })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await typeInto(user, ' ')
    const err = await screen.findByText(/The module "copy" is not allowed/)
    expect(err.closest('li')).toHaveTextContent('Line 12')
    expect(screen.getByRole('button', { name: 'Run edited' })).toBeDisabled()
    const call = (invoke.mock.calls as unknown[][]).find((c) => c[0] === 'release:validateEdit')!
    expect(call[1]).toBe('r1')
    expect(call[3]).toEqual(['s1'])
  })

  it('passes the canonical sha with the typed text on Run edited', async () => {
    const user = userEvent.setup()
    mockBridge({ 'release:validateEdit': { ok: true, canonical: PLAYBOOK + '\n', sha256: SHA } })
    const { onRunEdited } = review()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await typeInto(user, ' ')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run edited' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Run edited' }))
    expect(onRunEdited).toHaveBeenCalledWith(expect.stringContaining('"release"'), SHA)
  })

  it('offers to preview again when main says the preview is gone', async () => {
    const user = userEvent.setup()
    const invoke = mockBridge()
    invoke.mockImplementation(async (c: string) => {
      if (c === 'release:validateEdit') throw new Error('The preview expired, preview again')
      return null
    })
    const onPreviewAgain = vi.fn()
    review({ onPreviewAgain })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await typeInto(user, ' ')
    expect(await screen.findByText(/preview again/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview again' }))
    expect(onPreviewAgain).toHaveBeenCalled()
  })
})

async function open(path: string, detail: ReleaseDetail) {
  const invoke = mockBridge({ 'release:get': detail, 'release:list': [] })
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'release:events') {
      const [, after, limit] = args as [string, number, number]
      return events(OK_RUN).filter((e) => e.seq > after).slice(0, limit)
    }
    return base(channel)
  })
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deployments/release/:id" element={<ReleasePage />} />
        <Route path="/deployments/release/:id/logs" element={<PlaybookLogsPage />} />
      </Routes>
    </MemoryRouter>,
  )
  for (let n = 0; n < 3; n++) await act(async () => {})
}

const edited = (over: Partial<ReleaseDetail> = {}) => {
  const generated = playbookOf(releaseDetail(), { r3: 2 })
  const stored = generated.replace('lock od-1', 'lock od-1 edited')
  return releaseDetail({ status: 'succeeded', playbook: stored, playbookGenerated: generated, playbookSource: 'edited', ...over })
}

describe('an edited release', () => {
  it('says Edited playbook in the release header, and not for a generated one', async () => {
    await open(`/deployments/release/${REL}`, edited())
    expect(within(screen.getByRole('banner', { name: 'Release summary' })).getByText('Edited playbook')).toBeInTheDocument()
    cleanup()
    resetReleases()
    await open(`/deployments/release/${REL}`, edited({ playbookSource: 'generated', playbookGenerated: null }))
    expect(screen.queryByText('Edited playbook')).toBeNull()
  })

  it('toggles a +/- diff of the stored text against the generated one on the playbook page', async () => {
    const user = userEvent.setup()
    await open(`/deployments/release/${REL}/logs`, edited())
    expect(screen.getByText('Edited playbook')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show diff' }))
    const region = screen.getByRole('region', { name: 'Playbook' })
    expect(within(region).getAllByTestId('diff-line-+').length).toBeGreaterThan(0)
    expect(within(region).getAllByTestId('diff-line--').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Hide diff' }))
    expect(within(region).queryByTestId('diff-line-+')).toBeNull()
  })

  it('has no diff toggle for a generated playbook', async () => {
    await open(`/deployments/release/${REL}/logs`, edited({ playbookSource: 'generated', playbookGenerated: null }))
    expect(screen.queryByRole('button', { name: 'Show diff' })).toBeNull()
  })
})
