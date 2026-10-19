import { domainOpenUrl, parseEnvDomain, type ResolvedHost } from '../../../shared/inventory'
import type { Handlers } from '../../../shared/ipc'
import type { EnvironmentStore } from '../../inventory/environment-store'
import type { HostStore } from '../../inventory/host-store'
import type { ProductStore } from '../../inventory/product-store'
import type { TunnelManager } from '../../tunnels/manager'

type InventoryChannel =
  | 'host:list'
  | 'host:create'
  | 'host:update'
  | 'host:delete'
  | 'host:setVaults'
  | 'host:resolve'
  | 'env:list'
  | 'env:create'
  | 'env:update'
  | 'env:delete'
  | 'env:openDomain'
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
  resolve: (hostId: string, environmentId?: string) => ResolvedHost
  /** A deleted host's tunnels are stopped first, so their stop is audited before the host goes. */
  tunnels?: Pick<TunnelManager, 'stopForHost'>
  /** `shell.openExternal`, injected so nothing under test opens a browser. */
  openExternal: (url: string) => Promise<void>
}): Pick<Handlers, InventoryChannel> {
  const { hosts, environments, products, resolve, tunnels, openExternal } = deps
  return {
    'host:list': () => hosts.list(),
    'host:create': (input) => hosts.create(input),
    'host:update': (id, patch) => hosts.update(id, patch),
    'host:delete': (id) => {
      // Refusals first, so a delete that won't happen never stops (and audits) the host's tunnels.
      hosts.assertDeletable(id)
      tunnels?.stopForHost(id, 'deleted')
      hosts.delete(id)
    },
    'host:setVaults': (id, vaultIds) => hosts.setVaults(id, vaultIds),
    'host:resolve': (hostId, environmentId) => resolve(hostId, environmentId),
    'env:list': () => environments.list(),
    'env:create': (input) => environments.create(input),
    'env:update': (id, patch) => environments.update(id, patch),
    'env:delete': (id) => environments.delete(id),
    // Reads the stored value and re-validates it: a renderer-supplied URL never reaches the shell.
    'env:openDomain': async (id) => {
      const stored = environments.get(id).domain
      if (stored === null) throw new Error('This environment has no domain or URL')
      const cannot = new Error("This environment's domain or URL can't be opened")
      const parsed = parseEnvDomain(stored)
      if (!parsed.ok) throw cannot
      const url = domainOpenUrl(parsed.value, stored)
      if (!/^https?:\/\//i.test(url)) throw cannot
      await openExternal(url)
    },
    'env:setProducts': (id, productIds) => environments.setProducts(id, productIds),
    'env:putHost': (id, hostId, role) => environments.putHost(id, hostId, role),
    'env:removeHost': (id, hostId) => environments.removeHost(id, hostId),
    'product:list': () => products.list(),
    'product:create': (input) => products.create(input),
    'product:update': (id, patch) => products.update(id, patch),
    'product:delete': (id) => products.delete(id),
  }
}
