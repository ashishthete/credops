import type { Handlers } from '../../../shared/ipc'
import type { ServiceStore } from '../../deploy/service-store'

type ServiceChannel = 'service:list' | 'service:create' | 'service:update' | 'service:delete' | 'service:reorder'

export function createServiceHandlers(deps: { services: ServiceStore }): Pick<Handlers, ServiceChannel> {
  const { services } = deps
  return {
    'service:list': (environmentId) => services.list(environmentId),
    'service:create': (input) => services.create(input),
    // Tunnel follow-up (restart, delete) is wired with the db tunnels.
    'service:update': (id, patch) => ({ service: services.update(id, patch), tunnelRestartNeeded: false }),
    'service:delete': (id, _opts) => services.delete(id),
    'service:reorder': (environmentId, ids) => services.reorder(environmentId, ids),
  }
}
