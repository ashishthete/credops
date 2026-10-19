import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { useMotionSafe } from '../../../ui/motion'

const COUNT = 24
const COLORS = ['var(--ok)', 'var(--accent)', 'var(--warn)', '#9b7bff']

/** A short confetti burst when a release succeeds: 24 particles over 300 ms. Nothing under reduced motion. */
export function Celebrate() {
  const motionSafe = useMotionSafe()
  const particles = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, i) => {
        const angle = (i / COUNT) * Math.PI * 2
        const reach = 36 + (i % 4) * 10
        return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach * 0.6, color: COLORS[i % COLORS.length] }
      }),
    [],
  )
  if (!motionSafe) return null
  return (
    <span aria-hidden data-celebrate className="pointer-events-none absolute top-1/2 left-1/2">
      {particles.map((p, i) => (
        <motion.span
          key={i}
          data-particle
          className="absolute size-1.5 rounded-[2px]"
          style={{ background: p.color }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: p.x, y: p.y, opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        />
      ))}
    </span>
  )
}
