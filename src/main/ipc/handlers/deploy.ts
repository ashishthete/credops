import { MAX_EVENTS_PAGE, type Tooling } from '../../../shared/deploy'
import type { Handlers } from '../../../shared/ipc'
import type { DeployStore } from '../../deploy/deploy-store'
import type { ReleaseService } from '../../deploy/release-service'

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
  | 'release:retry-version'
  | 'release:list'
  | 'release:get'
  | 'release:events'
  | 'release:active'

export function createDeployHandlers(deps: {
  deploys: DeployStore
  releases: ReleaseService
  tooling: () => Promise<Tooling>
}): Pick<Handlers, DeployChannel> {
  const { deploys, releases, tooling } = deps
  return {
    'deploy:list': (environmentId) => deploys.list(environmentId),
    'deploy:create': (input) => deploys.create(input),
    'deploy:update': (id, patch) => deploys.update(id, patch),
    'deploy:delete': (id) => deploys.delete(id),
    'deploy:reorder': (environmentId, ids) => deploys.reorder(environmentId, ids),
    'deploy:settings': (environmentId) => deploys.settings(environmentId),
    'deploy:updateSettings': (environmentId, patch) => deploys.updateSettings(environmentId, patch),
    'deploy:tooling': () => tooling(),
    'release:preflight': (request) => releases.preflight(request),
    'release:start': (id, confirm) => releases.start(id, confirm),
    'release:cancel': (id) => releases.cancel(id),
    'release:rollback': (id, confirm) => releases.rollback(id, confirm),
    'release:break-lock': (id, hostId, confirm) => releases.breakLock(id, hostId, confirm),
    'release:discard': (id) => releases.discard(id),
    'release:retry-version': (id) => releases.retryVersion(id),
    'release:list': (filter) => releases.list(filter),
    'release:get': (id) => releases.detail(id),
    // The validator caps `limit`; the clamp keeps a direct caller honest too.
    'release:events': (id, afterSeq, limit) => releases.events(id, afterSeq, Math.min(limit ?? 1000, MAX_EVENTS_PAGE)),
    'release:active': () => releases.listActive(),
  }
}
