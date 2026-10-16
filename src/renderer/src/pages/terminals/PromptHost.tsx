import { useRef, useSyncExternalStore } from 'react'
import type { SessionPrompt } from '../../../../shared/ssh'
import { promptStore } from '../../terminal/sessions'
import { AuthPromptDialog } from './AuthPromptDialog'
import { HostKeyDialog } from './HostKeyDialog'
import { KnownHostsDialog } from './KnownHostsDialog'

/**
 * Shows the oldest pending prompt, one at a time, on any page. The last prompt is kept while its
 * dialog animates out; keying by prompt id gives each one fresh state, so nothing typed carries over.
 */
export function PromptHost() {
  const queue = useSyncExternalStore(promptStore.subscribe, promptStore.get)
  const head = queue[0]
  const shown = useRef<SessionPrompt | undefined>(head)
  if (head) shown.current = head
  const prompt = shown.current
  return (
    <>
      {prompt &&
        (prompt.kind === 'host-key' ? (
          <HostKeyDialog key={prompt.promptId} prompt={prompt} open={!!head} />
        ) : (
          <AuthPromptDialog key={prompt.promptId} prompt={prompt} open={!!head} />
        ))}
      <KnownHostsDialog />
    </>
  )
}
