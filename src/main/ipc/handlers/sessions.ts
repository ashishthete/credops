import type { Handlers } from '../../../shared/ipc'
import type { KnownHostStore } from '../../ssh/known-hosts'
import type { SessionManager } from '../../ssh/sessions'

type SessionChannel =
  | 'ssh:open'
  | 'shell:open'
  | 'session:reconnect'
  | 'session:write'
  | 'session:resize'
  | 'session:close'
  | 'session:list'
  | 'session:attach'
  | 'session:answer'
  | 'knownhost:list'
  | 'knownhost:remove'

export type SessionApi = Pick<
  SessionManager,
  'openSsh' | 'openLocal' | 'reconnect' | 'write' | 'resize' | 'close' | 'list' | 'attach' | 'answer'
>

export function createSessionHandlers(deps: {
  sessions: SessionApi
  knownHosts: Pick<KnownHostStore, 'list' | 'remove'>
}): Pick<Handlers, SessionChannel> {
  const { sessions, knownHosts } = deps
  return {
    'ssh:open': (req) => sessions.openSsh(req),
    'shell:open': (req) => sessions.openLocal(req),
    'session:reconnect': (id) => sessions.reconnect(id),
    'session:write': (id, data) => sessions.write(id, data),
    'session:resize': (id, cols, rows) => sessions.resize(id, cols, rows),
    'session:close': (id) => sessions.close(id),
    'session:list': () => sessions.list(),
    'session:attach': (id) => sessions.attach(id),
    'session:answer': (promptId, answer) => sessions.answer(promptId, answer),
    'knownhost:list': () => knownHosts.list(),
    'knownhost:remove': (id) => knownHosts.remove(id),
  }
}
