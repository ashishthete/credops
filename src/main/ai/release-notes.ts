import { randomUUID } from 'node:crypto'
import type { AuditAppender } from '../audit/audit-log'
import type { FinalizeSteps } from '../deploy/finalize'
import { AiFailure, MAX_NOTES_SUBJECT, type AiError, type ReleaseNotesRequest, type ReleaseNotesResult } from '../../shared/ai'
import { MAX_COMMITS } from '../../shared/deploy'
import { fallbackNotes } from '../../shared/notes-fallback'
import { AI_MESSAGES, type ClaudeClient } from './claude'
import { redactPromptParts, totalRedactions, type PromptRedactionContext, type RedactionCounts } from './prompt-redact'

export { fallbackNotes }

export const NOTES_SYSTEM = [
  'You write release notes for a sales and marketing audience, in plain language a customer would understand.',
  'Use these sections, in this order, and leave out any section with nothing in it:',
  '## Features',
  '## Enhancements',
  '## Fixes',
  '## Hotfixes',
  'Write one bullet per user-visible change. Merge duplicates. Leave out chores, CI, build, test, docs and merge commits.',
  'Never include commit hashes, author names or internal ticket noise.',
  'Use only this Markdown subset: headings, bullets, bold and inline code.',
  'The input has redaction placeholders such as ‹redacted› or ‹host-1›; leave them exactly as written.',
  'Reply with the release notes only.',
].join('\n')

/** Notes are short prose; medium effort keeps them quick and cheap. */
export const NOTES_EFFORT = 'medium'

export interface NotesPrompt {
  system: string
  user: string
  counts: RedactionCounts
}

/** Builds the prompt. Only subjects (redacted) go out; author, date and sha never do. */
export function notesPrompt(req: ReleaseNotesRequest, opts: { redaction: PromptRedactionContext; environmentName: string | null }): NotesPrompt {
  const commits = req.commits.slice(0, MAX_COMMITS)
  const { parts, counts } = redactPromptParts(
    Object.fromEntries(commits.map((c, i) => [`c${i}`, c.subject.slice(0, MAX_NOTES_SUBJECT).replace(/\s+/g, ' ').trim()])),
    opts.redaction,
  )
  const subject = (i: number): string => `- ${parts[`c${i}`]}`
  const lines: string[] = []
  if (req.productName) lines.push(`Product: ${req.productName}`)
  if (opts.environmentName) lines.push(`Environment: ${opts.environmentName}`)
  if (req.version) lines.push(`Version: ${req.version}`)
  lines.push('', 'Commits:')
  if (req.deployments.length > 1) {
    const known = new Set(req.deployments.map((d) => d.id))
    const groups = [...req.deployments, { id: null, name: 'other' }]
    for (const d of groups) {
      const idx = commits.flatMap((c, i) => ((d.id === null ? !known.has(c.deploymentId) : c.deploymentId === d.id) ? [i] : []))
      if (idx.length === 0) continue
      lines.push(`### ${d.name}`, ...idx.map(subject))
    }
  } else {
    lines.push(...commits.map((_, i) => subject(i)))
  }
  return { system: NOTES_SYSTEM, user: lines.join('\n').replace(/^\n/, ''), counts }
}

export interface NotesDeps {
  claude: Pick<ClaudeClient, 'stream'>
  audit: AuditAppender
  /** The live redaction context, built per call. */
  redaction: () => PromptRedactionContext
  environmentName: (environmentId: string) => string | null
}

export interface GenerateOptions extends NotesDeps {
  trigger: 'editor' | 'finalize'
  signal: AbortSignal
  onText?: (delta: string) => void
  requestId?: string
}

/** Claude-written notes, streamed; on any AiError, the commit-list fallback (from the redacted subjects). */
export async function generateNotes(req: ReleaseNotesRequest, o: GenerateOptions): Promise<ReleaseNotesResult> {
  const requestId = o.requestId ?? randomUUID()
  let environmentName: string | null = null
  try {
    environmentName = o.environmentName(req.environmentId)
  } catch {
    environmentName = null
  }
  const prompt = notesPrompt(req, { redaction: o.redaction(), environmentName })
  const redactedSubjects = prompt.user
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => ({ subject: l.slice(2) }))
  if (req.commits.length === 0) {
    return { requestId, text: '', model: null, source: 'fallback', truncated: false, redactions: prompt.counts }
  }
  const audit = (outcome: 'success' | 'failure', details: Record<string, unknown>): void => {
    o.audit.append({
      action: 'ai.release_notes',
      outcome,
      targetType: 'environment',
      targetId: req.environmentId,
      details: {
        commits: Math.min(req.commits.length, MAX_COMMITS),
        redactions: totalRedactions(prompt.counts),
        trigger: o.trigger,
        ...details,
      },
    })
  }
  try {
    const res = await o.claude.stream({
      system: prompt.system,
      user: prompt.user,
      effort: NOTES_EFFORT,
      signal: o.signal,
      onText: (t) => o.onText?.(t),
    })
    audit('success', { model: res.model, source: 'claude' })
    return { requestId, text: res.text, model: res.model, source: 'claude', truncated: res.stopReason === 'max_tokens', redactions: prompt.counts }
  } catch (e) {
    const error: AiError = e instanceof AiFailure ? { code: e.code, message: e.message } : { code: 'api', message: AI_MESSAGES.api }
    audit('failure', { model: null, source: 'fallback', code: error.code })
    return { requestId, text: fallbackNotes(redactedSubjects), model: null, source: 'fallback', truncated: false, redactions: prompt.counts, error }
  }
}

/** Finalize's notes step: keeps edited notes, skips a redeploy, otherwise asks Claude; it never throws. */
export function releaseNotesFinalizeStep(deps: NotesDeps): FinalizeSteps['releaseNotes'] {
  return async (ctx) => {
    const run = ctx.run
    if (run.releaseNotes && run.releaseNotes.trim() !== '') return run.releaseNotes
    if (run.redeploy) {
      ctx.log('Release notes: skipped (no new commits)')
      return null
    }
    try {
      const res = await generateNotes(
        {
          environmentId: run.environmentId,
          productName: run.productName,
          deployments: run.deployments.flatMap((d) => (d.id === null ? [] : [{ id: d.id, name: d.name }])),
          version: run.version,
          commits: run.commits,
        },
        { ...deps, trigger: 'finalize', signal: ctx.signal },
      )
      if (res.source === 'claude') {
        ctx.log(`Release notes: written by Claude (${res.model})`)
        if (res.truncated) ctx.log('Release notes: cut off at the length limit')
      } else if (res.error) {
        ctx.log(`Release notes: Claude unavailable (${res.error.code}); used commit list`)
      } else {
        ctx.log('Release notes: skipped (no commits)')
      }
      return res.text === '' ? null : res.text
    } catch {
      ctx.log('Release notes: failed; none written')
      return null
    }
  }
}
