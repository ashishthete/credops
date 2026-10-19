import { Navigate, NavLink, useParams } from 'react-router'
import { EmptyState } from '../../ui/EmptyState'
import { Play, Boxes, FileCode2, type LucideIcon } from 'lucide-react'
import { RunTab } from './RunTab'

const TABS = [
  { id: 'run', label: 'Run', icon: Play, blurb: 'Run a command on many hosts' },
  { id: 'snippets', label: 'Snippets', icon: FileCode2, blurb: 'Saved scripts with variables' },
  { id: 'containers', label: 'Containers', icon: Boxes, blurb: 'Docker containers on a host' },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; blurb: string }[]

/** The Ops section: tabs over `/ops/:tab`. Each tab's content arrives with its own task. */
export function OpsPage() {
  const { tab } = useParams()
  const current = TABS.find((t) => t.id === tab)
  if (!current) return <Navigate to="/ops/run" replace />
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Ops</h1>
      </header>
      <nav aria-label="Ops sections" className="flex gap-1 border-b border-line px-8">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/ops/${t.id}`}
            aria-current={t.id === current.id ? 'page' : undefined}
            className={`-mb-px flex h-9 items-center gap-2 border-b-2 px-3 text-[13px] font-medium transition-colors ${
              t.id === current.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            <t.icon aria-hidden className="size-3.5" />
            {t.label}
          </NavLink>
        ))}
      </nav>
      {current.id === 'run' ? (
        <RunTab />
      ) : (
        <div className="flex flex-1 items-center justify-center pb-16">
          <EmptyState icon={current.icon} title={current.blurb} text="" />
        </div>
      )}
    </div>
  )
}
