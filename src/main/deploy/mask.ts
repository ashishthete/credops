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
 * deployment, check label, commit author) and the lock file text OpsDeck writes are not free text and stay as they
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

function textMask(secrets: readonly string[]): Mask {
  const forms = withJsonForms(secrets)
  return (s) => redact(s, forms)
}

const B64_STRING = /"([A-Za-z0-9+/]{4,}={0,2})"/g
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Hooks are carried in the playbook as base64, where a secret's encoding depends on where it falls in the text, so
 * an encoded form cannot be matched reliably. Instead each base64 string in the playbook is decoded; when it is
 * UTF-8 text holding a known secret or key block, it is masked and encoded again. Anything else stays as it was.
 */
function maskBase64(text: string, secrets: readonly string[]): string {
  return text.replace(B64_STRING, (whole, b64: string) => {
    if (b64.length % 4 !== 0) return whole
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.toString('base64') !== b64) return whole
    let decoded: string
    try {
      decoded = utf8.decode(bytes)
    } catch {
      return whole
    }
    const masked = redact(decoded, secrets)
    return masked === decoded ? whole : `"${Buffer.from(masked, 'utf8').toString('base64')}"`
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

export function maskDetail(d: ReleaseDetail, secrets: readonly string[]): ReleaseDetail {
  const m = textMask(secrets)
  return {
    ...summaryOf(d, m),
    ...(typeof d.releaseNotes === 'string' && { releaseNotes: m(d.releaseNotes) }),
    ...(typeof d.playbook === 'string' && { playbook: m(maskBase64(d.playbook, secrets)) }),
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
