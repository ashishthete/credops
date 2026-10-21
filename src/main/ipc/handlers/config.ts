import type { Handlers } from '../../../shared/ipc'
import { exportConfig, type ConfigExportDeps } from '../../config/export'

export function createConfigHandlers(
  deps: ConfigExportDeps & {
    /** `dialog.showSaveDialog`, injected; undefined when cancelled. */
    saveDialog: () => Promise<string | undefined>
  },
): Pick<Handlers, 'config:export'> {
  return {
    'config:export': async () => {
      // Locked: refuse before asking where to save.
      deps.vault.assertUnlocked()
      const path = await deps.saveDialog()
      if (!path) return null
      const { counts, omitted } = await exportConfig(deps, path)
      return { path, counts, omitted }
    },
  }
}
