import type { AiRequests } from '../../ai/claude'
import { generateNotes, type NotesDeps } from '../../ai/release-notes'
import type { SettingsStore } from '../../settings/settings-store'
import type { Handlers } from '../../../shared/ipc'

export interface AiHandlerDeps {
  settings: Pick<SettingsStore, 'status'>
  requests: Pick<AiRequests, 'start' | 'finish' | 'cancel'>
  notes: NotesDeps
  /** Pushes `ai:delta` to the renderer. */
  onDelta: (delta: { requestId: string; text: string }) => void
}

export function createAiHandlers(deps: AiHandlerDeps): Pick<Handlers, 'ai:status' | 'ai:cancel' | 'ai:releaseNotes'> {
  return {
    'ai:status': () => deps.settings.status().ai,
    'ai:cancel': (requestId) => deps.requests.cancel(requestId),
    'ai:releaseNotes': async (requestId, req) => {
      const { signal } = deps.requests.start(requestId)
      try {
        return await generateNotes(req, {
          ...deps.notes,
          requestId,
          trigger: 'editor',
          signal,
          onText: (text) => deps.onDelta({ requestId, text }),
        })
      } finally {
        deps.requests.finish(requestId)
      }
    },
  }
}
