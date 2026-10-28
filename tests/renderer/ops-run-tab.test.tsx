import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { forwardRef, createElement, type ComponentType } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { rememberRequest, resetOps, startOpsSync } from '../../src/renderer/src/ops/runs'
import { launch } from '../../src/renderer/src/pages/ops/run/launch'
import { MULTIPLE_PROTECTED, requestProtection, runProtection } from '../../src/renderer/src/ops/protect'
import { OpsPage } from '../../src/renderer/src/pages/ops/OpsPage'
import { RunTab } from '../../src/renderer/src/pages/ops/RunTab'
import { clearToasts, toast } from '../../src/renderer/src/ui/Toaster'
import { encodeIpcError } from '../../src/shared/ipc-error'
import { MAX_RUNS_KEPT, MULTIPLE_PROTECTED_MESSAGE, type RunEvent, type RunHostMeta, type RunSummary, type SnippetMeta } from '../../src/shared/ops'
import { emitBridgeEvent, environment, host, mockBridge } from './helpers'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))

// Shows each motion element's `layout` prop as data-layout, so a test can see whether it would animate layout.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  const cache = new Map<string, unknown>()
  const wrapped = new Proxy(actual.motion, {
    get(target, key) {
      const inner = Reflect.get(target, key) as ComponentType<Record<string, unknown>>
      if (typeof key !== 'string' || !/^[a-z]+$/.test(key) || key === 'create') return inner
      if (!cache.has(key)) {
        cache.set(
          key,
          forwardRef<unknown, Record<string, unknown>>((props, ref) =>
            createElement(inner, {
              ...props,
              ref,
              'data-layout': props.layout ? String(props.layout) : undefined,
              'data-initial': props.initial === false ? 'false' : undefined,
            }),
          ),
        )
      }
      return cache.get(key)
    },
  })
  return { ...actual, motion: wrapped }
})

vi.mock('../../src/renderer/src/ui/Toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/Toaster')>()),
  toast: vi.fn(() => 'toast-1'),
}))

const STAMP = '2026-10-19T09:00:00.000Z'
const labels = ['db-1', 'db-2', 'web-1', 'web-2', 'web-3', 'web-4', 'bastion', 'cache-1']
const roles = { 'db-1': 'db', 'db-2': 'db', 'web-1': 'app', 'web-2': 'app', 'web-3': 'app', 'web-4': 'app', bastion: 'bastion', 'cache-1': 'other' } as const
const prodHosts = labels.map((l) => host({ id: `h-${l}`, label: l, tags: l.startsWith('web') ? ['frontend'] : [] }))
const stg = host({ id: 'h-stg-1', label: 'stg-1' })
const ops = host({ id: 'h-ops-1', label: 'ops-1' })
const prod = environment({
  id: 'e-prod',
  name: 'prod',
  protected: true,
  hosts: labels.map((l) => ({ hostId: `h-${l}`, role: roles[l as keyof typeof roles] })),
})
const staging = environment({ id: 'e-stg', name: 'staging', hosts: [{ hostId: 'h-stg-1', role: 'app' }] })
const audit = environment({ id: 'e-audit', name: 'audit', protected: true, hosts: [{ hostId: 'h-ops-1', role: 'other' }] })

const snippet: SnippetMeta = {
  id: 's1',
  label: 'Restart service',
  script: "systemctl restart '{{svc}}' {{unit}}",
  description: '',
  tags: [],
  variables: [
    { name: 'svc', default: 'nginx' },
    { name: 'unit', default: null },
  ],
  destructive: false,
  createdAt: STAMP,
  updatedAt: STAMP,
}

const hostMeta = (hostId: string, over: Partial<RunHostMeta> = {}): RunHostMeta => ({
  hostId,
  label: hostId.replace(/^h-/, ''),
  state: 'queued',
  exitCode: null,
  signal: null,
  error: null,
  startedAt: null,
  endedAt: null,
  truncated: false,
  ...over,
})
const summary = (hostIds: string[], over: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1',
  state: 'running',
  title: 'uptime',
  environmentId: null,
  environmentName: null,
  concurrency: 4,
  hosts: hostIds.map((id) => hostMeta(id)),
  startedAt: STAMP,
  endedAt: null,
  outputDropped: false,
  ...over,
})

