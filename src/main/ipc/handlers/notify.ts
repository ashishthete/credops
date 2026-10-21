import type { AuditLog } from '../../audit/audit-log'
import type { Db } from '../../db/connection'
import { listNotifications } from '../../notify/log'
import type { MacNotifier } from '../../notify/macos'
import type { NotificationSink } from '../../notify/sink'
import type { QaDispatcher } from '../../notify/qa'
import type { NotificationFacts } from '../../notify/teams'
import type { IntegrationStore } from '../../settings/integration-store'
import type { SettingsStore } from '../../settings/settings-store'
import type { NotifyLogFilter, NotifyTestTarget } from '../../../shared/settings'
import type { Handlers } from '../../../shared/ipc'

export const TEST_TITLE = 'Test from OpsDeck'

export interface NotifyHandlerDeps {
  db: Db
  sink: NotificationSink
  settings: SettingsStore
  integrations: IntegrationStore
  audit: AuditLog
  actor: { osUser: string; machine: string }
  now?: () => Date
  /** The macOS notifier, for the test alert (shown even though no event routed it). */
  mac: Pick<MacNotifier, 'supported' | 'raw'>
}

export function testFacts(environment: NotificationFacts['environment'], actor: string, at: string): NotificationFacts {
  return {
    event: 'release.succeeded',
    title: TEST_TITLE,
    environment,
    product: null,
    deployment: null,
    hosts: [],
    status: 'succeeded',
    version: null,
    durationSec: null,
    urls: [],
    actor,
    at,
  }
}

export function createNotifyHandlers(d: NotifyHandlerDeps): Pick<Handlers, 'notify:test' | 'notify:log'> {
  const now = d.now ?? (() => new Date())
  const actor = `${d.actor.osUser}@${d.actor.machine}`
  const mac = d.mac

  return {
    'notify:test': async (target: NotifyTestTarget) => {
      let targetFields: { targetType: 'environment'; targetId: string; targetLabel: string } | Record<string, never> = {}
      try {
        if (target.channel === 'macos') {
          if (!d.settings.get().macos) throw new Error('macOS notifications are turned off')
          if (!mac.supported()) throw new Error('macOS notifications are not supported here')
          mac.raw(TEST_TITLE, 'Notifications from OpsDeck will look like this.', true, '#/settings')
        } else {
          const name = d.integrations.environmentName(target.environmentId)
          targetFields = { targetType: 'environment', targetId: target.environmentId, targetLabel: name }
          const facts = testFacts({ name, color: '', protected: false }, actor, now().toISOString())
          if (target.channel === 'teams') await d.sink.teams(target.environmentId, facts)
          else await d.sink.email(target.environmentId, facts, null, { subject: TEST_TITLE })
        }
      } catch (e) {
        d.audit.append({
          action: 'notify.test',
          outcome: 'failure',
          ...targetFields,
          details: { channel: target.channel, reason: e instanceof Error ? e.message : String(e) },
        })
        throw e
      }
      d.audit.append({
        action: 'notify.test',
        outcome: 'success',
        ...targetFields,
        details: { channel: target.channel },
      })
    },
    'notify:log': (filter: NotifyLogFilter) => listNotifications(d.db, filter),
  }
}

export function createQaHandlers(d: {
  qa: Pick<QaDispatcher, 'dispatch' | 'watch' | 'list'>
  integrations: Pick<IntegrationStore, 'forEnvironment'>
}): Pick<Handlers, 'qa:dispatch' | 'qa:list'> {
  return {
    'qa:dispatch': async (environmentId: string) => {
      const item = await d.qa.dispatch(environmentId, { trigger: 'manual' })
      if (d.integrations.forEnvironment(environmentId).qaWait) d.qa.watch(item)
      return item
    },
    'qa:list': () => d.qa.list(),
  }
}
