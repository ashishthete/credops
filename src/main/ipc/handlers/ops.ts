import type { Handlers } from '../../../shared/ipc'
import type { ContainerService } from '../../ops/containers'
import type { RunManager } from '../../ops/run-manager'
import type { SnippetStore } from '../../ops/snippet-store'

type OpsChannel = Extract<keyof Handlers, `snippets:${string}` | `runs:${string}` | `containers:${string}`>

export function createOpsHandlers(deps: {
  snippets: SnippetStore
  runs: RunManager
  containers: ContainerService
}): Pick<Handlers, OpsChannel> {
  const { snippets, runs, containers } = deps
  return {
    'snippets:list': () => snippets.list(),
    'snippets:create': (input) => snippets.create(input),
    'snippets:update': (id, input) => snippets.update(id, input),
    'snippets:delete': (id) => snippets.delete(id),
    'snippets:render': (id, values) => snippets.render(id, values),
    'runs:start': (req) => runs.start(req),
    'runs:cancel': (id) => runs.cancel(id),
    'runs:list': () => runs.list(),
    'runs:get': (id) => runs.get(id),
    'runs:dismiss': (id) => runs.dismiss(id),
    'containers:list': (hostId, environmentId) => containers.list(hostId, environmentId),
    'containers:action': (hostId, environmentId, ref, action, confirm) =>
      containers.action(hostId, environmentId, ref, action, confirm),
    'containers:logs': (hostId, environmentId, ref, tail) => containers.logs(hostId, environmentId, ref, tail),
    'containers:follow': (hostId, environmentId, ref, tail) => containers.follow(hostId, environmentId, ref, tail),
    'containers:unfollow': (followId) => containers.unfollow(followId),
  }
}
