import type { Handlers } from '../../../shared/ipc'
import type { SnippetStore } from '../../ops/snippet-store'

type OpsChannel = Extract<keyof Handlers, `snippets:${string}` | `runs:${string}` | `containers:${string}`>

const notYet = (): never => {
  throw new Error('Not available yet')
}

// Tasks 5 and 6 replace the run and container stubs with their services.
export function createOpsHandlers(deps: { snippets: SnippetStore }): Pick<Handlers, OpsChannel> {
  const { snippets } = deps
  return {
    'snippets:list': () => snippets.list(),
    'snippets:create': (input) => snippets.create(input),
    'snippets:update': (id, input) => snippets.update(id, input),
    'snippets:delete': (id) => snippets.delete(id),
    'snippets:render': (id, values) => snippets.render(id, values),
    'runs:start': notYet,
    'runs:cancel': notYet,
    'runs:list': notYet,
    'runs:get': notYet,
    'runs:dismiss': notYet,
    'containers:list': notYet,
    'containers:action': notYet,
    'containers:logs': notYet,
    'containers:follow': notYet,
    'containers:unfollow': notYet,
  }
}
