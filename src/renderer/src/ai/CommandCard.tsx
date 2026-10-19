import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, Laptop, Server, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ExplainCommand, Explanation } from '../../../shared/ai'
import { api } from '../lib/api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { fast, useMotionSafe } from '../ui/motion'
import { toast } from '../ui/Toaster'
import type { Tone } from '../ui/tone'

const RISK_TONE: Record<ExplainCommand['risk'], Tone> = { 'read-only': 'success', 'changes-state': 'warn', destructive: 'error' }

export function CommandCard({
  command,
  index,
  requestId,
  target,
  onRun,
}: {
  command: ExplainCommand
  index: number
  requestId: string
  target: Explanation['target']
  onRun: (index: number) => void
}) {
  const motionSafe = useMotionSafe()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const host = command.where === 'host'
  const noHost = host && !target.hostId

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.command)
    } catch {
      toast({ title: "Couldn't copy to the clipboard", tone: 'error' })
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
    void api.invoke('ai:command', requestId, index, 'copy').catch(() => undefined)
  }

  return (
    <li className="rounded-[10px] border border-line bg-surface-2/40 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{command.title}</span>
        <Badge tone="info">
          {host ? <Server aria-hidden className="size-3" /> : <Laptop aria-hidden className="size-3" />}
          {host ? (target.hostLabel ?? 'host') : 'local'}
        </Badge>
        <Badge tone={RISK_TONE[command.risk]}>{command.risk}</Badge>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-md bg-canvas/60 px-2.5 py-1.5 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all text-fg">
        {command.command}
      </pre>
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy()}
          icon={
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={copied ? 'check' : 'copy'}
                className="inline-flex"
                initial={motionSafe ? { scale: 0.5, opacity: 0 } : { opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={motionSafe ? { scale: 0.5, opacity: 0 } : { opacity: 0 }}
                transition={fast}
              >
                {copied ? <Check aria-hidden className="size-3 text-ok" /> : <Copy aria-hidden className="size-3" />}
              </motion.span>
            </AnimatePresence>
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          size="sm"
          variant={command.risk === 'destructive' ? 'danger' : 'ghost'}
          icon={<SquareTerminal aria-hidden className="size-3" />}
          disabled={noHost}
          title={noHost ? 'No host to run this on' : undefined}
          onClick={() => onRun(index)}
        >
          Run in terminal
        </Button>
      </div>
    </li>
  )
}
