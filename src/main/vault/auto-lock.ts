import type { LockReason } from '../../shared/vault'

export interface AutoLockDeps {
  /** Seconds since the last user input anywhere on the system. */
  idleSeconds: () => number
  /** The configured timeout; null means never. */
  minutes: () => number | null
  isUnlocked: () => boolean
  lock: (reason: LockReason) => void
}

/** Locks the vaults once the system has been idle for the configured number of minutes. */
export class AutoLock {
  constructor(private readonly deps: AutoLockDeps) {}

  tick(): void {
    if (!this.deps.isUnlocked()) return
    const minutes = this.deps.minutes()
    if (minutes === null) return
    if (this.deps.idleSeconds() >= minutes * 60) this.deps.lock('idle')
  }

  /** Polls every `intervalMs`; returns a function that stops polling. */
  start(intervalMs = 15_000): () => void {
    const timer = setInterval(() => {
      try {
        this.tick()
      } catch (err) {
        console.error('auto-lock check failed:', err)
      }
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
