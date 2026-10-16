import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionPrompt } from '../../../../shared/ssh'
import { promptStore } from '../../terminal/sessions'
import { AuthPromptDialog } from './AuthPromptDialog'
import { HostKeyDialog } from './HostKeyDialog'

/** Longer than the dialog's exit animation. */
const EXIT_MS = 400

/**
 * Shows the oldest pending prompt, one at a time, on any page. The last prompt is kept while its
 * dialog animates out; keying by prompt id gives each one fresh state, so nothing typed carries over.
 */
export function PromptHost() {
  const queue = useSyncExternalStore(promptStore.subscribe, promptStore.get)
  const head = queue[0]
  const [kept, setKept] = useState<SessionPrompt | undefined>(head)
  if (head && kept !== head) setKept(head)
  const prompt = head ?? kept
  // Once the exit has played, nothing stays mounted to hold a prompt's state.
  useEffect(() => {
    if (head || !kept) return
    const t = setTimeout(() => setKept(undefined), EXIT_MS)
    return () => clearTimeout(t)
  }, [head, kept])
  return (
    <>
      {prompt &&
        (prompt.kind === 'host-key' ? (
          <HostKeyDialog key={prompt.promptId} prompt={prompt} open={!!head} />
        ) : (
          <AuthPromptDialog key={prompt.promptId} prompt={prompt} open={!!head} />
        ))}
    </>
  )
}
