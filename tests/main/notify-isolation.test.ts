import { describe, expect, it, vi } from 'vitest'
import type { ReleaseRunMeta } from '../../src/main/deploy/finalize'
import { NotificationDispatcher } from '../../src/main/notify/dispatcher'
import type { NotificationSink } from '../../src/main/notify/sink'
import type { ReleaseService } from '../../src/main/deploy/release-service'
import type { ReleaseApi } from '../../src/main/hub/runner'
import { wireLocalNotify } from '../../src/main/notify/wire-local'
import { IntegrationStore } from '../../src/main/settings/integration-store'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import type { RunEvent } from '../../src/shared/deploy'
import { NOTIFY_EVENTS } from '../../src/shared/settings'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture } from './deploy-helpers'

/** A release source with a way to push batches through it, like ReleaseService.onEvent. */
function source() {
  const fns = new Set<(batch: RunEvent[]) => void>()
  return {
    onEvent: (fn: (batch: RunEvent[]) => void) => {
      fns.add(fn)
      return () => void fns.delete(fn)
    },
    emit: (batch: RunEvent[]) => fns.forEach((fn) => fn(batch)),
  }
}

/** The wiring takes the nominal local service; a scripted source stands in for it. */
const asLocal = (s: { onEvent: ReleaseService['onEvent'] }): ReleaseService => s as unknown as ReleaseService

async function rig() {
  const f = await makeDeployFixture()
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard: { async writeText() {}, async readText() { return '' } } })
  const settings = new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const integrations = new IntegrationStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const hook = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'hook', kind: 'webhook', value: 'https://x.webhook.office.com/abc/PATH' })
  integrations.update(f.staging.id, { teamsWebhookSecretId: hook.id, notifyEvents: [...NOTIFY_EVENTS] })
  const sink = { teams: vi.fn(async () => undefined), email: vi.fn(async () => undefined), macos: vi.fn() } satisfies NotificationSink
  const meta = (id: string): ReleaseRunMeta => ({
    id,
    releaseId: id,
    kind: 'release',
    status: 'failed',
    environmentId: f.staging.id,
    environmentName: 'staging',
    productId: null,
    productName: 'shop',
    deployments: [{ id: 'd1', name: 'api', hostId: f.host.id, hostLabel: 'app1', status: 'failed', previousCommit: null, deployedCommit: null }],
    hostIds: [f.host.id],
    version: '1.2.0',
    previousVersion: '1.1.0',
    commits: [],
    options: { backup: true, notify: true, qa: false },
    releaseNotes: null,
    redeploy: false,
    startedAt: '2026-10-19T11:58:00.000Z',
    finishedAt: '2026-10-19T12:00:05.000Z',
    actor: { osUser: 'tester', machine: 'box' },
    urls: [],
  })
  const dispatcher = new NotificationDispatcher({
    db: f.db,
    sink,
    integrations,
    settings,
    vault: f.vault,
    audit: f.audit,
    runs: { runMeta: (id) => meta(id) },
    tunnels: f.tunnels,
  })
  const onRun = vi.spyOn(dispatcher, 'onRunEvent')
  const failed = (runId: string): RunEvent => ({ id: `e-${runId}`, runId, seq: 1, at: '2026-10-19T12:00:05.000Z', type: 'run.finished', status: 'failed', error: 'boom' })
  return { sink, dispatcher, onRun, failed }
}

describe('desktop notification isolation (decision 11)', () => {
  it('a Hub-routed release never reaches the desktop dispatcher or any of its sinks', async () => {
    const { sink, dispatcher, onRun, failed } = await rig()
    const local = source()
    const hub = source()
    wireLocalNotify(asLocal(local), dispatcher)

    // The Hub's own stream is not the local service's: nothing it carries is a desktop notification.
    hub.emit([failed('hub-rel')])
    await new Promise((r) => setTimeout(r, 20))
    expect(onRun).not.toHaveBeenCalled()
    expect(sink.teams).not.toHaveBeenCalled()
    expect(sink.email).not.toHaveBeenCalled()
    expect(sink.macos).not.toHaveBeenCalled()

    // Control: the same event from the local service does flow, so the assertions above can fail.
    local.emit([failed('local-rel')])
    await vi.waitFor(() => expect(sink.macos).toHaveBeenCalled())
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(sink.teams).toHaveBeenCalled()
  })

  it('wiring the dispatcher to a source that also carries Hub events would be caught', async () => {
    // What a routed onEvent (local and Hub together) would do: the test shows the leak is observable.
    const { sink, dispatcher, onRun, failed } = await rig()
    const local = source()
    const hub = source()
    wireLocalNotify(asLocal({ onEvent: (fn) => { const a = local.onEvent(fn); const b = hub.onEvent(fn); return () => { a(); b() } } }), dispatcher)
    hub.emit([failed('hub-rel')])
    await vi.waitFor(() => expect(onRun).toHaveBeenCalled())
    await vi.waitFor(() => expect(sink.macos).toHaveBeenCalled())
  })

  it('the routing ReleaseApi is rejected by the type, so index.ts cannot wire it', async () => {
    const { dispatcher } = await rig()
    const routed = source() as unknown as ReleaseApi
    // @ts-expect-error ReleaseService is nominal (private members); the routing API also carries Hub releases.
    const off = wireLocalNotify(routed, dispatcher)
    off()
  })
})
