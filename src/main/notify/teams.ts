import type { NotifyEventKey } from '../../shared/settings'
import { redact } from '../security/redact'
import { postJson, type Fetch } from './http'

/** The §8.7 fields: everything a Teams card or an email may say. No logs, addresses or commands. */
export interface NotificationFacts {
  event: NotifyEventKey
  title: string
  environment: { name: string; color: string; protected: boolean }
  product: string | null
  deployment: string | null
  /** Host labels, never addresses. */
  hosts: string[]
  status: 'started' | 'succeeded' | 'failed' | 'rolled_back' | 'dropped' | 'qa_passed' | 'qa_failed'
  version: string | null
  durationSec: number | null
  urls: string[]
  /** `osUser@machine`. */
  actor: string
  at: string
  /** At most 600 chars; `release.succeeded` only. */
  notesExcerpt?: string
  /** The release's start time (ISO); the available-for-testing email subject shows its local date. */
  startedAt?: string | null
  /** New commits in the release; 0 is a redeploy. Absent when unknown. */
  commitCount?: number
  /** Commit subjects per deployment, newest first. Shown as a "Changes" section, capped per deployment. */
  changes?: { deployment: string; subjects: string[] }[]
  /** A runbook operation's one line (runbook, environment, outcome, service count): the card shows only it. */
  summary?: string
}

export const MAX_CHANGES_SHOWN = 10
export const MAX_SUBJECT_CHARS = 120

export const MAX_NOTES_EXCERPT = 600
const MAX_ACTIONS = 3
const MAX_HOSTS_SHOWN = 10

