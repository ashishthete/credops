import type { RegionRef } from '../../../shared/inventory'

export interface RegionChipProps {
  region: Pick<RegionRef, 'code' | 'displayName'>
  /** Warning style, e.g. a deploy that reaches more than one region. */
  emphasis?: boolean
  className?: string
}

/** A region's code as a small outlined chip; the display name is the tooltip. */
export function RegionChip({ region, emphasis = false, className = '' }: RegionChipProps) {
  return (
    <span
      title={region.displayName}
      className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 font-mono text-[11px] leading-none ${
        emphasis ? 'border-(--warn) text-(--warn)' : 'border-line text-muted'
      } ${className}`}
    >
      {region.code}
    </span>
  )
}
