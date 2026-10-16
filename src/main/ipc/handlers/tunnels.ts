import type { Handlers } from '../../../shared/ipc'
import type { TunnelStore } from '../../tunnels/tunnel-store'

type TunnelChannel = 'tunnel:list' | 'tunnel:create' | 'tunnel:update' | 'tunnel:delete'

export function createTunnelHandlers(deps: { store: TunnelStore }): Pick<Handlers, TunnelChannel> {
  const { store } = deps
  return {
    'tunnel:list': () => store.list(),
    'tunnel:create': (input) => store.create(input),
    'tunnel:update': (id, patch) => store.update(id, patch),
    'tunnel:delete': (id) => store.delete(id),
  }
}
