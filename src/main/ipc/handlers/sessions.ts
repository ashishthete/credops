import type { Handlers } from '../../../shared/ipc'
import type { KnownHostStore } from '../../ssh/known-hosts'
import type { PromptBroker } from '../../ssh/prompts'
import type { SessionManager } from '../../ssh/sessions'

type SessionChannel =
  | 'ssh:open'
  | 'shell:open'
  | 'session:reconnect'
  | 'session:write'
  | 'session:resize'
  | 'session:ack'
  | 'session:close'
  | 'session:list'
  | 'session:attach'
  | 'session:answer'
  | 'session:prompts'
  | 'knownhost:list'
  | 'knownhost:remove'

export type SessionApi = Pick<
  SessionManager,
  'openSsh' | 'openLocal' | 'reconnect' | 'write' | 'resize' | 'ack' | 'close' | 'list' | 'attach'
>

/** Session and tunnel prompts share one broker, so one answer channel serves both. */
export type PromptApi = Pick<PromptBroker, 'answer' | 'pending'>

export function createSessionHandlers(deps: {
  sessions: SessionApi
  prompts: PromptApi
  knownHosts: Pick<KnownHostStore, 'list' | 'remove'>
}): Pick<Handlers, SessionChannel> {
  const { sessions, prompts, knownHosts } = deps
  return {
    'ssh:open': (req) => sessions.openSsh(req),
    'shell:open': (req) => sessions.openLocal(req),
    'session:reconnect': (id) => sessions.reconnect(id),
    'session:write': (id, data) => sessions.write(id, data),
    'session:resize': (id, cols, rows) => sessions.resize(id, cols, rows),
    'session:ack': (id, chars) => sessions.ack(id, chars),
    'session:close': (id) => sessions.close(id),
    'session:list': () => sessions.list(),
    'session:attach': (id) => sessions.attach(id),
    'session:answer': (promptId, answer) => prompts.answer(promptId, answer),
    'session:prompts': () => prompts.pending(),
    'knownhost:list': () => knownHosts.list(),
    'knownhost:remove': (id) => knownHosts.remove(id),
  }
}
