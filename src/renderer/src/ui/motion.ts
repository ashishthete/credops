import { useAnimate, useReducedMotion } from 'framer-motion'
import { useEffect } from 'react'

/** Snappy with a hint of bounce (damping ratio ~0.78): near its target in ~120 ms, overshoots ~2%, still by ~210 ms. */
export const spring = { type: 'spring', stiffness: 600, damping: 38 } as const
/** Fades and the reduced-motion fallback. */
export const fast = { duration: 0.12 } as const
/** Leaving is quicker than arriving, so nothing waits on what is going away. */
export const exitFast = { duration: 0.09 } as const

const STAGGER_STEP = 0.02
const STAGGER_MAX = 0.15

/** Delay for the nth item of a cascade: a short step, capped so the whole list is in within 150 ms. */
export const staggerDelay = (index: number, step = STAGGER_STEP): number => Math.min(index * step, STAGGER_MAX)

/** False when the user asked for reduced motion; animated components then skip transforms. */
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}

const SHAKE_X = [0, -8, 8, -5, 5, 0]

/** Returns a ref to attach; every bump of `counter` (after 0) shakes it sideways for 220 ms. */
export function useShake<T extends Element = HTMLDivElement>(counter: number) {
  const motionSafe = useMotionSafe()
  const [scope, animate] = useAnimate<T>()
  useEffect(() => {
    if (counter && motionSafe && scope.current) {
      void animate(scope.current, { x: SHAKE_X }, { duration: 0.22, ease: 'easeOut' })
    }
  }, [counter, motionSafe, animate, scope])
  return scope
}
