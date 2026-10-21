import type { Handlers } from '../../../shared/ipc'
import type { IntegrationStore } from '../../settings/integration-store'
import type { SettingsStore } from '../../settings/settings-store'

type SettingsChannel = 'settings:get' | 'settings:update' | 'settings:status' | 'integration:get' | 'integration:update'

export function createSettingsHandlers(deps: { settings: SettingsStore; integrations: IntegrationStore }): Pick<Handlers, SettingsChannel> {
  const { settings, integrations } = deps
  return {
    'settings:get': () => settings.get(),
    'settings:update': (patch) => settings.update(patch),
    'settings:status': () => settings.status(),
    'integration:get': (environmentId) => integrations.get(environmentId),
    'integration:update': (environmentId, patch) => integrations.update(environmentId, patch),
  }
}
