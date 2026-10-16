import { motion, type HTMLMotionProps } from 'framer-motion'
import { LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { spring, useMotionSafe } from './motion'

type Variant = 'primary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  children?: ReactNode
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-[0_1px_0_0_rgb(255_255_255/0.18)_inset,0_6px_16px_-6px_var(--accent)] hover:brightness-110',
  ghost: 'border border-line bg-surface-2/60 text-fg hover:border-muted/40 hover:bg-surface-2',
  danger:
    'bg-err/12 text-err shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--err)_35%,transparent)] hover:bg-err/20',
}

const sizes: Record<Size, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12.5px]',
  md: 'h-9 gap-2 px-3.5 text-[13px]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  disabled,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const motionSafe = useMotionSafe()
  const inert = disabled || loading
  return (
    <motion.button
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      whileHover={motionSafe && !inert ? { y: -1 } : undefined}
      whileTap={motionSafe && !inert ? { scale: 0.97 } : undefined}
      transition={spring}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-[background-color,border-color,filter,opacity] select-none ${
        loading ? 'cursor-wait opacity-85' : 'disabled:cursor-not-allowed disabled:opacity-55'
      } ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <LoaderCircle
          aria-hidden
          className={`size-3.5 ${motionSafe ? 'animate-spin' : 'animate-pulse'}`}
          strokeWidth={2.4}
        />
      ) : (
        icon
      )}
      {children}
    </motion.button>
  )
}
