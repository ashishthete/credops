import type { Handlers } from '../../../shared/ipc'
import type { SshImporter } from '../../inventory/ssh-import'

export function createSshImportHandlers(importer: SshImporter): Pick<Handlers, 'sshconfig:preview' | 'sshconfig:import'> {
  return {
    'sshconfig:preview': () => importer.preview(),
    'sshconfig:import': (req) => importer.import(req),
  }
}
