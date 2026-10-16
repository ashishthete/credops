import type { Handlers } from '../../../shared/ipc'
import type { EnvironmentStore } from '../../inventory/environment-store'
import type { HostStore } from '../../inventory/host-store'
import type { ProductStore } from '../../inventory/product-store'

type InventoryChannel =
  | 'host:list'
  | 'host:create'
  | 'host:update'
  | 'host:delete'
  | 'host:setVaults'
  | 'env:list'
  | 'env:create'
  | 'env:update'
  | 'env:delete'
  | 'env:setProducts'
  | 'env:putHost'
  | 'env:removeHost'
  | 'product:list'
  | 'product:create'
  | 'product:update'
  | 'product:delete'

export function createInventoryHandlers(deps: {
  hosts: HostStore
  environments: EnvironmentStore
  products: ProductStore
}): Pick<Handlers, InventoryChannel> {
  const { hosts, environments, products } = deps
  return {
    'host:list': () => hosts.list(),
    'host:create': (input) => hosts.create(input),
    'host:update': (id, patch) => hosts.update(id, patch),
    'host:delete': (id) => hosts.delete(id),
    'host:setVaults': (id, vaultIds) => hosts.setVaults(id, vaultIds),
    'env:list': () => environments.list(),
    'env:create': (input) => environments.create(input),
    'env:update': (id, patch) => environments.update(id, patch),
    'env:delete': (id) => environments.delete(id),
    'env:setProducts': (id, productIds) => environments.setProducts(id, productIds),
    'env:putHost': (id, hostId, role) => environments.putHost(id, hostId, role),
    'env:removeHost': (id, hostId) => environments.removeHost(id, hostId),
    'product:list': () => products.list(),
    'product:create': (input) => products.create(input),
    'product:update': (id, patch) => products.update(id, patch),
    'product:delete': (id) => products.delete(id),
  }
}
