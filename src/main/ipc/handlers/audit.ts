import { writeFile } from 'node:fs/promises'
import type { AuditEvent } from '../../../shared/audit'
import type { Handlers } from '../../../shared/ipc'
import type { AuditLog } from '../../audit/audit-log'
import { toCsv } from '../../audit/csv'

const PAGE = 1000

export function createAuditHandlers(
  log: AuditLog,
  deps: { saveDialog: () => Promise<string | undefined> },
): Pick<Handlers, 'audit:list' | 'audit:verify' | 'audit:exportCsv'> {
  return {
    'audit:list': (filter) => log.list(filter),
    'audit:verify': () => {
      const result = log.verifyChain()
      if (result.ok) {
        log.append({ action: 'audit.verify', outcome: 'success', details: { count: result.count } })
      } else {
        log.append({
          action: 'audit.verify',
          outcome: 'failure',
          details: { count: result.count, brokenAtId: result.brokenAtId, reason: result.reason },
        })
      }
      return result
    },
    'audit:exportCsv': async (filter) => {
      const path = await deps.saveDialog()
      if (!path) return null
      const events: AuditEvent[] = []
      let beforeId = filter.beforeId
      for (;;) {
        const page = log.list({ ...filter, limit: PAGE, beforeId })
        events.push(...page)
        if (page.length < PAGE) break
        beforeId = page[page.length - 1].id
      }
      await writeFile(path, toCsv(events), 'utf8')
      log.append({ action: 'audit.export', outcome: 'success', details: { path, count: events.length } })
      return { path }
    },
  }
}
