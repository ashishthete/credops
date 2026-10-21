import { motion } from 'framer-motion'
import { GitBranch, Server } from 'lucide-react'
import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import type { PreflightReport } from '../../../../../shared/deploy'
import { REPO_URL_LEGACY_WARNING, isLegacyRepoUrl, maskRepoUrl } from '../../../../../shared/inventory'
import type { AppServiceMeta } from '../../../../../shared/services'
import { checkoutNotice, type PickerGroup } from '../../../deploy/picker'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'

export interface ServicePickerProps {
  groups: PickerGroup[]
  unavailable: AppServiceMeta[]
  hostLabel: (hostId: string) => string
  /** Preflight's report, once it has read the compose files. */
  report: PreflightReport | null
  onToggle: (serviceId: string) => void
  onToggleGroup: (g: PickerGroup) => void
  onAll: () => void
}

/** A checkbox that can show a mixed state. */
function Check({ mixed = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return <input ref={ref} type="checkbox" className="size-3.5 shrink-0 accent-(--accent) disabled:opacity-50" {...rest} />
}

export const composeOf = (report: PreflightReport | null, checkoutId: string) => ({
  services: report?.composeServices[checkoutId] ?? null,
  databases: report?.composeDatabases?.[checkoutId] ?? [],
})

/** The lines under a partially ticked checkout: what is restarted and what keeps running. */
export function CheckoutNotice({ group, report }: { group: PickerGroup; report: PreflightReport | null }) {
  const compose = composeOf(report, group.checkout.id)
  const lines = checkoutNotice(group, compose.services, compose.databases)
  if (!lines.length) return null
  return (
    <ul aria-label={`What happens to ${group.checkout.name}`} className="flex flex-col gap-1 rounded-lg border border-warn/25 bg-warn/[0.06] px-3 py-2 text-[12px] text-fg/85">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  )
}

/** Compose services classed as databases: shown so the user sees they exist, never ticked. */
export function DatabaseRows({ checkoutId, report }: { checkoutId: string; report: PreflightReport | null }) {
  const dbs = composeOf(report, checkoutId).databases
  if (!dbs.length) return null
  return (
    <ul aria-label="Databases" className="flex flex-col gap-0.5 pl-6 text-[12.5px] text-muted">
      {dbs.map((name) => (
        <li key={name} className="h-6 leading-6">{`${name} (database, skipped)`}</li>
      ))}
    </ul>
  )
}

/** Selected services with no changes since their last deploy: start skips them unless deployed anyway. */
export function SkipRows({ services, onForce }: { services: { id: string; name: string }[]; onForce: (serviceId: string) => void }) {
  if (!services.length) return null
  return (
    <ul aria-label="Skipped services" className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2 text-[12.5px]">
      {services.map((s) => (
        <li key={s.id} aria-label={s.name} className="flex items-center gap-3">
          <span className="font-medium text-fg">{s.name}</span>
          <span className="flex-1 text-muted">skipped: no changes</span>
          <Button size="sm" variant="ghost" onClick={() => onForce(s.id)}>
            Deploy anyway
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** Services under their checkouts, each group with its own select-all; dbs are never listed. */
export function ServicePicker({ groups, unavailable, hostLabel, report, onToggle, onToggleGroup, onAll }: ServicePickerProps) {
  const motionSafe = useMotionSafe()
  const rows = groups.flatMap((g) => (g.services.length ? g.services.map((s) => g.selected.has(s.id)) : [g.whole]))
  const ticked = rows.filter(Boolean).length
  const enter = (i: number) => ({
    initial: motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 },
    animate: motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 },
    transition: motionSafe ? { ...spring, delay: staggerDelay(i) } : fast,
  })
  return (
    <div className="flex flex-col gap-3">
      <label className="flex h-7 items-center gap-2 text-[12.5px] font-medium text-fg">
        <Check checked={rows.length > 0 && ticked === rows.length} mixed={ticked > 0 && ticked < rows.length} disabled={!rows.length} onChange={onAll} />
        All
      </label>
      {groups.map((g, i) => {
        const none = !g.services.length
        return (
          <motion.fieldset key={g.checkout.id} aria-label={g.checkout.name} {...enter(i)} className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <legend className="sr-only">{g.checkout.name}</legend>
            <div className="flex min-w-0 items-center gap-2">
              {!none && (
                <Check aria-label={`All of ${g.checkout.name}`} checked={g.whole} mixed={g.partial} onChange={() => onToggleGroup(g)} />
              )}
              <span className="truncate text-[13px] font-semibold text-fg">{g.checkout.name}</span>
              {g.whole && <Badge tone="success">whole checkout</Badge>}
              <span className="ml-auto flex min-w-0 items-center gap-3 text-[11.5px] text-muted">
                <span className="truncate font-mono">{g.checkout.repoUrl ? maskRepoUrl(g.checkout.repoUrl) : g.checkout.repoPath}</span>
                {g.checkout.repoUrl && isLegacyRepoUrl(g.checkout.repoUrl) && <span className="shrink-0 text-warn">{REPO_URL_LEGACY_WARNING}</span>}
                <span className="flex items-center gap-1">
                  <GitBranch aria-hidden className="size-3" />
                  <span className="font-mono">{g.checkout.defaultBranch}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Server aria-hidden className="size-3" />
                  <span>{hostLabel(g.checkout.hostId)}</span>
                </span>
              </span>
            </div>
            <ul className="flex flex-col gap-0.5 pl-1">
              {none ? (
                <li>
                  <label className="flex h-7 items-center gap-2 text-[12.5px] text-fg/90">
                    <Check checked={g.whole} onChange={() => onToggleGroup(g)} />
                    Whole checkout
                  </label>
                </li>
              ) : (
                g.services.map((s) => (
                  <li key={s.id}>
                    <label className="flex h-7 items-center gap-2 text-[12.5px] text-fg/90">
                      <Check checked={g.selected.has(s.id)} onChange={() => onToggle(s.id)} />
                      {s.name}
                      {s.composeService !== s.name && <span className="font-mono text-[11.5px] text-muted">{s.composeService}</span>}
                    </label>
                  </li>
                ))
              )}
            </ul>
            <DatabaseRows checkoutId={g.checkout.id} report={report} />
            <CheckoutNotice group={g} report={report} />
          </motion.fieldset>
        )
      })}
      {unavailable.length > 0 && (
        <ul aria-label="Not deployable" className="flex flex-col gap-0.5 rounded-xl border border-dashed border-line p-3">
          {unavailable.map((s) => (
            <li key={s.id} className="flex h-7 items-center gap-2 text-[12.5px] text-muted">
              <Check aria-label={s.name} checked={false} disabled onChange={() => {}} />
              <span>{s.name}</span>
              <span className="ml-auto text-[11.5px]">No checkout</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
