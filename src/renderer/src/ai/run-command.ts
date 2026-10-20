import type { Explanation } from '../../../shared/ai'
import { api } from '../lib/api'
import { openLocal, openSsh, sessionStore, setActive } from '../terminal/sessions'
import { errorText } from '../ui/common'
import { toast } from '../ui/Toaster'

export const READY_TIMEOUT_MS = 30_000

/** Resolves true once the session is ready, false if it ends first or the timeout passes. */
function whenReady(id: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = (): boolean | null => {
      const m = sessionStore.get().sessions.find((s) => s.id === id)
      if (m?.state === 'ready') return true
      if (m && (m.state === 'failed' || m.state === 'closed')) return false
      return null
    }
    const now = check()
    if (now !== null) return resolve(now)
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = sessionStore.subscribe(() => {
      const r = check()
      if (r === null) return
      clearTimeout(timer)
      off()
      resolve(r)
    })
  })
}

/**
 * The only path that writes AI text to a session, and only after the user confirmed it: opens a fresh
 * session on the target (or a local shell), waits for it to be ready, types the command, audits the run.
 */
export async function runInTerminal(e: Explanation, requestId: string, index: number, goToTerminal: () => void): Promise<void> {
  const c = e.commands[index]
  if (!c) return
  const host = c.where === 'host'
  if (host && !e.target.hostId) return
  const id = host ? await openSsh(e.target.hostId!, e.target.environmentId ?? undefined) : await openLocal()
  if (!id) return // openSsh/openLocal already toasted.
  if (!(await whenReady(id, READY_TIMEOUT_MS))) {
    toast({ title: "The command didn't run", description: 'The session never became ready.', tone: 'error' })
    return
  }
  try {
    await api.invoke('session:write', id, `${c.command}\r`)
  } catch (err) {
    toast({ title: "The command didn't run", description: errorText(err), tone: 'error' })
    return
  }
  void api.invoke('ai:command', requestId, index, 'run').catch(() => undefined)
  setActive(id)
  goToTerminal()
}
