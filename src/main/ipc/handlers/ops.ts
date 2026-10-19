import type { Handlers } from '../../../shared/ipc'
import type { RunManager } from '../../ops/run-manager'
import type { SnippetStore } from '../../ops/snippet-store'

type OpsChannel = Extract<keyof Handlers, `snippets:${string}` | `runs:${string}` | `containers:${string}`>

const notYet = (): never => {
  throw new Error('Not available yet')
}

// Task 6 replaces the container stubs with its service.
export function createOpsHandlers(deps: { snippets: SnippetStore; runs: RunManager }): Pick<Handlers, OpsChannel> {
  const { snippets, runs } = deps
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
    'containers:list': notYet,
    'containers:action': notYet,
    'containers:logs': notYet,
    'containers:follow': notYet,
    'containers:unfollow': notYet,
  }
}
