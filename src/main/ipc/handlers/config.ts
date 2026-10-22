import { randomBytes } from 'node:crypto'
import { readFile as readFileFs, stat } from 'node:fs/promises'
import { CONFIG_MAX_BYTES, parseConfigFile, type ConfigFile, type ConfigSegment } from '../../../shared/config-file'
import type { Handlers } from '../../../shared/ipc'
import { exportConfig, type ConfigExportDeps } from '../../config/export'
import { CHANGED_MESSAGE, applyImport, planImport } from '../../config/import'

/** How long a preview can be applied for. */
export const IMPORT_TTL_MS = 10 * 60_000
export const EXPIRED_MESSAGE = 'The preview expired; open the file again'

export function createConfigHandlers(
  deps: ConfigExportDeps & {
    /** `dialog.showSaveDialog`, injected; undefined when cancelled. `segment` names the default file. */
    saveDialog: (segment?: ConfigSegment) => Promise<string | undefined>
    /** `dialog.showOpenDialog` for one JSON file, injected; undefined when cancelled. */
    openDialog: () => Promise<string | undefined>
    readFile?: (path: string) => Promise<string>
    /** After an import commits, with the environments it changed. */
    onImported?: (environmentIds: string[]) => void
  },
): Pick<Handlers, 'config:export' | 'config:importOpen' | 'config:importApply' | 'config:importDiscard'> {
  const readFile = deps.readFile ?? ((path: string) => readFileFs(path, 'utf8'))
  // One preview at a time: the parsed file stays in main, the renderer only holds the token.
  // A page's preview is applied or discarded from that page only.
  let held: {
    token: string
    file: ConfigFile
    counts: ReturnType<typeof planImport>['counts']
    segment: ConfigSegment | undefined
    expires: number
  } | null = null
  const holds = (token: string, segment: ConfigSegment | undefined): boolean => held?.token === token && held.segment === segment

  return {
    'config:export': async (segment) => {
      // Locked: refuse before asking where to save.
      deps.vault.assertUnlocked()
      const path = await deps.saveDialog(segment)
      if (!path) return null
      const { counts, omitted } = await exportConfig(deps, path, segment)
      return { path, counts, omitted }
    },
    'config:importOpen': async (segment) => {
      deps.vault.assertUnlocked()
      const path = await deps.openDialog()
      if (!path) return null
      held = null
      let text: string
      try {
        // Sized before it is read, so a huge file is never loaded.
        if ((await stat(path)).size > CONFIG_MAX_BYTES) return { errors: ['The file is larger than 5 MB'] }
        text = await readFile(path)
      } catch {
        return { errors: ["Couldn't read the file"] }
      }
      const parsed = parseConfigFile(text)
      if (!parsed.ok) return { errors: parsed.errors }
      let plan: ReturnType<typeof planImport>
      try {
        plan = planImport(deps.db, parsed.file, segment)
      } catch (e) {
        return { errors: [e instanceof Error ? e.message : String(e)] }
      }
      const token = randomBytes(16).toString('hex')
      held = { token, file: parsed.file, counts: plan.counts, segment, expires: deps.now().getTime() + IMPORT_TTL_MS }
      return { token, ...plan }
    },
    'config:importApply': async (token, { typedNames, regionId }, segment) => {
      const h = held
      if (!h || !holds(token, segment) || deps.now().getTime() > h.expires) throw new Error(EXPIRED_MESSAGE)
      let res: ReturnType<typeof applyImport>
      try {
        res = applyImport({ ...deps, onChanged: deps.onImported }, h.file, { typedNames, regionId, expected: h.counts, segment })
      } catch (e) {
        // A changed config can't match this preview again; a missing typed name can be retried.
        if (e instanceof Error && e.message === CHANGED_MESSAGE) held = null
        throw e
      }
      held = null
      return res
    },
    'config:importDiscard': async (token, segment) => {
      if (holds(token, segment)) held = null
    },
  }
}
