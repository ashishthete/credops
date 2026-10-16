import type { LucideIcon } from 'lucide-react'
import { EmptyState } from '../ui/EmptyState'

export interface PlaceholderPageProps {
  title: string
  icon: LucideIcon
  phase: number
  blurb: string
}

/** Stand-in for a section that a later phase builds out. */
export function PlaceholderPage({ title, icon, phase, blurb }: PlaceholderPageProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
      </header>
      <div className="flex flex-1 items-center justify-center pb-16">
        <div className="flex flex-col items-center">
          <EmptyState icon={icon} title={blurb} text={`Coming in phase ${phase}`} />
        </div>
      </div>
    </div>
  )
}
