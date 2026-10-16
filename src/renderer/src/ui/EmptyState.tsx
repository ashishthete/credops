import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { fast, spring, useMotionSafe } from './motion'

export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  text: string
  action?: { label: string; run: () => void }
  /** Several buttons in place of `action`, laid out in a row under the text. */
  actions?: ReactNode
}

export function EmptyState({ icon: Icon, title, text, action, actions }: EmptyStateProps) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <motion.div
        className="relative mb-5 grid size-14 place-items-center rounded-2xl border border-line bg-surface-2 text-accent"
        initial={motionSafe ? { scale: 0.6, rotate: -12, opacity: 0 } : { opacity: 0 }}
        animate={motionSafe ? { scale: 1, rotate: 0, opacity: 1 } : { opacity: 1 }}
        transition={motionSafe ? { ...spring, damping: 14 } : fast}
      >
        <span aria-hidden className="absolute inset-0 rounded-2xl bg-accent/10 blur-xl" />
        <motion.span
          className="relative"
          animate={motionSafe ? { y: [0, -3, 0] } : undefined}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }}
        >
          <Icon aria-hidden className="size-6" strokeWidth={1.8} />
        </motion.span>
      </motion.div>
      <motion.div
        initial={motionSafe ? { opacity: 0, y: 6 } : { opacity: 0 }}
        animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
        transition={{ ...fast, delay: 0.08 }}
        className="flex max-w-sm flex-col items-center"
      >
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">{text}</p>
        {action && (
          <Button className="mt-5" onClick={action.run}>
            {action.label}
          </Button>
        )}
        {actions && <div className="mt-5 flex gap-2">{actions}</div>}
      </motion.div>
    </div>
  )
}
