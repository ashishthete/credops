import { motion } from 'framer-motion'
import { RotateCw } from 'lucide-react'
import type { SessionMeta } from '../../../../shared/ssh'
import { ExplainButton } from '../../ai/ExplainPanel'
import { Button } from '../../ui/Button'
import { fast, spring, useMotionSafe } from '../../ui/motion'

/** A thin bar under a closed session; the terminal above it stays readable. */
export function SessionEnded({
  meta,
  onReconnect,
  reconnecting = false,
}: {
  meta: SessionMeta
  onReconnect: () => void
  reconnecting?: boolean
}) {
  const motionSafe = useMotionSafe()
  return (
    <motion.div
      role="status"
      aria-label="Session ended"
      className="flex h-10 shrink-0 items-center gap-3 border-t border-line bg-surface px-4 text-[12.5px]"
      initial={motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
      transition={motionSafe ? spring : fast}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-muted/60" />
      <span className="font-medium text-fg">Session ended</span>
      {meta.error && <span className="min-w-0 truncate text-muted">{meta.error.message}</span>}
      {meta.kind === 'ssh' && meta.error && <ExplainButton className="ml-auto" subject={{ kind: 'session', sessionId: meta.id }} />}
      {meta.kind === 'ssh' && (
        <Button
          size="sm"
          variant="ghost"
          className={meta.error ? '' : 'ml-auto'}
          icon={<RotateCw aria-hidden className="size-3" />}
          loading={reconnecting}
          onClick={onReconnect}
        >
          Reconnect
        </Button>
      )}
    </motion.div>
  )
}
