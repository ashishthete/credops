import type { PreflightCheck, PreflightReport, ReleaseDetail, RunEvent } from '../../shared/deploy'
import { redact } from '../security/redact'

/**
 * A release's text as it leaves main (over IPC or to a file), masked again with every known secret value and key
 * block. A local release's events were masked as they were stored; a Hub release's text reaches this desktop as the
 * Hub sent it. Only text fields change: ids, states and order stay as they were.
 */
const checkOf = (c: PreflightCheck, m: (s: string) => string): PreflightCheck => ({ ...c, message: m(c.message) })
const reportOf = (r: PreflightReport, m: (s: string) => string): PreflightReport => ({ ...r, checks: r.checks.map((c) => checkOf(c, m)) })

export function maskDetail(d: ReleaseDetail, secrets: readonly string[]): ReleaseDetail {
  const m = (s: string) => redact(s, secrets)
  return {
    ...d,
    playbook: d.playbook === null ? null : m(d.playbook),
    error: d.error === null ? null : m(d.error),
    preflight: d.preflight && reportOf(d.preflight, m),
  }
}

export function maskEvents(events: RunEvent[], secrets: readonly string[]): RunEvent[] {
  const m = (s: string) => redact(s, secrets)
  return events.map((e): RunEvent => {
    switch (e.type) {
      case 'log':
        return { ...e, line: m(e.line), ...(e.task === undefined ? {} : { task: m(e.task) }) }
      case 'task.done':
        return { ...e, task: m(e.task) }
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
