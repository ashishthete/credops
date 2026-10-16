import type { AppInfo, Handlers } from '../../../shared/ipc'

export function createAppHandlers(info: () => AppInfo): Pick<Handlers, 'app:info'> {
  return { 'app:info': () => info() }
}
