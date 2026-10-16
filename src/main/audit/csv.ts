import type { AuditEvent } from '../../shared/audit'

const HEADER = [
  'id',
  'ts',
  'actor_os_user',
  'actor_machine',
  'action',
  'target_type',
  'target_id',
  'target_label',
  'outcome',
  'details',
].join(',')

// Neutralise spreadsheet formula injection (OWASP), then quote if needed.
function cell(value: string | number | null): string {
  let s = value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(events: AuditEvent[]): string {
  const rows = events.map((e) =>
    [
      e.id,
      e.ts,
      e.actorOsUser,
      e.actorMachine,
      e.action,
      e.targetType,
      e.targetId,
      e.targetLabel,
      e.outcome,
      JSON.stringify(e.details),
    ]
      .map(cell)
      .join(','),
  )
  return [HEADER, ...rows].join('\r\n') + '\r\n'
}
