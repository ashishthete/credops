import { escapeHtml, notesToHtml, notesToText, parseNotes } from '../../shared/notes-markdown'
import { redact } from '../security/redact'
import { postJson, type Fetch } from './http'
import { changeLines, factRows, httpsLinks, type NotificationFacts } from './teams'

export const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send'

export interface SendGridBody {
  personalizations: { to: { email: string }[]; cc?: { email: string }[] }[]
  from: { email: string; name: string }
  subject: string
  content: { type: 'text/plain' | 'text/html'; value: string }[]
}

export interface EmailAddressing {
  from: string
  to: readonly string[]
  cc: readonly string[]
  knownSecrets?: readonly string[]
}

const uniqueCaseless = (xs: readonly string[], skip: ReadonlySet<string> = new Set()): string[] => {
  const seen = new Set(skip)
  return xs.filter((x) => {
    const k = x.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** dd-Mon-YYYY in the main process's local timezone; null when the time is missing or unreadable. */
function localDate(iso: string | null | undefined): string | null {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return null
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`
}

export function releaseSubject(f: NotificationFacts): string {
  const prefix = f.product ? `[${f.product}] ` : ''
  if (f.version) return `${prefix}${f.environment.name} released ${f.version}`
  const date = (f.commitCount ?? 0) > 0 ? localDate(f.startedAt) : null
  return date ? `${prefix}${f.environment.name} update: ${date} available for testing` : `${prefix}${f.environment.name} redeployed`
}

/** The release email: §8.7 facts, then the notes. Notes and every other string are redacted again here. */
export function buildReleaseEmail(facts: NotificationFacts, notes: string | null, a: EmailAddressing): SendGridBody {
  const secrets = a.knownSecrets ?? []
  const blocks = notes ? parseNotes(redact(notes, secrets)) : []
  const rows = factRows(facts)
  const links = httpsLinks(facts.urls)
  const changes = changeLines(facts, secrets)

  const text = [
    facts.title,
    '',
    ...rows.map((r) => `${r.title}: ${r.value}`),
    ...(blocks.length > 0 ? ['', notesToText(blocks)] : []),
    ...(changes.length > 0 ? ['', 'Changes', ...changes.flatMap((c) => [`${c.deployment}:`, ...c.lines.map((l) => `- ${l}`)])] : []),
    ...(links.length > 0 ? ['', ...links.map((u) => u.href)] : []),
  ].join('\n')

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#111">',
    `<h2 style="margin:0 0 12px">${escapeHtml(facts.title)}</h2>`,
    '<table style="border-collapse:collapse">',
    ...rows.map((r) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(r.title)}</td><td style="padding:4px 0">${escapeHtml(r.value)}</td></tr>`),
    '</table>',
    ...(blocks.length > 0 ? ['<div style="margin-top:16px">', notesToHtml(blocks), '</div>'] : []),
    ...(changes.length > 0
      ? [
          '<div style="margin-top:16px"><strong>Changes</strong>',
          ...changes.map((c) => `<p style="margin:8px 0 0"><em>${escapeHtml(c.deployment)}</em></p><ul style="margin:4px 0">${c.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`),
          '</div>',
        ]
      : []),
    ...(links.length > 0 ? [`<p style="margin-top:16px">${links.map((u) => `<a href="${escapeHtml(u.href)}">${escapeHtml(u.href)}</a>`).join('<br>')}</p>`] : []),
    '</div>',
  ].join('\n')

  const to = uniqueCaseless(a.to)
  const cc = uniqueCaseless(a.cc, new Set(to.map((x) => x.toLowerCase())))
  const personalization: SendGridBody['personalizations'][number] = { to: to.map((email) => ({ email })) }
  if (cc.length > 0) personalization.cc = cc.map((email) => ({ email }))
  return redact(
    {
      personalizations: [personalization],
      from: { email: a.from, name: 'CredOps' },
      subject: releaseSubject(facts),
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    },
    secrets,
  )
}

export interface EmailDeps {
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  knownSecrets: readonly string[]
}

/** 2xx (SendGrid answers 202) is success; 401/403 are `auth`. The key lives only in the header. */
export async function sendEmail(apiKey: string, body: SendGridBody, deps: EmailDeps): Promise<void> {
  await postJson(SENDGRID_URL, body, {
    service: 'sendgrid',
    headers: { authorization: `Bearer ${apiKey}` },
    fetch: deps.fetch,
    sleep: deps.sleep,
    knownSecrets: [...deps.knownSecrets, apiKey],
  })
}
