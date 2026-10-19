import type { Db } from '../db/connection'
import { MAX_NOTIFY_LOG, type NotificationRecord, type NotifyLogFilter } from '../../shared/settings'

export interface LogRow {
  id: string
  at: string
  source_type: NotificationRecord['sourceType']
  source_id: string
  event: string
  channel: NotificationRecord['channel']
  status: NotificationRecord['status']
  detail: string | null
}

export const toRecord = (r: LogRow): NotificationRecord => ({
  id: r.id,
  at: r.at,
  sourceType: r.source_type,
  sourceId: r.source_id,
  event: r.event,
  channel: r.channel,
  status: r.status,
  detail: r.detail,
})

/** Newest first; `limit` defaults to 50 and is capped at 200. */
export function listNotifications(db: Db, filter: NotifyLogFilter = {}): NotificationRecord[] {
  const where: string[] = []
  const params: string[] = []
  if (filter.sourceType) {
    where.push('source_type = ?')
    params.push(filter.sourceType)
  }
  if (filter.sourceId) {
    where.push('source_id = ?')
    params.push(filter.sourceId)
  }
  if (filter.environmentId) {
    // A tunnel row's source id is `<tunnelId>@<time>`.
    where.push(
      "((source_type = 'release' AND source_id IN (SELECT id FROM releases WHERE environment_id = ?)) OR (source_type = 'tunnel' AND substr(source_id, 1, instr(source_id || '@', '@') - 1) IN (SELECT id FROM tunnels WHERE environment_id = ?)))",
    )
    params.push(filter.environmentId, filter.environmentId)
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_NOTIFY_LOG)
  const sql = `SELECT * FROM notification_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`
  return (db.prepare(sql).all(...params, limit) as unknown as LogRow[]).map(toRecord)
}
