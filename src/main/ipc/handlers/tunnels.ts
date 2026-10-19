import type { Handlers } from '../../../shared/ipc'
import type { TunnelManager } from '../../tunnels/manager'
import type { TunnelStore } from '../../tunnels/tunnel-store'

type TunnelChannel = 'tunnel:list' | 'tunnel:create' | 'tunnel:update' | 'tunnel:delete' | 'tunnel:start' | 'tunnel:stop' | 'tunnel:status'

export type TunnelApi = Pick<TunnelManager, 'start' | 'stop' | 'status'>

export function createTunnelHandlers(deps: { store: TunnelStore; manager: TunnelApi }): Pick<Handlers, TunnelChannel> {
  const { store, manager } = deps
  return {
    'tunnel:list': () => store.list(),
    'tunnel:create': (input) => store.create(input),
    'tunnel:update': (id, patch) => store.update(id, patch),
    'tunnel:delete': (id) => store.delete(id),
    'tunnel:start': (id) => manager.start(id),
    'tunnel:stop': (id) => manager.stop(id),
    'tunnel:status': () => manager.status(),
  }
}
