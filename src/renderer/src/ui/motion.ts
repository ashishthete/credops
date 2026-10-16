import { useReducedMotion } from 'framer-motion'

export const spring = { type: 'spring', stiffness: 400, damping: 30 } as const
export const fast = { duration: 0.15 } as const

/** False when the user asked for reduced motion; animated components then skip transforms. */
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}
