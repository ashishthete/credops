import type { Handlers } from '../../../shared/ipc'
import type { HostStore } from '../../inventory/host-store'

type InventoryChannel = 'host:list' | 'host:create' | 'host:update' | 'host:delete' | 'host:setVaults'

export function createInventoryHandlers(deps: { hosts: HostStore }): Pick<Handlers, InventoryChannel> {
  const { hosts } = deps
  return {
    'host:list': () => hosts.list(),
    'host:create': (input) => hosts.create(input),
    'host:update': (id, patch) => hosts.update(id, patch),
    'host:delete': (id) => hosts.delete(id),
    'host:setVaults': (id, vaultIds) => hosts.setVaults(id, vaultIds),
  }
}