const flush = () => act(async () => {})
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const send = (e: RunEvent) => act(() => emitBridgeEvent('run:event', e))
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  (invoke.mock.calls as unknown[][]).filter((c) => c[0] === channel)
const chip = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}:`) })

let stopSync: (() => void) | null = null

async function renderTab(results: Record<string, unknown> = {}, entry = '/ops/run') {
  const invoke = mockBridge({ 'snippets:list': [snippet], ...results })
  inventoryStore.set({ products: [], environments: [prod, staging, audit], hosts: [...prodHosts, stg, ops], identities: [], vaults: [], regions: [] })
  stopSync = startOpsSync()
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <RunTab />
    </MemoryRouter>,
  )
  await flush()
  return { invoke, ...view }
}

/** Replies to runs:start with `run`, and to runs:get with it and no output. */
function startsRun(run: RunSummary) {
  return {
    'runs:start': run,
    'runs:get': { run, output: [] },
  }
}

const runButton = () => screen.getByRole('button', { name: /^Run on/ })
const typeCommand = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: text } })

beforeEach(() => {
  vi.useFakeTimers()
  motion.safe = true
  vi.mocked(toast).mockClear()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  stopSync?.()
  stopSync = null
  resetOps()
  inventoryStore.set(null)
  clearToasts()
})

describe('run tab', () => {
  it('/ops/run?hosts=web1 preselects web1', async () => {
    await renderTab({}, '/ops/run?hosts=h-web-1,nope')
    const list = screen.getByRole('list', { name: 'Target hosts' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['web-1'])
    expect(screen.getByRole('radio', { name: 'Hosts' })).toHaveAttribute('aria-checked', 'true')
  })

  it('/ops/run?hosts=web1&env=e-prod also sets the environment context', async () => {
    await renderTab({}, '/ops/run?hosts=h-web-1&env=e-prod')
    expect(screen.getByRole('combobox', { name: 'Environment context' })).toHaveValue('e-prod')
  })

  it('an unknown ?env= is ignored', async () => {
    await renderTab({}, '/ops/run?hosts=h-web-1&env=nope')
    expect(screen.getByRole('combobox', { name: 'Environment context' })).toHaveValue('')
  })

  it('picking an environment and role previews matching hosts', async () => {
    await renderTab()
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'e-prod' } })
    expect(screen.getByRole('button', { name: 'All 8' })).toHaveAttribute('aria-pressed', 'true')
    const preview = () => screen.getByRole('list', { name: 'Target hosts' })
    expect(within(preview()).getAllByRole('listitem')).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: 'db 2' }))
    expect(screen.getByText('2 hosts')).toBeInTheDocument()
    expect(within(preview()).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['db-1', 'db-2'])
    expect(screen.getByRole('button', { name: 'app 4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'bastion 1' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'e-stg' } })
    expect(within(preview()).queryAllByRole('listitem').map((li) => li.textContent)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'All 1' }))
    expect(within(preview()).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['stg-1'])
  })

  it('the hosts checklist filters by search and tag', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    const list = screen.getByRole('group', { name: 'Hosts to run on' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), { target: { value: 'frontend' } })
    expect(within(list).getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['web-1', 'web-2', 'web-3', 'web-4'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search hosts' }), { target: { value: '3' } })
    fireEvent.click(within(list).getByRole('checkbox', { name: 'web-3' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search hosts' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), { target: { value: '' } })
    fireEvent.click(within(list).getByRole('checkbox', { name: 'stg-1' }))
    expect(within(screen.getByRole('list', { name: 'Target hosts' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'web-3',
      'stg-1',
    ])
  })

  it("a snippet's variables become fields and a quoted placeholder shows the template error from main", async () => {
    const { invoke } = await renderTab()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'snippets:render')
        throw new Error("Error invoking remote method 'snippets:render': Error: {{svc}} is inside quotes; remove them, CredOps quotes values itself")
      if (channel === 'snippets:list') return [snippet]
      return null
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Snippet' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Snippet' }), { target: { value: 's1' } })
    expect(screen.getByRole('textbox', { name: 'svc' })).toHaveValue('nginx')
    expect(screen.getByRole('textbox', { name: 'unit' })).toHaveValue('')
    await tick(400)
    expect(calls(invoke, 'snippets:render').at(-1)).toEqual(['snippets:render', 's1', { svc: 'nginx' }])
    expect(screen.getByText('{{svc}} is inside quotes; remove them, CredOps quotes values itself')).toBeInTheDocument()
    // Never a toast: the error is the snippet's, shown where it is edited.
    expect(toast).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'unit' }), { target: { value: 'web' } })
    await tick(400)
    expect(calls(invoke, 'snippets:render').at(-1)).toEqual(['snippets:render', 's1', { svc: 'nginx', unit: 'web' }])
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    expect(runButton()).toBeDisabled()
  })

  it('a multi-host run in a protected environment asks for the typed name and sends it as confirm', async () => {
    const { invoke } = await renderTab(startsRun(summary(prodHosts.map((h) => h.id), { environmentId: 'e-prod', environmentName: 'prod' })))
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'e-prod' } })
    typeCommand('uptime')
    expect(screen.getByText('Protected')).toBeInTheDocument()
    expect(runButton()).toHaveTextContent('Run on 8 hosts…')
    fireEvent.click(runButton())
    await flush()

    const dialog = screen.getByRole('dialog', { name: 'Run on 8 hosts in prod?' })
    expect(dialog).toHaveAccessibleDescription('db-1, db-2, web-1, web-2, web-3 and 3 more')
    expect(calls(invoke, 'runs:start')).toHaveLength(0)
    const confirm = within(dialog).getByRole('button', { name: 'Run' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type prod to confirm' }), { target: { value: 'prod' } })
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(calls(invoke, 'runs:start')).toEqual([
      [
        'runs:start',
        {
          target: { kind: 'environment', environmentId: 'e-prod' },
          command: { kind: 'text', text: 'uptime' },
          concurrency: 4,
          timeoutSec: 600,
          confirm: 'prod',
        },
      ],
    ])
  })

  it('an unprotected single-host run starts without a dialog', async () => {
    const { invoke } = await renderTab(startsRun(summary(['h-stg-1'])))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    expect(runButton()).toHaveTextContent(/^Run on 1 host$/)
    fireEvent.click(screen.getByRole('button', { name: 'More hosts at once' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Timeout' }), { target: { value: '60' } })
    await act(async () => {
      fireEvent.click(runButton())
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls(invoke, 'runs:start')).toEqual([
      ['runs:start', { target: { kind: 'hosts', hostIds: ['h-stg-1'] }, command: { kind: 'text', text: 'uptime' }, concurrency: 5, timeoutSec: 60 }],
    ])
    // The new run is shown.
    expect(screen.getByRole('heading', { name: 'uptime' })).toBeInTheDocument()
  })

  it('the draft survives leaving the page and coming back', async () => {
    mockBridge({ 'snippets:list': [snippet] })
    inventoryStore.set({ products: [], environments: [prod, staging, audit], hosts: [...prodHosts, stg, ops], identities: [], vaults: [], regions: [] })
    stopSync = startOpsSync()
    render(
      <MemoryRouter initialEntries={['/ops/run']}>
        <Routes>
          <Route path="/ops/:tab" element={<OpsPage />} />
          <Route path="/terminals" element={<Link to="/ops/run">Back to Ops</Link>} />
        </Routes>
        <Link to="/terminals">Terminals</Link>
      </MemoryRouter>,
    )
    await flush()
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), { target: { value: 'frontend' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'web-2' }))
    typeCommand('uptime')
    fireEvent.change(screen.getByRole('combobox', { name: 'Timeout' }), { target: { value: '600' } })

    fireEvent.click(screen.getByRole('link', { name: 'Terminals' }))
    expect(screen.queryByRole('form', { name: 'New run' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Back to Ops' }))
    await flush()

    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('uptime')
    expect(screen.getByRole('radio', { name: 'Hosts' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('combobox', { name: 'Tag' })).toHaveValue('frontend')
    expect(screen.getByRole('checkbox', { name: 'web-2' })).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Timeout' })).toHaveValue('600')
    expect(within(screen.getByRole('list', { name: 'Target hosts' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['web-2'])

    // Another tab and back keeps it too.
    fireEvent.click(screen.getByRole('link', { name: 'Snippets' }))
    fireEvent.click(screen.getByRole('link', { name: 'Run' }))
    await flush()
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('uptime')
  })

  it('mod+enter in the command runs it', async () => {
    const { invoke } = await renderTab(startsRun(summary(['h-stg-1'])))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command' }), { key: 'Enter', metaKey: true })
    })
    expect(calls(invoke, 'runs:start')).toHaveLength(1)
  })

  it('a protected host outside the context still needs the name for a destructive command', async () => {
    const { invoke } = await renderTab(startsRun(summary(['h-db-1'])))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'db-1' }))
    typeCommand('uptime')
    // One prod host and a harmless command: no confirmation.
    expect(runButton()).toHaveTextContent(/^Run on 1 host$/)
    typeCommand('rm -rf /tmp/cache')
    expect(runButton()).toHaveTextContent('Run on 1 host…')
    fireEvent.click(runButton())
    await flush()
    expect(screen.getByRole('dialog', { name: 'Run on 1 host in prod?' })).toBeInTheDocument()
    expect(calls(invoke, 'runs:start')).toHaveLength(0)
  })

  it('hosts in two protected environments are refused with main’s message', async () => {
    expect(MULTIPLE_PROTECTED).toBe(MULTIPLE_PROTECTED_MESSAGE)
    const { invoke } = await renderTab()
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'db-1' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'ops-1' }))
    typeCommand('uptime')
    expect(screen.getByText(MULTIPLE_PROTECTED_MESSAGE)).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
    expect(calls(invoke, 'runs:start')).toHaveLength(0)
  })

  it('the mirror follows main: a protected context wins, else the protected memberships', () => {
    const envs = [prod, staging, audit]
    expect(runProtection(prod, envs, ['h-stg-1'], 2, false)).toEqual({ env: prod, needed: 'prod', refused: null })
    expect(runProtection(staging, envs, ['h-db-1', 'h-stg-1'], 2, false)).toEqual({ env: prod, needed: 'prod', refused: null })
    expect(runProtection(null, envs, ['h-stg-1'], 3, true)).toEqual({ env: null, needed: null, refused: null })
    expect(runProtection(null, envs, ['h-db-1'], 1, false)).toEqual({ env: prod, needed: null, refused: null })
    expect(runProtection(null, envs, ['h-db-1', 'h-ops-1'], 2, false).refused).toBe(MULTIPLE_PROTECTED_MESSAGE)
    // a protected context does not hide a second protected environment of the hosts
    expect(runProtection(prod, envs, ['h-db-1', 'h-ops-1'], 2, false).refused).toBe(MULTIPLE_PROTECTED_MESSAGE)
    expect(runProtection(prod, envs, ['h-db-1', 'h-db-2'], 2, false)).toEqual({ env: prod, needed: 'prod', refused: null })
  })

  it('a saved request is checked against the inventory as it is now', () => {
    const envs = [prod, staging, audit]
    const all = [...prodHosts, stg, ops]
    const base = { concurrency: 4, timeoutSec: 60 }
    const dbOnly = { ...base, target: { kind: 'environment' as const, environmentId: 'e-prod', role: 'db' as const }, command: { kind: 'text' as const, text: 'uptime' } }
    expect(requestProtection(dbOnly, envs, all, [])).toEqual({ env: prod, needed: 'prod', refused: null, labels: ['db-1', 'db-2'] })
    // prod is no longer protected.
    expect(requestProtection(dbOnly, [{ ...prod, protected: false }, staging, audit], all, []).needed).toBeNull()
    // A destructive snippet, or one that is gone, needs the name even for one host.
    const one = { ...base, target: { kind: 'hosts' as const, hostIds: ['h-db-1'] } }
    const restart = { ...snippet, destructive: true }
    expect(requestProtection({ ...one, command: { kind: 'snippet', snippetId: 's1', values: {} } }, envs, all, [restart]).needed).toBe('prod')
    expect(requestProtection({ ...one, command: { kind: 'snippet', snippetId: 'gone', values: {} } }, envs, all, [snippet]).needed).toBe('prod')
    expect(requestProtection({ ...one, command: { kind: 'text', text: 'uptime' } }, envs, all, [snippet]).needed).toBeNull()
  })

  it("main's refusal still shows as a toast", async () => {
    const { invoke } = await renderTab()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'runs:start') throw new Error(`Error invoking remote method 'runs:start': Error: ${encodeIpcError('confirm', 'Type the environment name to confirm')}`)
      if (channel === 'snippets:list' || channel === 'runs:list') return []
      return null
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.click(runButton())
    })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't start the run", description: 'Type the environment name to confirm', tone: 'error' }))
  })

  it('host chips follow run events and the summary counts settle', async () => {
    const ids = ['h-db-1', 'h-db-2', 'h-web-1', 'h-web-2', 'h-web-3']
    const run = summary(ids)
    await renderTab(startsRun(run))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    for (const l of ['db-1', 'db-2', 'web-1', 'web-2', 'web-3']) fireEvent.click(screen.getByRole('checkbox', { name: l }))
    typeCommand('uptime')
    fireEvent.click(runButton())
    await flush()
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox'), { target: { value: 'prod' } })
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run' }))
    })
    await send({ runId: 'r1', kind: 'run', run })
    expect(chip('db-1')).toHaveAttribute('data-state', 'queued')

    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-db-1', { state: 'connecting', startedAt: STAMP }) })
    expect(chip('db-1')).toHaveAttribute('data-state', 'connecting')
    expect(chip('db-1').querySelector('.od-pulse')).not.toBeNull()
    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-db-1', { state: 'running', startedAt: STAMP }) })
    expect(screen.getByText('1 running · 4 queued')).toBeInTheDocument()

    const final: Record<string, Partial<RunHostMeta>> = {
      'h-db-1': { state: 'ok', exitCode: 0 },
      'h-db-2': { state: 'failed', exitCode: 2 },
      'h-web-1': { state: 'ok', exitCode: 0 },
      'h-web-2': { state: 'ok', exitCode: 0 },
      'h-web-3': { state: 'cancelled' },
    }
    for (const id of ids) await send({ runId: 'r1', kind: 'host', host: hostMeta(id, { startedAt: STAMP, endedAt: STAMP, ...final[id] }) })
    expect(chip('db-1')).toHaveAttribute('data-state', 'ok')
    expect(chip('db-1').querySelector('.od-pulse')).toBeNull()
    expect(chip('db-2')).toHaveAttribute('data-state', 'failed')
    expect(chip('db-2')).toHaveTextContent('exit 2')
    expect(screen.getByText('3 ok · 1 failed · 1 cancelled')).toBeInTheDocument()

    // Failed hosts come first and open; the others stay closed until clicked.
    const panes = screen.getAllByRole('button', { name: /output$/ })
    expect(panes[0]).toHaveAccessibleName('db-2 output')
    expect(panes[0]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'web-1 output' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip('web-1'))
    expect(screen.getByRole('button', { name: 'web-1 output' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('log', { name: 'Output of web-1' })).toBeInTheDocument()
  })

  it('output streams into the open pane', async () => {
    const run = summary(['h-stg-1'])
    await renderTab(startsRun(run))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.click(runButton())
    })
    await send({ runId: 'r1', kind: 'output', hostId: 'h-stg-1', chunk: 'up 3 days\n', end: 10 })
    await send({ runId: 'r1', kind: 'output', hostId: 'h-stg-1', chunk: 'warn\n', stream: 'err', end: 15 })
    const log = screen.getByRole('log', { name: 'Output of stg-1' })
    expect(log.textContent).toBe('up 3 days\nwarn\n')
    expect(log.querySelector('[data-stream="err"]')).toHaveTextContent('warn')

    // Interleaved: one stream, each line under its host's label.
    fireEvent.click(screen.getByRole('radio', { name: 'Interleaved' }))
    const all = screen.getByRole('log', { name: 'Output of all hosts' })
    expect(all.textContent).toBe('stg-1 │ up 3 days\nstg-1 │ warn\n')
    await send({ runId: 'r1', kind: 'output', hostId: 'h-stg-1', chunk: 'done\n', end: 20 })
    expect(all.textContent).toBe('stg-1 │ up 3 days\nstg-1 │ warn\nstg-1 │ done\n')
  })

  it('cancel calls runs:cancel and the button becomes Run again when done', async () => {
    const run = summary(['h-stg-1'], { title: 'sleep 100' })
    const { invoke } = await renderTab({ ...startsRun(run), 'runs:cancel': run })
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('sleep 100')
    await act(async () => {
      fireEvent.click(runButton())
    })
    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-stg-1', { state: 'running', startedAt: STAMP }) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(calls(invoke, 'runs:cancel')).toEqual([['runs:cancel', 'r1']])

    const cancelled = { ...run, state: 'cancelled' as const, endedAt: STAMP, hosts: [hostMeta('h-stg-1', { state: 'cancelled', startedAt: STAMP, endedAt: STAMP })] }
    await send({ runId: 'r1', kind: 'run', run: cancelled })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Cancelled (the command may still be running on the host)').length).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    })
    expect(calls(invoke, 'runs:start')).toHaveLength(2)
    expect(calls(invoke, 'runs:start')[1]).toEqual(calls(invoke, 'runs:start')[0])
  })

  it('recent runs reopen and dismiss', async () => {
    const older = summary(['h-stg-1'], { id: 'r0', title: 'df -h', state: 'done', endedAt: STAMP, hosts: [hostMeta('h-stg-1', { state: 'ok', exitCode: 0 })] })
    const { invoke } = await renderTab({ 'runs:list': [older], 'runs:get': { run: older, output: [{ hostId: 'h-stg-1', text: 'disk\n', errRanges: [], total: 5 }] } })
    const recent = screen.getByRole('list', { name: 'Recent runs' })
    fireEvent.click(within(recent).getByRole('button', { name: /^df -h/ }))
    await flush()
    expect(screen.getByRole('heading', { name: 'df -h' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Output of stg-1' })).toHaveTextContent('disk')

    await act(async () => {
      fireEvent.click(within(recent).getByRole('button', { name: 'Dismiss df -h' }))
    })
    expect(calls(invoke, 'runs:dismiss')).toEqual([['runs:dismiss', 'r0']])
    expect(within(screen.getByRole('list', { name: 'Recent runs' })).queryByText('df -h')).not.toBeInTheDocument()
  })

  it('reduced motion: no pulse class and no layout animation on chips', async () => {
    const run = summary(['h-stg-1'])
    await renderTab(startsRun(run))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.click(runButton())
    })
    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-stg-1', { state: 'running', startedAt: STAMP }) })
    expect(chip('stg-1').querySelector('.od-pulse')).not.toBeNull()
    expect(chip('stg-1').closest('li')).toHaveAttribute('data-layout')
    cleanup()
    stopSync?.()
    resetOps()

    motion.safe = false
    await renderTab({ 'runs:list': [summary(['h-stg-1'], { hosts: [hostMeta('h-stg-1', { state: 'running', startedAt: STAMP })] })], 'runs:get': { run, output: [] } })
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
    await flush()
    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-stg-1', { state: 'running', startedAt: STAMP }) })
    expect(chip('stg-1')).toHaveAttribute('data-state', 'running')
    expect(chip('stg-1').querySelector('.od-pulse')).toBeNull()
    expect(chip('stg-1').closest('li')).not.toHaveAttribute('data-layout')
  })

  it('toasts a finished run only while the Ops page is not showing, whichever tab is open', async () => {
    const run = summary(['h-db-1', 'h-db-2', 'h-web-1', 'h-web-2', 'h-web-3'])
    const done = (r: RunSummary): RunSummary => ({
      ...r,
      state: 'done',
      endedAt: STAMP,
      hosts: r.hosts.map((h) => ({ ...h, state: h.hostId === 'h-db-2' ? 'failed' : 'ok', exitCode: h.hostId === 'h-db-2' ? 1 : 0 })),
    })
    mockBridge({ 'snippets:list': [snippet] })
    inventoryStore.set({ products: [], environments: [prod, staging, audit], hosts: [...prodHosts, stg, ops], identities: [], vaults: [], regions: [] })
    stopSync = startOpsSync()
    const { unmount } = render(
      <MemoryRouter initialEntries={['/ops/snippets']}>
        <Routes>
          <Route path="/ops/:tab" element={<OpsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await flush()
    await send({ runId: 'r1', kind: 'run', run })
    await send({ runId: 'r1', kind: 'run', run: done(run) })
    expect(toast).not.toHaveBeenCalled()

    unmount()
    const again = { ...run, id: 'r2' }
    await send({ runId: 'r2', kind: 'run', run: again })
    await send({ runId: 'r2', kind: 'run', run: done(again) })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Run finished: 4 ok, 1 failed (db-2)' }))
    // A finished run seen for the first time (the list on mount) is not news.
    await send({ runId: 'r3', kind: 'run', run: done({ ...run, id: 'r3' }) })
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it("the start reply doesn't undo events that came before it", async () => {
    const run = summary(['h-stg-1'])
    const { invoke } = await renderTab(startsRun(run))
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      // Main sends the first events before it replies, with the queued snapshot.
      if (channel === 'runs:start') {
        emitBridgeEvent('run:event', { runId: 'r1', kind: 'run', run: { ...run, hosts: [hostMeta('h-stg-1', { state: 'connecting', startedAt: STAMP })] } })
        return run
      }
      // The snapshot load is still out, so only the events and the reply have been seen.
      if (channel === 'runs:get') return new Promise(() => {})
      return (base as (...a: unknown[]) => unknown)(channel, ...args)
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.click(runButton())
    })
    expect(chip('stg-1')).toHaveAttribute('data-state', 'connecting')
  })

  it('says a command may still be running only for hosts that had started it', async () => {
    const run = summary(['h-db-1', 'h-db-2', 'h-web-1'], {
      state: 'cancelled',
      endedAt: STAMP,
      hosts: [
        hostMeta('h-db-1', { state: 'timeout', startedAt: STAMP, endedAt: STAMP }),
        hostMeta('h-db-2', { state: 'cancelled', startedAt: STAMP, endedAt: STAMP }),
        hostMeta('h-web-1', { state: 'cancelled', endedAt: STAMP }),
      ],
    })
    await renderTab({ 'runs:list': [run], 'runs:get': { run, output: [] } })
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
    await flush()
    for (const l of ['db-2', 'web-1']) fireEvent.click(screen.getByRole('button', { name: `${l} output` }))
    const pane = (l: string) => screen.getByRole('button', { name: `${l} output` }).closest('li')!
    expect(within(pane('db-1')).getByText('Timed out (the command may still be running on the host)')).toBeInTheDocument()
    expect(within(pane('db-2')).getByText('Cancelled (the command may still be running on the host)')).toBeInTheDocument()
    expect(within(pane('web-1')).queryByText(/may still be running/)).not.toBeInTheDocument()

    // A run cancelled before any host started says nothing of the kind.
    cleanup()
    stopSync?.()
    resetOps()
    const early = { ...run, id: 'r2', hosts: [hostMeta('h-web-1', { state: 'cancelled', endedAt: STAMP })] }
    await renderTab({ 'runs:list': [early], 'runs:get': { run: early, output: [] } })
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
    await flush()
    expect(screen.queryByText(/may still be running/)).not.toBeInTheDocument()
  })

  it('recent runs never hide a running run behind finished ones', async () => {
    const minute = (i: number) => new Date(Date.UTC(2026, 9, 19, 9, i)).toISOString()
    const finished = Array.from({ length: MAX_RUNS_KEPT }, (_, i) =>
      summary(['h-stg-1'], { id: `f${i}`, title: `job ${i}`, state: 'done', startedAt: minute(30 - i), endedAt: minute(30 - i) }),
    )
    const long = summary(['h-stg-1'], { id: 'long', title: 'backup', startedAt: minute(0) })
    await renderTab({ 'runs:list': [...finished, long], 'runs:get': { run: long, output: [] } })
    const rows = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole('listitem')
    expect(rows).toHaveLength(MAX_RUNS_KEPT + 1)
    expect(rows[0]).toHaveTextContent('backup')
  })

  it('Run again checks protection as it is now', async () => {
    const run = summary(['h-stg-1'], { title: 'reboot' })
    const { invoke } = await renderTab(startsRun(run))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('reboot')
    await act(async () => {
      fireEvent.click(runButton())
    })
    expect(calls(invoke, 'runs:start')).toHaveLength(1)
    await send({ runId: 'r1', kind: 'run', run: { ...run, state: 'done', endedAt: STAMP, hosts: [hostMeta('h-stg-1', { state: 'ok', exitCode: 0 })] } })

    // staging became protected since: a destructive command there needs its name.
    act(() => inventoryStore.set({ ...inventoryStore.get()!, environments: [prod, { ...staging, protected: true }, audit] }))
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'Run on 1 host in staging?' })
    expect(calls(invoke, 'runs:start')).toHaveLength(1)
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type staging to confirm' }), { target: { value: 'staging' } })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }))
    })
    expect(calls(invoke, 'runs:start')[1]).toEqual(['runs:start', { ...(calls(invoke, 'runs:start')[0][1] as object), confirm: 'staging' }])
  })

  it('Run again checks the rendered text of a snippet, so a value that makes it destructive needs the name', async () => {
    const bare: SnippetMeta = { ...snippet, id: 's2', label: 'Anything', script: '{{cmd}}', variables: [{ name: 'cmd', default: null }] }
    const done = { ...summary(['h-stg-1']), id: 'r9', state: 'done' as const, endedAt: STAMP, hosts: [hostMeta('h-stg-1', { state: 'ok', exitCode: 0 })] }
    const { invoke } = await renderTab({
      'snippets:list': [bare],
      'snippets:render': 'rm -rf /tmp/old',
      'runs:list': [done],
      'runs:get': { run: done, output: [] },
    })
    rememberRequest('r9', {
      target: { kind: 'hosts', hostIds: ['h-stg-1'] },
      command: { kind: 'snippet', snippetId: 's2', values: { cmd: 'rm -rf /tmp/old' } },
      concurrency: 4,
      timeoutSec: 600,
    } as never)
    act(() => inventoryStore.set({ ...inventoryStore.get()!, environments: [prod, { ...staging, protected: true }, audit] }))
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await flush()
    expect(calls(invoke, 'snippets:render').at(-1)).toEqual(['snippets:render', 's2', { cmd: 'rm -rf /tmp/old' }])
    expect(screen.getByRole('dialog', { name: 'Run on 1 host in staging?' })).toBeTruthy()
    expect(calls(invoke, 'runs:start')).toHaveLength(0)
  })

  it("main's typed-name refusal opens the confirmation instead of a toast", async () => {
    const invoke = mockBridge({ 'snippets:list': [] })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'runs:start') throw new Error(`Error invoking remote method 'runs:start': Error: ${encodeIpcError('confirm', 'Type the environment name to confirm')}`)
      return channel === 'snippets:list' ? [] : null
    })
    inventoryStore.set({ products: [], environments: [prod, staging, audit], hosts: [...prodHosts, stg, ops], identities: [], vaults: [], regions: [] })
    const onConfirm = vi.fn()
    await launch(
      { target: { kind: 'hosts', hostIds: ['h-web-1'], environmentId: 'e-prod' }, command: { kind: 'text', text: 'uptime' }, concurrency: 4, timeoutSec: 600 } as never,
      onConfirm,
    )
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Run on 1 host in prod?', typeToConfirm: 'prod' }))
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('the same words without main\'s confirm code are an ordinary failure, not a confirmation', async () => {
    const invoke = mockBridge({ 'snippets:list': [] })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'runs:start') throw new Error("Error invoking remote method 'runs:start': Error: Type the environment name to confirm")
      return channel === 'snippets:list' ? [] : null
    })
    inventoryStore.set({ products: [], environments: [prod, staging, audit], hosts: [...prodHosts, stg, ops], identities: [], vaults: [], regions: [] })
    const onConfirm = vi.fn()
    await launch(
      { target: { kind: 'hosts', hostIds: ['h-web-1'], environmentId: 'e-prod' }, command: { kind: 'text', text: 'uptime' }, concurrency: 4, timeoutSec: 600 } as never,
      onConfirm,
    )
    expect(onConfirm).not.toHaveBeenCalled()
    expect(calls(invoke, 'runs:start')).toHaveLength(1)
  })

  it("a finished host's check doesn't pop when the run is reopened, only when it finishes in view", async () => {
    const run = summary(['h-stg-1'])
    const done = { ...run, state: 'done' as const, endedAt: STAMP, hosts: [hostMeta('h-stg-1', { state: 'ok', exitCode: 0, startedAt: STAMP, endedAt: STAMP })] }
    await renderTab({ 'runs:list': [done, { ...run, id: 'r2', title: 'live' }], 'runs:get': { run: done, output: [] } })
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
    await flush()
    expect(chip('stg-1').querySelector('[data-initial="false"]')).not.toBeNull()

    cleanup()
    stopSync?.()
    resetOps()
    await renderTab(startsRun(run))
    fireEvent.click(screen.getByRole('radio', { name: 'Hosts' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'stg-1' }))
    typeCommand('uptime')
    await act(async () => {
      fireEvent.click(runButton())
    })
    await send({ runId: 'r1', kind: 'host', host: hostMeta('h-stg-1', { state: 'ok', exitCode: 0, startedAt: STAMP, endedAt: STAMP }) })
    expect(chip('stg-1')).toHaveAttribute('data-state', 'ok')
    expect(chip('stg-1').querySelector('[data-initial="false"]')).toBeNull()
  })

  it('clicking a chip scrolls its pane into view, without smooth scrolling under reduced motion', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      motion.safe = false
      const run = summary(['h-stg-1', 'h-ops-1'])
      await renderTab({ 'runs:list': [run], 'runs:get': { run, output: [] } })
      fireEvent.click(within(screen.getByRole('list', { name: 'Recent runs' })).getByRole('button', { name: /^uptime/ }))
      await flush()
      fireEvent.click(chip('ops-1'))
      await tick(50)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})
