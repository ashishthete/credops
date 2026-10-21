import { motion } from 'framer-motion'
import {
  Boxes,
  Cable,
  KeyRound,
  Network,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { NavLink, useNavigate } from 'react-router'
import type { AppInfo } from '../../../shared/ipc'
import { releaseStore } from '../deploy/releases'
import { api } from '../lib/api'
import { sessionStore } from '../terminal/sessions'
import { runningCount, runStore } from '../ops/runs'
import { tunnelStore } from '../tunnels/store'
import { openCommandPalette, registerCommand } from '../ui/commands'
import { plural } from '../ui/common'
import { spring, useMotionSafe } from '../ui/motion'
import { formatShortcut, useShortcut } from '../ui/shortcuts'
import { Skeleton } from '../ui/Skeleton'
import { SECTIONS, sectionShortcut, type SectionId } from './sections'
import { VaultLockButton } from './VaultLockButton'

export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  products: Boxes,
  terminals: SquareTerminal,
  hosts: Server,
  vaults: KeyRound,
  tunnels: Cable,
  map: Network,
  ops: Wrench,
  deployments: Rocket,
  hub: Users,
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
          const shortcut = sectionShortcut(i)
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
                  {s.id === 'terminals' && <LiveCount />}
                  {s.id === 'tunnels' && <TunnelBadge />}
                  {s.id === 'ops' && <RunBadge />}
                  {s.id === 'deployments' && <DeployBadge />}
                  {shortcut && (
                    <Keys
                      combo={shortcut}
                      className="relative opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="mt-auto">
        <SettingsButton />
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

const SETTINGS_SHORTCUT = 'mod+,'

/** The Settings link above the lock button, plus its palette command and ⌘,. */
function SettingsButton() {
  const navigate = useNavigate()
  useEffect(
    () =>
      registerCommand({
        id: 'settings.open',
        title: 'Settings',
        section: 'Settings',
        keywords: ['preferences', 'config', 'export'],
        shortcut: SETTINGS_SHORTCUT,
        run: () => void navigate('/settings'),
      }),
    [navigate],
  )
  useShortcut(SETTINGS_SHORTCUT, () => void navigate('/settings'))

  return (
    <div className="px-3 pb-0.5">
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          `group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors select-none ${
            isActive ? 'bg-accent/12 text-fg' : 'text-muted hover:bg-white/[0.035] hover:text-fg'
          }`
        }
      >
        {({ isActive }) => (
          <>
            <span className="grid size-5 place-items-center">
              <Settings aria-hidden className={`size-4 ${isActive ? 'text-accent' : ''}`} strokeWidth={2} />
            </span>
            <span className="flex-1">Settings</span>
            <Keys combo={SETTINGS_SHORTCUT} className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </>
        )}
      </NavLink>
    </div>
  )
}

const liveCount = () => sessionStore.get().sessions.filter((s) => s.state === 'connecting' || s.state === 'ready').length

/** Sessions that are connecting or up; it gives way to the shortcut keys on hover. */
function LiveCount() {
  const motionSafe = useMotionSafe()
  const count = useSyncExternalStore(sessionStore.subscribe, liveCount)
  if (!count) return null
  return (
    <motion.span
      key={count}
      data-badge
      aria-label={`${count} live`}
      initial={motionSafe ? { scale: 0.6, opacity: 0 } : { opacity: 0 }}
      animate={motionSafe ? { scale: 1, opacity: 1 } : { opacity: 1 }}
      transition={spring}
      className="absolute right-2.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ok/15 px-1.5 text-[10.5px] font-semibold text-ok tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
    >
      {count}
    </motion.span>
  )
}

interface TunnelSummary {
  up: number
  failed: number
  /** Retrying or connecting. */
  busy: number
}

let tunnelSummary: TunnelSummary = { up: 0, failed: 0, busy: 0 }
// Snapshot identity must hold until the counts change, or useSyncExternalStore loops.
function summarizeTunnels(): TunnelSummary {
  const counts: TunnelSummary = { up: 0, failed: 0, busy: 0 }
  for (const rt of Object.values(tunnelStore.get().runtime)) {
    if (rt.state === 'up') counts.up++
    else if (rt.state === 'failed') counts.failed++
    else if (rt.state === 'retrying' || rt.state === 'connecting') counts.busy++
  }
  const c = tunnelSummary
  if (c.up !== counts.up || c.failed !== counts.failed || c.busy !== counts.busy) tunnelSummary = counts
  return tunnelSummary
}

/** Tunnels that are up, with a red dot when one failed or an amber one while any is (re)connecting. */
function TunnelBadge() {
  const { up, failed, busy } = useSyncExternalStore(tunnelStore.subscribe, summarizeTunnels)
  if (!up && !failed && !busy) return null
  const parts = [`${plural(up, 'tunnel')} up`]
  if (failed) parts.push(`${failed} failed`)
  if (busy) parts.push(`${busy} reconnecting`)
  const dot = failed ? 'bg-err' : busy ? 'bg-warn' : ''
  return (
    <span
      data-badge
      aria-label={parts.join(', ')}
      className="absolute right-2.5 flex h-[18px] min-w-[18px] items-center justify-center gap-1 rounded-full bg-ok/15 px-1.5 text-[10.5px] font-semibold text-ok tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
    >
      {dot && <span aria-hidden data-dot={failed ? 'failed' : 'busy'} className={`size-1.5 rounded-full ${dot}`} />}
      {up}
    </span>
  )
}

/** Runs in progress; it gives way to the shortcut keys on hover. */
function RunBadge() {
  const count = useSyncExternalStore(runStore.subscribe, runningCount)
  if (!count) return null
  return (
    <span
      data-badge
      aria-label={`${plural(count, 'run')} running`}
      className="absolute right-2.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent/15 px-1.5 text-[10.5px] font-semibold text-accent tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
    >
      {count}
    </span>
  )
}

function DeployBadge() {
  const count = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().active.length)
  if (!count) return null
  return (
    <span
      data-badge
      aria-label={`${plural(count, 'release')} running`}
      className="absolute right-2.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent/15 px-1.5 text-[10.5px] font-semibold text-accent tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
    >
      {count}
    </span>
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
