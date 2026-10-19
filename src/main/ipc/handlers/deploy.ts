import type { Handlers } from '../../../shared/ipc'
import type { DeployStore } from '../../deploy/deploy-store'

type DeployChannel =
  | 'app:list'
  | 'app:create'
  | 'app:update'
  | 'app:delete'
  | 'deploy:list'
  | 'deploy:create'
  | 'deploy:update'
  | 'deploy:delete'
  | 'deploy:reorder'
  | 'deploy:settings'
  | 'deploy:updateSettings'

export function createDeployHandlers(deps: { deploys: DeployStore }): Pick<Handlers, DeployChannel> {
  const { deploys } = deps
  return {
    'app:list': (environmentId) => deploys.listApps(environmentId),
    'app:create': (input) => deploys.createApp(input),
    'app:update': (id, patch) => deploys.updateApp(id, patch),
    'app:delete': (id) => deploys.deleteApp(id),
    'deploy:list': (environmentId) => deploys.list(environmentId),
    'deploy:create': (input) => deploys.create(input),
    'deploy:update': (id, patch) => deploys.update(id, patch),
    'deploy:delete': (id) => deploys.delete(id),
    'deploy:reorder': (environmentId, ids) => deploys.reorder(environmentId, ids),
    'deploy:settings': (environmentId) => deploys.settings(environmentId),
    'deploy:updateSettings': (environmentId, patch) => deploys.updateSettings(environmentId, patch),
  }
}
