import type { ReleaseDetail, RunEvent } from '../../shared/deploy'
import { redact } from '../security/redact'

/**
 * A release's text as it leaves main (over IPC or to a file), masked again with every known secret value and key
 * block. A local release's events were masked as they were stored; a Hub release's text reaches this desktop as the
 * Hub sent it. Every string is masked (`redact` walks the whole value), so ids, states and order stay as they were.
 *
 * The stored playbook is JSON text, where a secret holding `"` or `\` appears escaped: each secret is also masked in
 * its JSON-escaped form, so that text stays valid JSON.
 */
function withJsonForms(secrets: readonly string[]): string[] {
  return secrets.flatMap((s) => {
    const escaped = JSON.stringify(s).slice(1, -1)
    return escaped === s ? [s] : [s, escaped]
  })
}

export function maskDetail(d: ReleaseDetail, secrets: readonly string[]): ReleaseDetail {
  return redact(d, withJsonForms(secrets))
}

export function maskEvents(events: RunEvent[], secrets: readonly string[]): RunEvent[] {
  return redact(events, withJsonForms(secrets))
}
