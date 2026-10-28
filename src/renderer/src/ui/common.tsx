import { AnimatePresence, motion } from 'framer-motion'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cleanIpcErrorMessage, errorCode } from '../lib/api'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { TextField } from './Field'
import { exitFast, fast, spring, staggerDelay, useMotionSafe } from './motion'
import { toast } from './Toaster'
import { withUnlock } from '../vault/unlock'

export const errorText = (err: unknown) => cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

export function fail(title: string, err: unknown): void {
  toast({ title, description: errorText(err), tone: 'error' })
}

/**
 * Runs a vault action through withUnlock (a lock mid-session brings up the gate and retries once).
 * Errors become a toast titled `failTitle`, or go to `onError` instead when a form shows them inline;
 * resolves undefined on failure or when no unlock happened.
 */
export async function attempt<T>(failTitle: string, fn: () => Promise<T>, onError?: (message: string, code?: string) => void): Promise<T | undefined> {
  try {
    return await withUnlock(fn)
  } catch (err) {
    if (onError) onError(errorText(err), errorCode(err))
    else fail(failTitle, err)
    return undefined
  }
}

export const VAULT_COLORS = [
  { name: 'Blue', hex: '#5b8cff' },
  { name: 'Violet', hex: '#9b7bff' },
  { name: 'Pink', hex: '#ef6fae' },
  { name: 'Red', hex: '#ef5b5b' },
  { name: 'Amber', hex: '#f2a93b' },
  { name: 'Green', hex: '#2fbf71' },
  { name: 'Teal', hex: '#2bb8b0' },
  { name: 'Slate', hex: '#8a91a3' },
] as const

/** A row of color swatches as a radio group. */
export function ColorPicker({ value, onChange, label = 'Color' }: { value: string; onChange: (hex: string) => void; label?: string }) {
  const motionSafe = useMotionSafe()
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {VAULT_COLORS.map((c) => {
        const checked = c.hex.toLowerCase() === value.toLowerCase()
        return (
          <motion.button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={c.name}
            title={c.name}
            onClick={() => onChange(c.hex)}
            whileTap={motionSafe ? { scale: 0.85 } : undefined}
            transition={spring}
            className="relative grid size-6 place-items-center rounded-full"
          >
            <span className="size-4 rounded-full" style={{ background: c.hex }} />
            {checked && (
              <motion.span
                layoutId={motionSafe ? `${label}-ring` : undefined}
                transition={spring}
                className="absolute inset-0 rounded-full"
                style={{ boxShadow: `inset 0 0 0 2px ${c.hex}` }}
              />
            )}
          </motion.button>
        )
      })}
    </div>
  )
}

export interface MenuItem {
  label: string
  icon: LucideIcon
  run: () => void
  danger?: boolean
}

/**
 * Open, close, focus and keys for a small popover menu. Opening focuses the first item; arrows, Home and
 * End move; Escape closes back to the trigger; Tab and a click outside just close. If the trigger goes
 * away while it holds focus (picking the last choice can do that), focus moves to `fallback`.
 */
