import type { CommitInfo, PreflightCheck, PreflightReport, ReleaseDetail, ReleaseSummary, RunEvent } from '../../shared/deploy'
import { redact } from '../security/redact'

/**
 * A release's text as it leaves main (over IPC or to a file), masked again with every known secret value and key
 * block. A local release's events were masked as they were stored; a Hub release's text reaches this desktop as the
 * Hub sent it.
 *
 * Only the human-text fields listed here are masked: command output, errors, messages, notes, commit subjects and
 * the playbook. Ids, timestamps, states, numbers and keys are never touched, since a short secret (a 4-digit PIN,
 * a hex fragment) can also occur in a uuid or a date. Names and labels the person configured (environment, host,
 * deployment, check label, commit author) and the lock file text CredOps writes are not free text and stay as they
 * are. `tests/main/release-mask.test.ts` pins this list, so a new text field is added here on purpose.
 */
type Mask = (s: string) => string

/**
 * The stored playbook is JSON text, where a secret holding `"` or `\` appears escaped: each secret is also masked in
 * its JSON-escaped form, so that text stays valid JSON.
 */
function withJsonForms(secrets: readonly string[]): string[] {
  return secrets.flatMap((s) => {
    const escaped = JSON.stringify(s).slice(1, -1)
    return escaped === s ? [s] : [s, escaped]
  })
}

/**
 * A step's output can carry a secret as base64 (`echo "$TOKEN" | base64`). Base64 at offset 0 is stable up to the
 * last whole 3-byte group, so that prefix is masked wherever it appears, with the full encodings (with and without a
 * trailing newline) masked first. A form shorter than 8 characters would also match unrelated text, so is left out.
 * An encoding at offset 1 or 2 (`echo "x=$T" | base64`) is not caught: this is best effort.
 */
export function withBase64Forms(secrets: readonly string[]): string[] {
  return secrets.flatMap((s) => {
    const bytes = Buffer.from(s, 'utf8')
    const prefix = bytes.subarray(0, bytes.length - (bytes.length % 3)).toString('base64')
    const forms = [bytes.toString('base64'), Buffer.from(`${s}\n`, 'utf8').toString('base64'), prefix]
    return [s, ...forms.filter((f) => f.length >= 8)]
  })
}

function textMask(secrets: readonly string[]): Mask {
  const forms = withJsonForms(withBase64Forms(secrets))
  return (s) => redact(s, forms)
}

/** The playbook vars that carry text as base64: the hooks, and CredOps's own `*_b64` values (the lock file text). */
const B64_VAR = /("(pre_hook|post_hook|[A-Za-z0-9_]*_b64)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Hooks are carried in the playbook as base64, where a secret's encoding depends on its offset in the hook, so an
 * encoded form of the secret cannot be matched reliably. Instead each hook var is decoded, masked and encoded again.
 * A payload that does not decode cleanly to UTF-8 text cannot be checked, so it is replaced by its size.
 */
function maskBase64(text: string, secrets: readonly string[]): string {
  return text.replace(B64_VAR, (whole, key: string, name: string, literal: string) => {
    const value = JSON.parse(`"${literal}"`) as string
    if (value === '') return whole
    const bytes = Buffer.from(value, 'base64')
    const clean = value.length % 4 === 0 && bytes.toString('base64') === value
    let decoded: string | null = null
    if (clean) {
      try {
        decoded = utf8.decode(bytes)
      } catch {
        decoded = null
      }
    }
    if (decoded === null) {
      const what = name.endsWith('_b64') ? 'lock data' : 'hook'
      return key + JSON.stringify(`‹${what}, ${clean ? bytes.length : Buffer.byteLength(value)} bytes›`)
    }
    const masked = redact(decoded, secrets)
    return masked === decoded ? whole : key + JSON.stringify(Buffer.from(masked, 'utf8').toString('base64'))
  })
}

/** Maps a list that a Hub's (or a test's) value may leave out, keeping it absent rather than failing. */
const each = <T>(xs: T[], f: (x: T) => T): T[] => (Array.isArray(xs) ? xs.map(f) : xs)

const commitOf = (c: CommitInfo, m: Mask): CommitInfo => ({ ...c, subject: m(c.subject) })
const checkOf = (c: PreflightCheck, m: Mask): PreflightCheck => ({ ...c, message: m(c.message) })
const reportOf = (r: PreflightReport, m: Mask): PreflightReport => ({
  ...r,
  checks: each(r.checks, (c) => checkOf(c, m)),
  ...(r.commits && { commits: Object.fromEntries(Object.entries(r.commits).map(([k, v]) => [k, { ...v, commits: each(v.commits, (c) => commitOf(c, m)) }])) }),
})
const summaryOf = <T extends ReleaseSummary>(s: T, m: Mask): T => (typeof s.error === 'string' ? { ...s, error: m(s.error) } : s)

export function maskSummary<T extends ReleaseSummary>(s: T, secrets: readonly string[]): T {
  return summaryOf(s, textMask(secrets))
}

/** A playbook's text (stored, or a preview about to be shown or saved), masked as `maskDetail` masks a stored one. */
export function maskPlaybook(text: string, secrets: readonly string[]): string {
  return textMask(secrets)(maskBase64(text, secrets))
}

export function maskDetail(d: ReleaseDetail, secrets: readonly string[]): ReleaseDetail {
  const m = textMask(secrets)
  return {
    ...summaryOf(d, m),
    ...(typeof d.releaseNotes === 'string' && { releaseNotes: m(d.releaseNotes) }),
    ...(typeof d.playbook === 'string' && { playbook: maskPlaybook(d.playbook, secrets) }),
    ...(typeof d.playbookGenerated === 'string' && { playbookGenerated: maskPlaybook(d.playbookGenerated, secrets) }),
    runs: each(d.runs, (r) => ({
      ...r,
      commits: each(r.commits, (c) => commitOf(c, m)),
      steps: each(r.steps, (s) => (s.error === undefined ? s : { ...s, error: m(s.error) })),
    })),
    preflight: d.preflight && reportOf(d.preflight, m),
  }
}

export function maskEvents(events: RunEvent[], secrets: readonly string[]): RunEvent[] {
  const m = textMask(secrets)
  return events.map((e): RunEvent => {
    switch (e.type) {
      case 'log':
        return { ...e, line: m(e.line), ...(e.task === undefined ? {} : { task: m(e.task) }) }
      case 'task.done':
        return { ...e, task: m(e.task) }
      case 'step.started':
        return { ...e, name: m(e.name) }
      case 'step.failed':
        return { ...e, error: m(e.error) }
      case 'step.done':
        return e.message === undefined ? e : { ...e, message: m(e.message) }
      case 'lock.busy':
        return { ...e, text: m(e.text) }
      case 'run.finished':
        return e.error === undefined ? e : { ...e, error: m(e.error) }
      case 'preflight.check':
        return { ...e, check: checkOf(e.check, m) }
      case 'preflight.done':
        return { ...e, report: reportOf(e.report, m) }
      default:
        return e
    }
  })
}
