import type { AiRequests } from '../../ai/claude'
import type { SettingsStore } from '../../settings/settings-store'
import type { Handlers } from '../../../shared/ipc'

export interface AiHandlerDeps {
  settings: Pick<SettingsStore, 'status'>
  requests: Pick<AiRequests, 'cancel'>
}

export function createAiHandlers(deps: AiHandlerDeps): Pick<Handlers, 'ai:status' | 'ai:cancel'> {
  return {
    'ai:status': () => deps.settings.status().ai,
    'ai:cancel': (requestId) => deps.requests.cancel(requestId),
  }
}