export function useMenuPopover({ itemSelector = '[role^="menuitem"]', fallback }: { itemSelector?: string; fallback?: () => HTMLElement | null } = {}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const anchor = useRef(fallback)
  anchor.current = fallback

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>(itemSelector)?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, itemSelector])

  // Runs before the trigger leaves the DOM, while it can still say whether it had focus.
  useLayoutEffect(() => {
    const el = trigger.current
    return () => {
      if (!el?.contains(document.activeElement)) return
      queueMicrotask(() => {
        if (!document.activeElement || document.activeElement === document.body) anchor.current?.()?.focus()
      })
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      els[(n + els.length) % els.length]?.focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(els.length - 1)
    else if (e.key === 'Tab') close(false)
  }

  return {
    open,
    setOpen,
    close,
    triggerProps: { ref: trigger, 'aria-haspopup': 'menu' as const, 'aria-expanded': open, 'aria-controls': open ? menuId : undefined },
    menuProps: { ref: menu, id: menuId, role: 'menu', onKeyDown },
  }
}

/** A "⋯" button with a small popover menu. `extra` renders above the items (e.g. swatches). */
export function RowMenu({
  label,
  items,
  extra,
  className = '',
}: {
  label: string
  items: MenuItem[]
  extra?: (close: () => void) => ReactNode
  className?: string
}) {
  const motionSafe = useMotionSafe()
  const { open, setOpen, close, triggerProps, menuProps } = useMenuPopover()

  return (
    <div className={`relative ${className}`}>
      <button
        {...triggerProps}
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={`grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg ${
          open ? 'bg-white/6 text-fg' : ''
        }`}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            {...menuProps}
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            initial={motionSafe ? { opacity: 0, scale: 0.94, y: -4 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
            exit={motionSafe ? { opacity: 0, scale: 0.96, transition: exitFast } : { opacity: 0, transition: exitFast }}
            transition={motionSafe ? spring : fast}
            style={{ transformOrigin: 'top right' }}
            className="absolute top-full right-0 z-40 mt-1 w-[184px] rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
          >
            {extra?.(() => close())}
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  item.run()
                }}
                className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] transition-colors focus:outline-none ${
                  item.danger
                    ? 'text-err hover:bg-err/12 focus:bg-err/12'
                    : 'text-fg/90 hover:bg-white/6 focus:bg-white/6'
                }`}
              >
                <item.icon aria-hidden className="size-3.5 opacity-80" />
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  /** When set, the user must type this exactly before confirming. */
  typeToConfirm?: string
  /** The action can't go ahead yet; `description` says why and the confirm button stays off. */
  blocked?: boolean
  /** Exact text the action uses (a command), shown verbatim in a mono block. */
  code?: string
  /** A checkbox shown above the confirm button; `run` receives its state. */
  option?: { label: string; defaultChecked: boolean }
  /** For a choice that isn't destructive: a plain confirm button and this cancel label, with no "can't be undone" line. */
  gentle?: { cancelLabel: string }
  /** Resolving `{ refused }` keeps the dialog open and shows the message in it; anything else closes it. */
  run: (checked?: boolean) => Promise<unknown>
}

/** A destructive confirmation; open while `request` is non-null. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const formId = useId()
  // Keep the last request while the dialog animates out.
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current

  useEffect(() => {
    if (request) {
      setTyped('')
      setRefused(null)
      setChecked(request.option?.defaultChecked ?? false)
    }
  }, [request])

  const ready = !r?.blocked && (!r?.typeToConfirm || typed === r.typeToConfirm)
  const confirm = async () => {
    if (!request || !ready || busy) return
    setBusy(true)
    setRefused(null)
    let keepOpen = false
    try {
      const out = await (request.option ? request.run(checked) : request.run())
      if (out && typeof out === 'object' && 'refused' in out && typeof out.refused === 'string') {
        keepOpen = true
        setRefused(out.refused)
      }
    } finally {
      setBusy(false)
      if (!keepOpen) onClose()
    }
  }

  return (
    <Dialog
      open={!!request}
      onClose={onClose}
      title={r?.title ?? ''}
      description={r?.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {r?.gentle?.cancelLabel ?? 'Cancel'}
          </Button>
          <Button variant={r?.gentle ? 'primary' : 'danger'} form={formId} type="submit" disabled={!ready} loading={busy}>
            {r?.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        {r?.code && (
          <pre className="mb-3 max-h-40 overflow-auto rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap text-fg">
            {r.code}
          </pre>
        )}
        {r?.blocked ? null : r?.typeToConfirm ? (
          <TextField
            autoFocus
            label={`Type ${r.typeToConfirm} to confirm`}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              setRefused(null)
            }}
            spellCheck={false}
            autoComplete="off"
          />
        ) : r?.gentle ? null : (
          <p className="text-[12.5px] text-muted">This can't be undone.</p>
        )}
        {r?.option && !r.blocked && (
          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-fg/90">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="size-3.5 rounded accent-(--accent)"
            />
            {r.option.label}
          </label>
        )}
        {refused && (
          <p role="alert" className="mt-2 text-[12.5px] text-err">
            {refused}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** Count with its noun, e.g. "1 secret", "3 keys". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Shared row chrome for the three lists; wrap them in <AnimatePresence initial={stagger}>. */
export function ListRow({
  label,
  index,
  stagger,
  children,
}: {
  label: string
  index: number
  stagger: boolean
  children: ReactNode
}) {
  const motionSafe = useMotionSafe()
  // Rows cascade in on a fresh load; rows added later just slide in.
  const delay = stagger && motionSafe ? staggerDelay(index) : 0
  return (
    <motion.li
      layout={motionSafe ? 'position' : false}
      aria-label={label}
      initial={motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }}
      animate={{ opacity: 1, y: 0 }}
      exit={motionSafe ? { opacity: 0, x: -12, transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? { ...spring, delay } : fast}
      className="group relative flex min-h-14 items-center gap-3 border-b border-line/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-white/[0.022]"
    >
      {children}
    </motion.li>
  )
}
