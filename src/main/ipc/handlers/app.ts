import type { AppInfo, Handlers } from '../../../shared/ipc'

export interface DiagnosticsDeps {
  /** The redacted support bundle (see diagnostics/bundle). */
  build: () => string
  writeClipboard: (text: string) => void
  /** Shows the log file in the OS file manager. */
  revealLog: () => void
}

export function createAppHandlers(
  info: () => AppInfo,
  diagnostics: DiagnosticsDeps,
): Pick<Handlers, 'app:info' | 'app:copyDiagnostics' | 'app:revealLog'> {
  return {
    'app:info': () => info(),
    'app:copyDiagnostics': () => {
      const text = diagnostics.build()
      diagnostics.writeClipboard(text)
      return { chars: text.length }
    },
    'app:revealLog': () => diagnostics.revealLog(),
  }
}
