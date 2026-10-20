import type { AiRequests } from '../../ai/claude'
import { explain, recordCommand, type ExplainDeps, type ExplainMemory } from '../../ai/explain'
import { generateNotes, type NotesDeps } from '../../ai/release-notes'
import type { SettingsStore } from '../../settings/settings-store'
import type { Handlers } from '../../../shared/ipc'

export interface AiHandlerDeps {
  settings: Pick<SettingsStore, 'status'>
  requests: Pick<AiRequests, 'start' | 'finish' | 'cancel'>
  notes: NotesDeps
  explain: Omit<ExplainDeps, 'signal'> & { memory: ExplainMemory }
  /** Pushes `ai:delta` to the renderer. */
  onDelta: (delta: { requestId: string; text: string }) => void
}

export function createAiHandlers(deps: AiHandlerDeps): Pick<Handlers, 'ai:status' | 'ai:cancel' | 'ai:releaseNotes' | 'ai:explain' | 'ai:command'> {
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
    'ai:explain': async (requestId, subject) => {
      const { signal } = deps.requests.start(requestId)
      try {
        const out = await explain(requestId, subject, { ...deps.explain, signal })
        deps.explain.memory.remember(out)
        return out
      } finally {
        deps.requests.finish(requestId)
      }
    },
    // Main never writes the command anywhere: the renderer runs it after the user confirms; this only audits.
    'ai:command': (requestId, index, mode) => void recordCommand(deps.explain, requestId, index, mode),
  }
}