const STATUS_TEXT: Record<NotificationFacts['status'], string> = {
  started: 'Started',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  dropped: 'Dropped',
  qa_passed: 'QA passed',
  qa_failed: 'QA failed',
}
const STYLE: Record<NotificationFacts['status'], 'good' | 'attention' | 'warning'> = {
  started: 'warning',
  succeeded: 'good',
  failed: 'attention',
  rolled_back: 'warning',
  dropped: 'attention',
  qa_passed: 'good',
  qa_failed: 'attention',
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`
}

export function hostList(hosts: readonly string[]): string {
  const shown = hosts.slice(0, MAX_HOSTS_SHOWN).join(', ')
  return hosts.length > MAX_HOSTS_SHOWN ? `${shown} and ${hosts.length - MAX_HOSTS_SHOWN} more` : shown
}

/** `https:` links only, normalised, at most `max`. */
export function httpsLinks(urls: readonly string[], max = MAX_ACTIONS): URL[] {
  const out: URL[] = []
  for (const raw of urls) {
    try {
      const u = new URL(raw)
      if (u.protocol === 'https:' && !out.some((o) => o.href === u.href)) out.push(u)
    } catch {
      // not a URL: dropped
    }
    if (out.length === max) break
  }
  return out
}

/** The fact rows shared by Teams and email, in display order. */
export function factRows(f: NotificationFacts): { title: string; value: string }[] {
  const rows: { title: string; value: string }[] = [
    { title: 'Environment', value: f.environment.protected ? `${f.environment.name} (protected)` : f.environment.name },
  ]
  if (f.product) rows.push({ title: 'Product', value: f.product })
  if (f.deployment) rows.push({ title: 'Deployment', value: f.deployment })
  if (f.hosts.length > 0) rows.push({ title: f.hosts.length === 1 ? 'Host' : 'Hosts', value: hostList(f.hosts) })
  rows.push({ title: 'Status', value: STATUS_TEXT[f.status] })
  if (f.version) rows.push({ title: 'Version', value: f.version })
  if (f.durationSec !== null) rows.push({ title: 'Duration', value: formatDuration(f.durationSec) })
  rows.push({ title: 'By', value: f.actor }, { title: 'At', value: f.at })
  return rows
}

/** Single-line plain text, redacted first so a cut can't split a secret, then cut to MAX_SUBJECT_CHARS. */
export function commitSubject(s: string, knownSecrets: readonly string[] = []): string {
  const one = redact(s.replace(/\s+/g, ' ').trim(), knownSecrets)
  return one.length > MAX_SUBJECT_CHARS ? `${one.slice(0, MAX_SUBJECT_CHARS - 1)}…` : one
}

/** The "Changes" lines: per deployment a heading, up to MAX_CHANGES_SHOWN subjects, then "and N more". */
export function changeLines(f: NotificationFacts, knownSecrets: readonly string[] = []): { deployment: string; lines: string[] }[] {
  return (f.changes ?? [])
    .filter((c) => c.subjects.length > 0)
    .map((c) => ({
      deployment: c.deployment,
      lines: [
        ...c.subjects.slice(0, MAX_CHANGES_SHOWN).map((s) => commitSubject(s, knownSecrets)),
        ...(c.subjects.length > MAX_CHANGES_SHOWN ? [`and ${c.subjects.length - MAX_CHANGES_SHOWN} more`] : []),
      ],
    }))
}

export function notesFor(f: NotificationFacts): string | null {
  if (f.event !== 'release.succeeded' || !f.notesExcerpt) return null
  return f.notesExcerpt.length > MAX_NOTES_EXCERPT ? `${f.notesExcerpt.slice(0, MAX_NOTES_EXCERPT - 1)}…` : f.notesExcerpt
}

/** An Adaptive Card 1.5 message. Reads only the §8.7 fields, and redacts every string once more. */
export function buildTeamsCard(facts: NotificationFacts, knownSecrets: readonly string[] = []): object {
  const notes = notesFor(facts)
  const heading = {
    type: 'Container',
    style: STYLE[facts.status],
    bleed: true,
    items: [{ type: 'TextBlock', text: facts.title, weight: 'Bolder', size: 'Medium', wrap: true }],
  }
  if (facts.summary !== undefined) return redact(card([heading, { type: 'TextBlock', text: facts.summary, wrap: true }], []), knownSecrets)
  const body: object[] = [heading, { type: 'FactSet', facts: factRows(facts) }]
  if (notes) body.push({ type: 'TextBlock', text: notes, wrap: true, isSubtle: true, spacing: 'Medium' })
  const changes = changeLines(facts, knownSecrets)
  if (changes.length > 0) {
    body.push({ type: 'TextBlock', text: 'Changes', weight: 'Bolder', spacing: 'Medium' })
    for (const c of changes) {
      // RichTextBlock text runs are plain text: a TextBlock would render commit subjects as markdown (links, bold).
      // One block per line: not every renderer breaks lines on a newline inside a TextRun.
      body.push({ type: 'RichTextBlock', spacing: 'Small', inlines: [{ type: 'TextRun', text: c.deployment, weight: 'Bolder' }] })
      for (const l of c.lines) body.push({ type: 'RichTextBlock', spacing: 'None', inlines: [{ type: 'TextRun', text: `• ${l}` }] })
    }
  }
  const actions = httpsLinks(facts.urls).map((u) => ({ type: 'Action.OpenUrl', title: `Open ${u.host}`, url: u.href }))
  return redact(card(body, actions), knownSecrets)
}

function card(body: object[], actions: object[]): object {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          msteams: { width: 'Full' },
          body,
          actions,
        },
      },
    ],
  }
}

export interface TeamsDeps {
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  knownSecrets: readonly string[]
}

/** Posts the card; the webhook URL is itself a known secret, so no error or card can carry it. */
export async function sendTeams(webhookUrl: string, facts: NotificationFacts, deps: TeamsDeps): Promise<void> {
  const secrets = [...deps.knownSecrets, webhookUrl]
  await postJson(webhookUrl, buildTeamsCard(facts, secrets), { service: 'teams', fetch: deps.fetch, sleep: deps.sleep, knownSecrets: secrets })
}
