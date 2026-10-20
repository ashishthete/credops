import type { Handlers } from '../../../shared/ipc'
import type { CopyServicesRequest, CopyServicesResult } from '../../../shared/services'
import type { DeployStore } from '../../deploy/deploy-store'
import type { ServiceStore } from '../../deploy/service-store'
import type { ServiceTunnels } from '../../deploy/service-tunnel'
import type { ContainerService } from '../../ops/containers'

type ServiceChannel =
  | 'service:list'
  | 'service:create'
  | 'service:update'
  | 'service:delete'
  | 'service:reorder'
  | 'service:copy'
  | 'service:logs'
  | 'service:open'
  | 'service:tunnelOpen'
  | 'service:tunnelClose'
  | 'service:tunnelSync'

export function createServiceHandlers(deps: {
  services: ServiceStore
  copy: (req: CopyServicesRequest) => CopyServicesResult
  deploys: Pick<DeployStore, 'get'>
  containers: Pick<ContainerService, 'followCompose'>
  tunnels: Pick<ServiceTunnels, 'afterUpdate' | 'remove' | 'open' | 'close' | 'sync'>
  /** `shell.openExternal`, injected so nothing under test opens a browser. */
  openExternal: (url: string) => Promise<void>
}): Pick<Handlers, ServiceChannel> {
  const { services, copy, deploys, containers, tunnels, openExternal } = deps
  return {
    'service:list': (environmentId) => services.list(environmentId),
    'service:create': (input) => services.create(input),
    'service:update': (id, patch) => {
      const service = services.update(id, patch)
      return { service, tunnelRestartNeeded: tunnels.afterUpdate(service) }
    },
    // The tunnel goes first, so its stop and delete are audited before the service's delete.
    'service:delete': (id, opts) => {
      if (opts.deleteTunnel) tunnels.remove(id)
      services.delete(id)
    },
    'service:reorder': (environmentId, ids) => services.reorder(environmentId, ids),
    'service:copy': (req) => copy(req),
    'service:logs': (id, tail) => {
      const svc = services.get(id)
      if (svc.kind !== 'service') throw new Error(`${svc.name} is a database; it has no compose logs`)
      if (svc.deploymentId === null) throw new Error(`${svc.name} has no checkout`)
      const d = deploys.get(svc.deploymentId)
      const spec = { repoPath: d.repoPath, composeFile: d.composeFile, composeProject: d.composeProject, composeService: svc.composeService, useSudo: d.useSudo }
      return containers.followCompose(d.hostId, d.environmentId, spec, tail)
    },
    // Reads the stored URL and re-checks it: a renderer-supplied URL never reaches the shell.
    'service:open': async (id) => {
      const svc = services.get(id)
      const url = svc.kind === 'service' ? svc.url : null
      if (url === null) throw new Error(`${svc.name} has no URL`)
      if (!/^https?:\/\//i.test(url)) throw new Error(`${svc.name}'s URL can't be opened`)
      await openExternal(url)
    },
    'service:tunnelOpen': (id) => tunnels.open(id),
    'service:tunnelClose': (id) => tunnels.close(id),
    'service:tunnelSync': (id) => tunnels.sync(id),
  }
}
