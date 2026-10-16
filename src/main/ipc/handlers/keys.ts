import type { Handlers } from '../../../shared/ipc'
import type { KeyStore } from '../../vault/key-store'

type KeyChannel =
  | 'key:list'
  | 'key:scanLocal'
  | 'key:link'
  | 'key:import'
  | 'key:importFile'
  | 'key:generate'
  | 'key:update'
  | 'key:delete'
  | 'key:copyPublic'

export function createKeyHandlers(
  keys: KeyStore,
  deps: { openDialog: (dir: string) => Promise<string | undefined> },
): Pick<Handlers, KeyChannel> {
  return {
    'key:list': (vaultId) => keys.list(vaultId),
    'key:scanLocal': () => keys.scanLocal(),
    'key:link': (input) => keys.link(input),
    'key:import': (input) => keys.import(input),
    // Main picks and reads the file, so the key text never passes through the renderer.
    'key:importFile': async (input) => {
      const path = await deps.openDialog(keys.sshDir)
      return path === undefined ? null : keys.importFile(input, path)
    },
    'key:generate': (input) => keys.generate(input),
    'key:update': (id, patch) => keys.update(id, patch),
    'key:delete': (id) => keys.delete(id),
    'key:copyPublic': (id) => keys.copyPublic(id),
  }
}
