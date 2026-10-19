import { ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HUB_AUDIT_ACTIONS, type HubAuditAction, type HubAuditFilter } from '../../../../shared/hub'
import { loadHubAudit, useHub, verifyHubAudit } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { plural } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import type { Tone } from '../../ui/tone'
import { ListSkeleton } from './HubPage'

const OUTCOME_TONE: Record<string, Tone> = { success: 'success', failure: 'error', denied: 'warn', info: 'info' }

// <input type="date"> gives YYYY-MM-DD; widen to local day bounds like the local audit page.
function dayBound(value: string, end: boolean): string | undefined {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString()
}

export function HubAuditPanel() {
  const { audit, auditLoading, users } = useHub()
  const [action, setAction] = useState<HubAuditAction | ''>('')
  const [actor, setActor] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [first, setFirst] = useState(true)

  useEffect(() => {
    const filter: HubAuditFilter = { limit: 200 }
    if (action) filter.actions = [action]
    if (actor) filter.actorOid = actor
    const f = from && dayBound(from, false)
    const t = to && dayBound(to, true)
    if (f) filter.from = f
    if (t) filter.to = t
    void loadHubAudit(filter).then(() => setFirst(false))
  }, [action, actor, from, to])

  const verify = async () => {
    setVerifying(true)
    const out = await verifyHubAudit()
    setVerifying(false)
    if (out) setResult(out.ok ? `Chain intact (${plural(out.count, 'event')})` : `Broken at #${out.brokenAtId ?? '?'}`)
  }

  const field = 'h-8 rounded-md border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg'
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value as HubAuditAction | '')} className={field}>
          <option value="">All actions</option>
          {HUB_AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select aria-label="Actor" value={actor} onChange={(e) => setActor(e.target.value)} className={field}>
          <option value="">Anyone</option>
          {users.map((u) => (
            <option key={u.oid} value={u.oid}>
              {u.name}
            </option>
          ))}
        </select>
        <input aria-label="From date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        <input aria-label="To date" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
        <Button size="sm" variant="ghost" loading={verifying} icon={<ShieldCheck aria-hidden className="size-3.5" />} onClick={() => void verify()}>
          Verify chain
        </Button>
        {result && (
          <span role="status" className={`inline-flex items-center gap-1.5 text-[12.5px] ${result.startsWith('Broken') ? 'text-err' : 'text-ok'}`}>
            {result.startsWith('Broken') && <ShieldAlert aria-hidden className="size-3.5" />}
            {result}
          </span>
        )}
      </div>
      {first && auditLoading ? (
        <ListSkeleton />
      ) : audit.length === 0 ? (
        <EmptyState icon={ScrollText} title="No events" text="Nothing matches these filters yet." />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {audit.map((ev) => (
            <li key={ev.id} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="w-44 shrink-0 font-mono text-[12px] text-muted">{new Date(ev.ts).toLocaleString()}</span>
              <span className="w-40 shrink-0 truncate text-fg">{ev.action}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {ev.actor?.name ?? 'System'}
                {ev.targetLabel ? ` → ${ev.targetLabel}` : ''}
              </span>
              <Badge tone={OUTCOME_TONE[ev.outcome] ?? 'info'}>{ev.outcome}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
