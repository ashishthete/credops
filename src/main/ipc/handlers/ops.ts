import type { Handlers } from '../../../shared/ipc'

type OpsChannel = Extract<keyof Handlers, `snippets:${string}` | `runs:${string}` | `containers:${string}`>

const notYet = (): never => {
  throw new Error('Not available yet')
}

// Tasks 3, 5 and 6 replace these stubs with the snippet, run and container services.
export function createOpsHandlers(): Pick<Handlers, OpsChannel> {
  return {
    'snippets:list': notYet,
    'snippets:create': notYet,
    'snippets:update': notYet,
    'snippets:delete': notYet,
    'snippets:render': notYet,
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
