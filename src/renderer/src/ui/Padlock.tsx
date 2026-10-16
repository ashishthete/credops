import { motion } from 'framer-motion'
import { useMotionSafe } from './motion'

// Bouncier than the house spring: the shackle should visibly pop.
const shackleSpring = { type: 'spring', stiffness: 520, damping: 17 } as const

/** A padlock whose shackle springs up and swings open when `open` flips. */
export function Padlock({ open, className = '' }: { open: boolean; className?: string }) {
  const motionSafe = useMotionSafe()
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`overflow-visible ${className}`}
    >
      <motion.path
        d="M8 11V7a4 4 0 0 1 8 0v4"
        initial={false}
        animate={open ? { y: -3, rotate: -14 } : { y: 0, rotate: 0 }}
        transition={motionSafe ? shackleSpring : { duration: 0 }}
        style={{ transformBox: 'fill-box', transformOrigin: '0% 100%' }}
      />
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
