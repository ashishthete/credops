import { AnimatePresence, motion, Reorder } from 'framer-motion'
import { Plus, X } from 'lucide-react'
import { useRef } from 'react'
import type { SessionMeta, SessionState } from '../../../../shared/ssh'
import { moveTab } from '../../terminal/sessions'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { formatShortcut } from '../../ui/shortcuts'

const DOT: Record<SessionState, string> = {
  connecting: 'bg-warn',
  ready: 'bg-ok',
  failed: 'bg-err',
  closed: 'bg-muted/60',
}

/** A session's status: amber (pulsing when motion is safe) while connecting, then green, red or grey. */
export function StatusDot({ state }: { state: SessionState }) {
  const motionSafe = useMotionSafe()
  return (
    <span aria-hidden data-state={state} className="relative flex size-2 shrink-0">
      {state === 'connecting' && motionSafe && (
        <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${DOT[state]}`} />
      )}
      <span className={`relative size-2 rounded-full transition-colors ${DOT[state]}`} />
    </span>
  )
}

export interface TabStripProps {
  sessions: SessionMeta[]
  activeId: string | null
  envName: (environmentId: string | null) => string | undefined
  onSelect: (id: string) => void
  onClose: (meta: SessionMeta) => void
  onNew: () => void
}

export function TabStrip({ sessions, activeId, envName, onSelect, onClose, onNew }: TabStripProps) {
  const motionSafe = useMotionSafe()
  // Reorder hands back the whole new order; the tab being dragged is the one that moved.
  const dragging = useRef<string | null>(null)

  return (
    <div className="app-drag flex h-[52px] shrink-0 items-end gap-1 border-b border-line bg-surface/60 px-2 pb-1.5">
      <Reorder.Group
        as="div"
        axis="x"
        role="tablist"
        aria-label="Sessions"
        values={sessions.map((s) => s.id)}
        onReorder={(order: string[]) => {
          const id = dragging.current
          if (id) moveTab(id, order.indexOf(id))
        }}
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        <AnimatePresence initial={false}>
          {sessions.map((s) => {
            const active = s.id === activeId
            const env = envName(s.environmentId)
            return (
              <Reorder.Item
                key={s.id}
                value={s.id}
                as="div"
                data-session={s.id}
                onDragStart={() => (dragging.current = s.id)}
                onDragEnd={() => (dragging.current = null)}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault() // no autoscroll; auxclick closes
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  onClose(s)
                }}
                initial={motionSafe ? { opacity: 0, scale: 0.9, y: 4 } : { opacity: 0 }}
                animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
                // Width collapses so the neighbours slide over; nothing waits on it.
                exit={{ opacity: 0, width: 0, paddingLeft: 0, paddingRight: 0, transition: fast }}
                transition={motionSafe ? spring : { ...fast, layout: { duration: 0 } }}
                className={`group relative flex h-8 max-w-[220px] min-w-[120px] shrink-0 cursor-default items-center overflow-hidden rounded-lg text-[12.5px] select-none ${
                  active ? 'text-fg' : 'text-muted hover:bg-white/[0.035] hover:text-fg'
                }`}
              >
                {active &&
                  (motionSafe ? (
                    <motion.span layoutId="terminal-tab-active" transition={spring} className="absolute inset-0 rounded-lg border border-line bg-surface-2" />
                  ) : (
                    <span className="absolute inset-0 rounded-lg border border-line bg-surface-2" />
                  ))}
                <span
                  aria-hidden
                  data-stripe
                  className="absolute inset-y-1.5 left-1 w-[3px] rounded-full"
                  style={{ background: s.color ?? 'var(--accent)' }}
                />
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={env ? `${s.label} · ${env}` : s.label}
                  onClick={() => onSelect(s.id)}
                  className="relative flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3.5 text-left focus-visible:outline-offset-[-2px]"
                >
                  <StatusDot state={s.state} />
                  <span className="truncate font-medium">{s.label}</span>
                  {env && <span className="truncate text-[11.5px] text-muted">{env}</span>}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${s.label}`}
                  onClick={() => onClose(s)}
                  className={`relative mr-1 grid size-5 shrink-0 place-items-center rounded-md text-muted transition-[opacity,background-color,color] hover:bg-white/8 hover:text-fg focus-visible:opacity-100 ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </Reorder.Item>
            )
          })}
        </AnimatePresence>
      </Reorder.Group>
      <motion.button
        type="button"
        aria-label="New local shell"
        title={`New local shell (${formatShortcut('mod+t').join('')})`}
        onClick={onNew}
        whileTap={motionSafe ? { scale: 0.9, rotate: 90 } : undefined}
        transition={spring}
        className="mb-1 grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
      >
        <Plus aria-hidden className="size-3.5" />
      </motion.button>
    </div>
  )
}
