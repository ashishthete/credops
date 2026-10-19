import { noopFinalize, type FinalizeContext, type FinalizeSteps } from '../deploy/finalize'
import type { ChannelOutcome, NotificationDispatcher } from './dispatcher'

const LABEL: Record<ChannelOutcome['channel'], string> = { teams: 'Teams', email: 'Email', macos: 'macOS' }

export function outcomeLine(o: ChannelOutcome): string {
  const name = LABEL[o.channel]
  switch (o.status) {
    case 'sent':
      return `${name}: sent`
    case 'failed':
      return `${name}: failed (${o.reason ?? 'unknown error'})`
    case 'skipped':
      return `${name}: skipped (${o.reason ?? 'not configured'})`
    case 'pending':
      return `${name}: ${o.reason ?? 'queued'}`
    case 'duplicate':
      return `${name}: already sent`
  }
}

export interface FinalizeStepDeps {
  dispatcher: Pick<NotificationDispatcher, 'notifyRunSucceeded'>
  /** Task 9's release-notes step; omitted, the step reports skipped. */
  notes?: FinalizeSteps['releaseNotes']
  /** Task 7's QA step; omitted, the step reports skipped. */
  qa?: FinalizeSteps['qa']
}

/**
 * Phase 9's finalize steps for ReleaseService. `notify` sends `release.succeeded` with the notes step's output
 * (or the release's own notes), logs one line per channel, and throws only when every attempted channel failed.
 */
export function createFinalizeSteps(d: FinalizeStepDeps): FinalizeSteps {
  const written = new WeakMap<FinalizeContext, string | null>()
  const notesStep = d.notes
  const releaseNotes: FinalizeSteps['releaseNotes'] = notesStep
    ? async (ctx) => {
        const out = await notesStep(ctx)
        written.set(ctx, out)
        return out
      }
    : noopFinalize.releaseNotes
  return {
    releaseNotes,
    notify: async (ctx) => {
      const notes = written.get(ctx) ?? ctx.run.releaseNotes
      const outcomes = await d.dispatcher.notifyRunSucceeded(ctx.run, notes)
      for (const o of outcomes) ctx.log(outcomeLine(o))
      const tried = outcomes.filter((o) => o.status !== 'skipped' && o.status !== 'duplicate')
      if (tried.length > 0 && tried.every((o) => o.status === 'failed')) {
        throw new Error(`Every notification failed: ${tried.map((o) => `${LABEL[o.channel]} (${o.reason ?? 'unknown error'})`).join(', ')}`)
      }
    },
    qa: d.qa ?? noopFinalize.qa,
  }
}
