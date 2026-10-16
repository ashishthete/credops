import { useAnimate, useReducedMotion } from 'framer-motion'
import { useEffect } from 'react'

export const spring = { type: 'spring', stiffness: 400, damping: 30 } as const
export const fast = { duration: 0.15 } as const

/** False when the user asked for reduced motion; animated components then skip transforms. */
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}

const SHAKE_X = [0, -8, 8, -5, 5, 0]

/** Returns a ref to attach; every bump of `counter` (after 0) shakes it sideways for 250 ms. */
export function useShake<T extends Element = HTMLDivElement>(counter: number) {
  const motionSafe = useMotionSafe()
  const [scope, animate] = useAnimate<T>()
  useEffect(() => {
    if (counter && motionSafe && scope.current) {
      void animate(scope.current, { x: SHAKE_X }, { duration: 0.25, ease: 'easeOut' })
    }
  }, [counter, motionSafe, animate, scope])
  return scope
}
