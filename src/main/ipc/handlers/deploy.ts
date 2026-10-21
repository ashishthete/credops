import { MAX_EVENTS_PAGE, type DeploymentMeta, type EnvDeploySettings, type Tooling } from '../../../shared/deploy'
import type { Handlers } from '../../../shared/ipc'
import type { DeployStore } from '../../deploy/deploy-store'
import type { ReleaseApi } from '../../hub/runner'
import type { HubCatalog } from '../../hub/catalog'

type DeployChannel =
  | 'deploy:list'
  | 'deploy:create'
  | 'deploy:update'
  | 'deploy:delete'
  | 'deploy:reorder'
  | 'deploy:settings'
  | 'deploy:updateSettings'
  | 'deploy:tooling'
  | 'release:preflight'
  | 'release:start'
  | 'release:cancel'
  | 'release:rollback'
  | 'release:break-lock'
  | 'release:discard'
  | 'release:set-notes'
  | 'release:retry-version'
  | 'release:list'
  | 'release:get'
  | 'release:events'
  | 'release:active'

export function createDeployHandlers(deps: {
  deploys: DeployStore
  releases: ReleaseApi
  tooling: () => Promise<Tooling>
  /** The signed-in person's Hub catalog: where the wizard reads a Hub environment this desktop has no local copy of. */
  catalog?: Pick<HubCatalog, 'get' | 'list'>
  /** An environment this desktop published: its settings are edited here (and pushed again), not read from the Hub. */
  published?: (environmentId: string) => boolean
}): Pick<Handlers, DeployChannel> {
  const { deploys, releases, tooling, catalog, published } = deps
  return {
    'deploy:list': (environmentId) => {
      const local = deploys.list(environmentId)
      if (!catalog) return local
      const known = new Set(local.map((d) => d.id))
      const envs = environmentId === undefined ? catalog.list() : [catalog.get(environmentId)].flatMap((e) => (e ? [e] : []))
      const extra = envs.flatMap((e) => e.deployments.filter((d) => !known.has(d.id)).map(catalogDeployment))
      return extra.length ? [...local, ...extra] : local
    },
    'deploy:create': (input) => deploys.create(input),
    'deploy:update': (id, patch) => deploys.update(id, patch),
    'deploy:delete': (id) => deploys.delete(id),
    'deploy:reorder': (environmentId, ids) => deploys.reorder(environmentId, ids),
    'deploy:settings': (environmentId) => {
      // The Hub is the authority for a Hub environment's settings, unless this desktop published it: edits go to the local row.
      const hub = published?.(environmentId) ? undefined : catalog?.get(environmentId)?.environment
      if (hub) return catalogSettings(environmentId, hub)
      return deploys.settings(environmentId)
    },
    'deploy:updateSettings': (environmentId, patch) => deploys.updateSettings(environmentId, patch),
    'deploy:tooling': () => tooling(),
    'release:preflight': (request) => releases.preflight(request),
    'release:start': (id, confirm) => releases.start(id, confirm),
    'release:cancel': (id) => releases.cancel(id),
    'release:rollback': (id, confirm) => releases.rollback(id, confirm),
    'release:break-lock': (id, hostId, confirm) => releases.breakLock(id, hostId, confirm),
    'release:discard': (id) => releases.discard(id),
    'release:set-notes': (id, notes) => releases.setNotes(id, notes),
    'release:retry-version': (id) => releases.retryVersion(id),
    'release:list': (filter) => releases.list(filter),
    'release:get': (id) => releases.detail(id),
    // The validator caps `limit`; the clamp keeps a direct caller honest too.
    'release:events': (id, afterSeq, limit) => releases.events(id, afterSeq, Math.min(limit ?? 1000, MAX_EVENTS_PAGE)),
    'release:active': () => releases.listActive(),
  }
}

function catalogDeployment(d: Omit<DeploymentMeta, 'vaultIds' | 'createdAt' | 'updatedAt'>): DeploymentMeta {
  return { ...d, vaultIds: [], createdAt: '', updatedAt: '' }
}

function catalogSettings(
  environmentId: string,
  env: { versioned: boolean; autoRollback: boolean; currentVersion: string | null },
): EnvDeploySettings {
  return { environmentId, versioned: env.versioned, autoRollback: env.autoRollback, currentVersion: env.currentVersion }
}
