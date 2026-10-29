import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { exitFast, fast, spring, useMotionSafe, useShake } from './motion'

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
  /**
   * `prompt` sits above every other dialog and keeps focus while it shows: a security question must
   * never hide under one. It also sits above AuthGate (z-[55]); that is safe only because a lock
   * unmounts AppShell, and the PromptHost inside it, after main has settled every prompt. Keep
   * PromptHost inside the gate.
   */
  layer?: 'prompt'
  /**
   * Unsaved input: Esc and a click outside ask "Discard changes?" inside the dialog instead of closing.
   * The dialog's own buttons still call `onClose` straight away.
   */
  dirty?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Modal dialog: focus trap, Esc to close (asking first when `dirty`), focus handed back to the opener on close. */
export function Dialog(props: DialogProps) {
  const opener = useRef<Element | null>(null)
  const wasOpen = useRef(false)
  // Noted while rendering the open: an autoFocus field inside takes focus during commit, before any effect here runs.
  if (props.open && !wasOpen.current && !opener.current) opener.current = document.activeElement

  useLayoutEffect(() => {
    wasOpen.current = props.open
    if (props.open) return
    const el = opener.current
    opener.current = null
    if (el instanceof HTMLElement && el.isConnected) el.focus()
  }, [props.open])

  return (
    <AnimatePresence>
      {props.open && <DialogPanel key="dialog" {...props} onFocusRefused={(el) => (opener.current = el)} />}
    </AnimatePresence>
  )
}

function DialogPanel({
  onClose,
  title,
  description,
  children,
  footer,
  icon,
  shake = 0,
  width = 420,
  layer,
  dirty = false,
  onFocusRefused,
}: DialogProps & { onFocusRefused: (el: Element) => void }) {
  const motionSafe = useMotionSafe()
  const titleId = useId()
  const descId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const shakeScope = useShake(shake)
  const present = useIsPresent()
  const [asking, setAsking] = useState(false)
  // Where focus was when the question came up; Keep editing hands it back.
  const before = useRef<Element | null>(null)
  // Saved or reverted meanwhile: nothing is left to discard.
  if (asking && !dirty) setAsking(false)

  const dismiss = () => {
    if (!dirty) return onClose()
    before.current = document.activeElement
    setAsking(true)
  }
  const keep = () => {
    setAsking(false)
    const el = before.current
    before.current = null
    ;(el instanceof HTMLElement && el.isConnected ? el : panel.current)?.focus()
  }

  useEffect(() => {
    const el = panel.current
    if (el && !el.contains(document.activeElement)) {
      ;(el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus()
    }
  }, [])

  // A prompt keeps focus (and so Esc) while it shows: a dialog opened behind it would otherwise take
  // focus the keyboard can't get back. Whatever was refused gets focus when the prompt closes. A layout
  // effect, so the guard is gone before Dialog hands focus back on close.
  useLayoutEffect(() => {
    if (layer !== 'prompt' || !present) return
    const onFocusIn = (e: FocusEvent) => {
      const el = panel.current
      if (!el || !(e.target instanceof Element) || el.contains(e.target)) return
      onFocusRefused(e.target)
      ;(e.relatedTarget instanceof HTMLElement && el.contains(e.relatedTarget) ? e.relatedTarget : el).focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [layer, present, onFocusRefused])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // Esc answers the question the safe way.
      if (asking) keep()
      else dismiss()
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
      // Still swallows clicks while it fades out, so a second click meant for the dialog (a double-click
      // on Delete) can never land on the page underneath.
      className={`app-no-drag fixed inset-0 ${layer === 'prompt' ? 'z-[60]' : 'z-50'} flex items-center justify-center bg-black/50 px-4 backdrop-blur-md`}
      data-layer={layer}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exitFast }}
      transition={fast}
      onMouseDown={(e) => {
        if (present && e.target === e.currentTarget) dismiss()
      }}
    >
      <div ref={shakeScope} className="w-full" style={{ maxWidth: width }}>
        <motion.div
          ref={panel}
          role="dialog"
          aria-modal="true"
          // Out of the tab order and the accessibility tree once it starts to leave.
          inert={!present}
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop focus:outline-none"
          initial={motionSafe ? { opacity: 0, scale: 0.96, y: 6 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
          exit={motionSafe ? { opacity: 0, scale: 0.97, transition: exitFast } : { opacity: 0, transition: exitFast }}
          transition={motionSafe ? spring : fast}
        >
          <div className="px-5 pt-5">
            {icon}
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[12.5px] leading-5 whitespace-pre-line text-muted">
                {description}
              </p>
            )}
          </div>
          <div className="px-5 pt-4 pb-5">{children}</div>
          {asking ? (
            <div role="alert" className="flex items-center justify-end gap-2 border-t border-line bg-warn/8 px-5 py-3">
              <span className="mr-auto text-[12.5px] font-medium text-fg">Discard changes?</span>
              <Button variant="ghost" size="sm" autoFocus onClick={keep}>
                Keep editing
              </Button>
              <Button variant="danger" size="sm" onClick={onClose}>
                Discard
              </Button>
            </div>
          ) : (
            footer && (
              <div className="flex items-center justify-end gap-2 border-t border-line bg-canvas/40 px-5 py-3">{footer}</div>
            )
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}
