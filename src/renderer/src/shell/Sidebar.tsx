import { motion } from 'framer-motion'
import {
  Boxes,
  Cable,
  KeyRound,
  Rocket,
  ScrollText,
  Search,
  Server,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import type { AppInfo } from '../../../shared/ipc'
import { api } from '../lib/api'
import { openCommandPalette } from '../ui/commands'
import { spring, useMotionSafe } from '../ui/motion'
import { formatShortcut } from '../ui/shortcuts'
import { Skeleton } from '../ui/Skeleton'
import { SECTIONS, sectionShortcut, type SectionId } from './sections'
import { VaultLockButton } from './VaultLockButton'

export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  products: Boxes,
  hosts: Server,
  vaults: KeyRound,
  tunnels: Cable,
  deployments: Rocket,
  audit: ScrollText,
}

export function Sidebar() {
  const motionSafe = useMotionSafe()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let live = true
    api
      .invoke('app:info')
      .then((i) => live && setInfo(i))
      .catch(() => {
        // The footer just keeps its skeleton; nothing else depends on it.
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-surface">
      {/* Clears the macOS traffic lights and doubles as the window drag handle. */}
      <div className="app-drag flex h-[52px] shrink-0 items-end px-4 pb-1">
        <div className="flex items-center gap-2 pl-1">
          <span className="grid size-6 place-items-center rounded-md bg-accent/15 text-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]">
            <Rocket aria-hidden className="size-3.5" strokeWidth={2.2} />
          </span>
          <span className="text-[14px] font-semibold tracking-tight text-fg">OpsDeck</span>
        </div>
      </div>

      <div className="px-3 pt-4 pb-2">
        <button
          type="button"
          onClick={openCommandPalette}
          className="group flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-canvas/50 px-2.5 text-[12.5px] text-muted transition-colors hover:border-muted/30 hover:text-fg"
        >
          <Search aria-hidden className="size-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <Keys combo="mod+k" />
        </button>
      </div>

      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-3 py-2">
        {SECTIONS.map((s, i) => {
          const Icon = SECTION_ICONS[s.id]
          return (
            <NavLink
              key={s.id}
              to={s.path}
              className={({ isActive }) =>
                `group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors select-none ${
                  isActive ? 'text-fg' : 'text-muted hover:bg-white/[0.035] hover:text-fg'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive &&
                    (motionSafe ? (
                      <motion.span
                        layoutId="sidebar-active"
                        transition={spring}
                        className="absolute inset-0 rounded-lg bg-accent/12 shadow-[inset_2px_0_0_0_var(--accent)]"
                      />
                    ) : (
                      <span className="absolute inset-0 rounded-lg bg-accent/12 shadow-[inset_2px_0_0_0_var(--accent)]" />
                    ))}
                  <Icon
                    aria-hidden
                    className={`relative size-4 transition-colors ${isActive ? 'text-accent' : ''}`}
                    strokeWidth={2}
                  />
                  <span className="relative flex-1">{s.label}</span>
                  <Keys
                    combo={sectionShortcut(i)}
                    className="relative opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="mt-auto">
        <VaultLockButton />
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          {info ? (
            <>
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full bg-linear-to-br from-accent/40 to-ok/30 text-[11px] font-semibold text-fg uppercase"
              >
                {info.actor.osUser.slice(0, 2)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-fg" title="Recorded as the actor on every audit event">
                  {`${info.actor.osUser}@${info.actor.machine}`}
                </p>
                <p className="text-[11px] text-muted">v{info.version}</p>
              </div>
            </>
          ) : (
            <>
              <Skeleton className="size-7 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-10" />
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}

function Keys({ combo, className = '' }: { combo: string; className?: string }) {
  return (
    <span aria-hidden className={`flex items-center gap-0.5 ${className}`}>
      {formatShortcut(combo).map((k) => (
        <kbd
          key={k}
          className="grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-line bg-surface-2 px-1 text-[10.5px] leading-none text-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}
