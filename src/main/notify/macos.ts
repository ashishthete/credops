import type { NotificationFacts } from './teams'
import { formatDuration } from './teams'

/** The slice of Electron's `Notification` this uses; Electron's types stay a type-only concern. */
export interface NotificationLike {
  on(event: 'click', fn: () => void): unknown
  on(event: 'close', fn: () => void): unknown
  show(): void
}
export interface NotificationCtor {
  isSupported(): boolean
  new (opts: { title: string; body: string; silent?: boolean }): NotificationLike
}

const STATUS_WORD: Record<NotificationFacts['status'], string> = {
  started: 'started',
  succeeded: 'succeeded',
  failed: 'failed',
  rolled_back: 'rolled back',
  dropped: 'dropped',
  qa_passed: 'QA passed',
  qa_failed: 'QA failed',
}
const LOUD = new Set<NotificationFacts['status']>(['failed', 'rolled_back', 'dropped', 'qa_failed'])

export interface MacNotifierDeps {
  Notification: NotificationCtor
  /** Gets the renderer hash route of the clicked alert. */
  onClick: (route: string) => void
  /** `notify.macos`; read on every show. */
  enabled: () => boolean
}

export class MacNotifier {
  /** Shown alerts stay referenced until clicked or closed, so a click is never lost to GC. */
  private readonly live = new Set<NotificationLike>()

  constructor(private readonly d: MacNotifierDeps) {}

  supported(): boolean {
    return this.d.Notification.isSupported()
  }

  enabled(): boolean {
    return this.d.enabled()
  }

  /** `<env> · <deployment|title> <status>`; the body is version and duration. Sounds only on failure. */
  show(facts: NotificationFacts, route: string): void {
    if (!this.d.enabled() || !this.supported()) return
    // An operation: the runbook is the title, and one line says where and how it ended.
    if (facts.runbook !== undefined) return this.raw(facts.runbook, `${facts.environment.name} · ${STATUS_WORD[facts.status]}`, !LOUD.has(facts.status), route)
    const title = `${facts.environment.name} · ${facts.deployment ?? facts.title} ${STATUS_WORD[facts.status]}`
    this.raw(title, [facts.version, facts.durationSec === null ? null : formatDuration(facts.durationSec)].filter(Boolean).join(' · '), !LOUD.has(facts.status), route)
  }

  /** A plain alert (the test send); shown whatever `enabled` says, if supported. */
  raw(title: string, body: string, silent: boolean, route: string): void {
    if (!this.supported()) return
    const n = new this.d.Notification({ title, body, silent })
    this.live.add(n)
    n.on('click', () => {
      this.live.delete(n)
      this.d.onClick(route)
    })
    n.on('close', () => this.live.delete(n))
    n.show()
  }
}
