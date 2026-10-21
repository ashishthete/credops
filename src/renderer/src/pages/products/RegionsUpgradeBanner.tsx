import { MapPin, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { RegionsUpgradeReport } from '../../../../shared/inventory'
import type { InventoryData } from '../../inventory/store'
import { api } from '../../lib/api'
import { attempt } from '../../ui/common'

interface RegionsUpgradeBannerProps {
  data: InventoryData
  /** Shows an environment the report names. */
  onOpen: (environmentId: string) => void
}

/** What the regions upgrade moved, on the first launch after it, until dismissed. Absent with nothing to report. */
export function RegionsUpgradeBanner({ data, onOpen }: RegionsUpgradeBannerProps) {
  const [report, setReport] = useState<RegionsUpgradeReport | null>(null)

  useEffect(() => {
    let live = true
    // Nothing to show is the usual answer; a failed read just leaves the banner out.
    api.invoke('region:upgradeReport').then(
      (r) => live && setReport(r),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])

  if (!report) return null

  const dismiss = async () => {
    setReport(null)
    await attempt("Couldn't dismiss the upgrade notes", () => api.invoke('region:dismissUpgradeReport'))
  }

  // An environment deleted since the upgrade is named but not linked.
  const envLink = (id: string, name: string): ReactNode =>
    data.environments.some((e) => e.id === id) ? (
      <button type="button" onClick={() => onOpen(id)} className="font-medium text-accent underline-offset-2 hover:underline">
        {name}
      </button>
    ) : (
      <span className="font-medium text-fg">{name}</span>
    )
  const joined = (nodes: ReactNode[]) => nodes.flatMap((n, i) => (i === 0 ? [n] : [', ', n]))

  return (
    <div role="status" aria-label="Regions upgrade" className="mx-8 mt-4 flex items-start gap-3 rounded-xl border border-accent/35 bg-accent/[0.07] px-4 py-3">
      <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] leading-5 text-fg">
        {report.region && (
          <p>
            Hosts now have a region. Everything is in <strong>{report.region.displayName}</strong> for now. Create your regions and move hosts.
          </p>
        )}
        {(report.productLinks.length > 0 || report.unassigned || report.renamed.length > 0) && (
          <ul className="flex flex-col gap-0.5 text-[12.5px] text-muted">
            {report.productLinks.map((l) => (
              <li key={l.environmentId}>
                {envLink(l.environmentId, l.environmentName)}: kept {l.kept.name}, removed {l.removed.map((r) => r.name).join(', ')}
              </li>
            ))}
            {report.unassigned && (
              <li>
                In no product, now in {report.unassigned.product.name}: {joined(report.unassigned.environments.map((e) => <span key={e.id}>{envLink(e.id, e.name)}</span>))}
              </li>
            )}
            {report.renamed.map((r) => (
              <li key={r.environmentId}>
                Renamed {r.from} to {envLink(r.environmentId, r.to)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => void dismiss()}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
