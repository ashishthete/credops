import { useId, type CSSProperties } from 'react'
import { toneColor, type Tone } from './tone'

const W = 100
const H = 24

const num = (n: number) => Number(n.toFixed(2))

/** Polyline points in a 100x24 box; the largest value (or `max`) touches the top, zero the bottom. */
export function sparkPoints(samples: number[], max?: number): string {
  const values = samples.filter(Number.isFinite)
  if (max === undefined || !Number.isFinite(max)) max = Math.max(0, ...values)
  if (values.length === 0) return ''
  const y = (v: number) => (max > 0 ? num(H - (Math.min(Math.max(v, 0), max) / max) * H) : H)
  if (values.length === 1) return `0,${y(values[0])} ${W},${y(values[0])}`
  const last = values.length - 1
  return values.map((v, i) => `${num((i / last) * W)},${y(v)}`).join(' ')
}

export interface SparklineProps {
  values: number[]
  max?: number
  tone: Tone
  /** What the series shows, read by screen readers in place of the drawing. */
  label: string
  className?: string
}

export function Sparkline({ values, max, tone, label, className = '' }: SparklineProps) {
  const gradient = useId()
  const points = sparkPoints(values, max)
  const first = points.split(' ')[0]?.split(',')[0] ?? '0'
  const last = points.split(' ').at(-1)?.split(',')[0] ?? String(W)
  return (
    <span className={`inline-block ${className}`} style={{ '--tone': toneColor[tone] } as CSSProperties}>
      <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-full w-full overflow-visible">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--tone)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--tone)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {points && (
          <>
            <polygon points={`${points} ${last},${H} ${first},${H}`} fill={`url(#${gradient})`} />
            <polyline
              points={points}
              fill="none"
              stroke="var(--tone)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}
