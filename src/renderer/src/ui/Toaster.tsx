import { AnimatePresence, motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { fast, spring, useMotionSafe } from './motion'
import { toneColor, type Tone } from './tone'

export interface ToastOptions {
  title: string
  description?: string
  tone?: Tone
  action?: { label: string; run: () => void }
}

interface ToastItem extends ToastOptions {
  id: string
  tone: Tone
}

const MAX_VISIBLE = 4
const DURATION_MS = 5000

let toasts: readonly ToastItem[] = []
let nextId = 0
const listeners = new Set<() => void>()

function setToasts(next: readonly ToastItem[]) {
  toasts = next
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Shows a toast and returns its id. Errors stay until dismissed; others leave after 5 s. */
export function toast(opts: ToastOptions): string {
  const id = `toast-${++nextId}`
  let next = [...toasts, { ...opts, id, tone: opts.tone ?? 'info' }]
  // Over the cap: drop the oldest non-error first, so failures are not lost to chatter.
  while (next.length > MAX_VISIBLE) {
    const victim = next.findIndex((t) => t.tone !== 'error')
    next = next.filter((_, i) => i !== (victim === -1 ? 0 : victim))
  }
  setToasts(next)
  return id
}

export function dismissToast(id: string): void {
  if (toasts.some((t) => t.id === id)) setToasts(toasts.filter((t) => t.id !== id))
}

export function clearToasts(): void {
  if (toasts.length) setToasts([])
}

const icons: Record<Tone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
}

/** Bottom-right toast stack. Mount once. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => toasts)
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2"
    >
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({ item }: { item: ToastItem }) {
  const motionSafe = useMotionSafe()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const remaining = useRef(DURATION_MS)
  const persistent = item.tone === 'error'
  const Icon = icons[item.tone]

  useEffect(() => {
    if (persistent || paused) return
    const startedAt = Date.now()
    const timer = setTimeout(() => dismissToast(item.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt))
    }
  }, [item.id, paused, persistent])

  return (
    <motion.div
      layout={motionSafe ? 'position' : false}
      role={persistent ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
      }}
      initial={motionSafe ? { opacity: 0, y: 24, scale: 0.95 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
      exit={motionSafe ? { opacity: 0, x: 48, scale: 0.96, transition: fast } : { opacity: 0, transition: fast }}
      transition={motionSafe ? spring : fast}
      style={{ '--tone': toneColor[item.tone] } as CSSProperties}
      className={`pointer-events-auto relative overflow-hidden rounded-ui border border-line bg-surface-2/95 shadow-pop backdrop-blur-xl ${
        paused ? 'toast-paused' : ''
      }`}
    >
      <div className="flex items-start gap-3 py-3 pr-2 pl-3.5">
        <span className="tone-soft mt-0.5 grid size-6 shrink-0 place-items-center rounded-full">
          <Icon aria-hidden className="size-3.5" strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13px] leading-5 font-medium text-fg">{item.title}</p>
          {item.description && <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{item.description}</p>}
          {item.action && (
            <button
              type="button"
              onClick={() => {
                item.action!.run()
                dismissToast(item.id)
              }}
              className="mt-2 rounded-md px-2 py-1 -ml-2 text-[12.5px] font-medium text-(--tone) transition-colors hover:bg-white/5"
            >
              {item.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismissToast(item.id)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      {!persistent && (
        <span
          aria-hidden
          className="toast-drain absolute inset-x-0 bottom-0 h-0.5 bg-(--tone) opacity-60"
          style={{ animationDuration: `${DURATION_MS}ms` }}
        />
      )}
    </motion.div>
  )
}
