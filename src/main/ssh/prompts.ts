import { randomUUID } from 'node:crypto'
import type { EventContract } from '../../shared/ipc'
import { PROMPT_TIMEOUT_MS, type PromptAnswer, type SessionPrompt } from '../../shared/ssh'
import { HostKeyError, type HopTarget } from './connect'
import type { KnownHostStore } from './known-hosts'

/** What an asker supplies; the broker adds the ids. */
export type PromptBody = SessionPrompt extends infer P ? (P extends SessionPrompt ? Omit<P, 'promptId' | 'sessionId'> : never) : never

type PromptEvent = 'session:prompt' | 'session:promptDone'

export interface PromptBrokerDeps {
  emit<K extends PromptEvent>(event: K, payload: EventContract[K]): void
  /** While locked, no prompt is raised. */
  isLocked(): boolean
  ids?: () => string
  timeoutMs?: number
}

interface PendingPrompt {
  /** What `session:prompt` carried, for a renderer that loads the queue after it. */
  prompt: SessionPrompt
  kind: PromptAnswer['kind']
  /** Keyboard prompts only: how many responses the answer must carry. */
  count: number
  group: Set<string>
  timer: NodeJS.Timeout
  resolve(answer: PromptAnswer | null): void
}

/**
 * The one queue of prompts waiting on the user, shared by terminal sessions and tunnels. Each
 * prompt names its owner as `sessionId`, and joins the asker's group so the asker can cancel
 * what it raised.
 */
export class PromptBroker {
  private readonly prompts = new Map<string, PendingPrompt>()
  private readonly ids: () => string
  private readonly timeoutMs: number

  constructor(private readonly deps: PromptBrokerDeps) {
    this.ids = deps.ids ?? randomUUID
    this.timeoutMs = deps.timeoutMs ?? PROMPT_TIMEOUT_MS
  }

  /** `null` is a cancel or a timeout; `'locked'` means nothing was raised because the vault is locked. */
  ask(ownerId: string, group: Set<string>, body: PromptBody): Promise<PromptAnswer | null | 'locked'> {
    if (this.deps.isLocked()) return Promise.resolve('locked')
    const promptId = this.ids()
    const prompt = { ...body, promptId, sessionId: ownerId } as SessionPrompt
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(promptId, null), this.timeoutMs)
      const count = prompt.kind === 'keyboard' ? prompt.prompts.length : 0
      this.prompts.set(promptId, { prompt, kind: prompt.kind, count, group, timer, resolve })
      group.add(promptId)
      this.deps.emit('session:prompt', prompt)
    })
  }

  /** An unknown or expired prompt id is a no-op. */
  answer(promptId: string, answer: PromptAnswer): void {
    const p = this.prompts.get(promptId)
    if (!p) return
    const wrongCount = answer.kind === 'keyboard' && answer.responses !== null && answer.responses.length !== p.count
    if (p.kind !== answer.kind || wrongCount) throw new Error("prompt answer doesn't match")
    this.settle(promptId, answer)
  }

  /** Prompts still waiting on the user, oldest first: what a reloaded renderer has missed. */
  pending(): SessionPrompt[] {
    return [...this.prompts.values()].map((p) => structuredClone(p.prompt))
  }

  cancel(group: Set<string>): void {
    for (const id of [...group]) this.settle(id, null)
  }

  cancelAll(): void {
    for (const id of [...this.prompts.keys()]) this.settle(id, null)
  }

  /** `null` cancels. */
  private settle(promptId: string, answer: PromptAnswer | null): void {
    const p = this.prompts.get(promptId)
    if (!p) return
    this.prompts.delete(promptId)
    clearTimeout(p.timer)
    p.group.delete(promptId)
    this.deps.emit('session:promptDone', { promptId })
    p.resolve(answer)
  }
}

export interface HostKeyCheck {
  /** Shown as the prompt's `sessionId`. */
  ownerId: string
  group: Set<string>
  hop: HopTarget
  /** The inventory host behind `hop`, for the mismatch record. */
  hostId: string | null
  keyType: string
  keyBase64: string
  /** False once the dial was abandoned: no prompt is raised, and a late answer stores no trust. */
  isLive(): boolean
  /** The vault was locked when the prompt would have been raised. */
  onLocked(): void
}

/**
 * The host-key decision for one hop, against the app's trust store: a match proceeds, a changed
 * or revoked key throws `HostKeyError` (and is recorded), and an unknown key asks the user.
 */
export async function verifyWithStore(
  knownHosts: Pick<KnownHostStore, 'check' | 'trust' | 'recordMismatch'>,
  prompts: PromptBroker,
  c: HostKeyCheck,
): Promise<boolean> {
  const { hop, keyType, keyBase64 } = c
  const { status, info } = await knownHosts.check(hop.address, hop.port, keyType, keyBase64)
  if (status === 'match') return true
  if (status === 'changed' || status === 'revoked') {
    knownHosts.recordMismatch(info, c.hostId)
    throw new HostKeyError(status === 'changed' ? 'host-key-changed' : 'host-key-revoked', info)
  }
  if (!c.isLive()) return false
  const answer = await prompts.ask(c.ownerId, c.group, { kind: 'host-key', hopLabel: hop.label, info })
  if (answer === 'locked') {
    c.onLocked()
    return false
  }
  // A late answer for an aborted attempt never stores trust.
  if (answer?.kind !== 'host-key' || !answer.trust || !c.isLive()) return false
  knownHosts.trust(hop.address, hop.port, keyType, keyBase64)
  return true
}
