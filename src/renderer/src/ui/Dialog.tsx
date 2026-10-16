import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { fast, spring, useMotionSafe, useShake } from './motion'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  /** Shown above the title. */
  icon?: ReactNode
  /** Bump to shake the card, e.g. after a wrong password. */
  shake?: number
  width?: number
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Modal dialog: focus trap, Esc to close, focus handed back to the opener on close. */
export function Dialog(props: DialogProps) {
  const opener = useRef<Element | null>(null)

  useLayoutEffect(() => {
    if (props.open) {
      opener.current = document.activeElement
      return
    }
    const el = opener.current
    opener.current = null
    if (el instanceof HTMLElement && el.isConnected) el.focus()
  }, [props.open])

  return <AnimatePresence>{props.open && <DialogPanel key="dialog" {...props} />}</AnimatePresence>
}

function DialogPanel({ onClose, title, description, children, footer, icon, shake = 0, width = 420 }: DialogProps) {
  const motionSafe = useMotionSafe()
  const titleId = useId()
  const descId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const shakeScope = useShake(shake)

  useEffect(() => {
    const el = panel.current
    if (el && !el.contains(document.activeElement)) {
      ;(el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab' && panel.current) {
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fast}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={shakeScope} className="w-full" style={{ maxWidth: width }}>
        <motion.div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop focus:outline-none"
          initial={motionSafe ? { opacity: 0, scale: 0.96, y: 6 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
          exit={motionSafe ? { opacity: 0, scale: 0.97, transition: fast } : { opacity: 0, transition: fast }}
          transition={motionSafe ? spring : fast}
        >
          <div className="px-5 pt-5">
            {icon}
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[12.5px] leading-5 text-muted">
                {description}
              </p>
            )}
          </div>
          <div className="px-5 pt-4 pb-5">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line bg-canvas/40 px-5 py-3">{footer}</div>
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}
