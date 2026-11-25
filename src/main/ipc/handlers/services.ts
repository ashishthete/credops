import type { Handlers } from '../../../shared/ipc'
import type { AppServiceMeta, CopyServicesRequest, CopyServicesResult, ServiceMeta } from '../../../shared/services'
import type { HubCatalog } from '../../hub/catalog'
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
  /** The signed-in person's Hub catalog: the services of a Hub environment this desktop has no local copy of. */
  catalog?: Pick<HubCatalog, 'get' | 'list'>
}): Pick<Handlers, ServiceChannel> {
  const { services, copy, deploys, containers, tunnels, openExternal, catalog } = deps
  return {
    'service:list': (environmentId) => {
      const local = services.list(environmentId)
      if (!catalog) return local
      const known = new Set(local.map((s) => s.id))
      const envs = environmentId === undefined ? catalog.list() : [catalog.get(environmentId)].flatMap((e) => (e ? [e] : []))
      // Only app services: a release deploys those. A db is reached through a local tunnel and has no Hub-side meaning here.
      const extra = envs.flatMap((e) =>
        e.services.flatMap((s, i): ServiceMeta[] =>
          s.kind === 'service' && !known.has(s.id) ? [catalogService(e.environment.id, s, i)] : [],
        ),
      )
      return extra.length ? [...local, ...extra] : local
    },
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
      if (svc.kind !== 'service') throw new Error(`${svc.name} is a ${svc.kind === 'db' ? 'database' : 'bastion'}; it has no compose logs`)
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

function catalogService(
  environmentId: string,
  s: { id: string; name: string; composeService: string | null; deploymentId: string | null; hostId: string | null },
  position: number,
): AppServiceMeta {
  return {
    id: s.id,
    environmentId,
    hostId: s.hostId ?? '',
    name: s.name,
    position,
    description: '',
    createdAt: '',
    updatedAt: '',
    kind: 'service',
    deploymentId: s.deploymentId,
    composeService: s.composeService ?? s.name,
    url: null,
    urlCheckFrom: 'host',
    lastDeployedCommit: null,
    lastReleaseId: null,
    skipUnchanged: false,
  }
}
