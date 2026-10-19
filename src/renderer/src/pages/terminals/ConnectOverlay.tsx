import { motion } from 'framer-motion'
import { Check, Copy, Laptop, RotateCw, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import type { HopState, SessionError, SessionHop, SessionMeta } from '../../../../shared/ssh'
import { Button } from '../../ui/Button'
import { exitFast, fast, spring, useMotionSafe, useShake } from '../../ui/motion'

const LOCAL: SessionHop = { label: 'This Mac', state: 'up' }

const NODE: Record<HopState, string> = {
  pending: 'border-line bg-surface-2 text-muted',
  connecting: 'border-warn/60 bg-warn/15 text-warn',
  up: 'border-ok/60 bg-ok/15 text-ok',
  failed: 'border-err/60 bg-err/15 text-err',
}

export interface ConnectOverlayProps {
  meta: SessionMeta
  onReconnect: () => void
  /** A reconnect is in flight: the button waits instead of sending a second one. */
  reconnecting?: boolean
  onClose: () => void
  /** Shown for a changed key the app stored; the known-hosts manager arrives with the prompts. */
  onOpenKnownHosts?: () => void
}

/**
 * Drawn over the terminal while a session connects or after it failed: the hop chain, and on
 * failure a card with the reason. The backdrop never takes the pointer; only the card does.
 */
export function ConnectOverlay({ meta, onReconnect, reconnecting, onClose, onOpenKnownHosts }: ConnectOverlayProps) {
  const motionSafe = useMotionSafe()
  const failed = meta.state === 'failed'
  const chain = meta.kind === 'ssh' ? [LOCAL, ...meta.hops] : []

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-8 bg-canvas/80 px-6 backdrop-blur-[3px]"
      initial={motionSafe ? { opacity: 0, scale: 0.985 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, scale: 1 } : { opacity: 1 }}
      exit={{ opacity: 0, transition: exitFast }}
      transition={fast}
    >
      {chain.length > 1 && (
        <ol aria-label="Connection path" className="flex max-w-full items-start overflow-x-auto pb-1">
          {chain.map((hop, i) => (
            <li key={`${i}-${hop.label}`} className="flex items-start">
              {i > 0 && <HopLink state={hop.state} />}
              <HopNode hop={hop} first={i === 0} />
            </li>
          ))}
        </ol>
      )}
      {failed ? (
        <FailedCard
          meta={meta}
          onReconnect={onReconnect}
          reconnecting={reconnecting}
          onClose={onClose}
          onOpenKnownHosts={onOpenKnownHosts}
        />
      ) : (
        <motion.p
          className="text-[13px] text-muted"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ ...fast, delay: 0.1 }}
        >
          {meta.attempt > 1 ? 'Reconnecting to ' : 'Connecting to '}
          <span className="font-medium text-fg">{meta.label}</span>…
        </motion.p>
      )}
    </motion.div>
  )
}

function HopNode({ hop, first }: { hop: SessionHop; first: boolean }) {
  const motionSafe = useMotionSafe()
  // Shakes once when this hop fails.
  const shake = useShake<HTMLDivElement>(hop.state === 'failed' ? 1 : 0)
  return (
    <div ref={shake} data-state={hop.state} className="flex w-20 flex-col items-center gap-2">
      <span className="relative grid size-8 place-items-center">
        {hop.state === 'connecting' && motionSafe && (
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-warn/25" />
        )}
        <motion.span
          aria-hidden
          className={`relative grid size-8 place-items-center rounded-full border transition-colors ${NODE[hop.state]}`}
          animate={motionSafe && hop.state === 'up' ? { scale: [1, 1.15, 1] } : undefined}
          transition={{ duration: 0.3 }}
        >
          {first ? (
            <Laptop className="size-3.5" />
          ) : hop.state === 'up' ? (
            <Check className="size-3.5" strokeWidth={2.6} />
          ) : hop.state === 'failed' ? (
            <X className="size-3.5" strokeWidth={2.6} />
          ) : (
            <span className="size-1.5 rounded-full bg-current" />
          )}
        </motion.span>
      </span>
      <span className={`max-w-full truncate text-[11.5px] ${hop.state === 'failed' ? 'text-err' : hop.state === 'pending' ? 'text-muted' : 'text-fg'}`}>
        {hop.label}
      </span>
    </div>
  )
}

/** The line into a hop: fills left to right while it connects, then green when up or red when failed. */
function HopLink({ state }: { state: HopState }) {
  const motionSafe = useMotionSafe()
  return (
    <span aria-hidden className="relative mt-[15px] h-0.5 w-12 shrink-0 overflow-hidden rounded-full bg-line">
      {state === 'connecting' &&
        (motionSafe ? (
          <motion.span
            className="absolute inset-0 origin-left rounded-full bg-warn"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 0.9 }}
            transition={{ duration: 2.4, ease: [0.16, 1, 0.3, 1] }}
          />
        ) : (
          <span className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-warn" />
        ))}
      {(state === 'up' || state === 'failed') && (
        <motion.span
          className={`absolute inset-0 rounded-full ${state === 'up' ? 'bg-ok' : 'bg-err'}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={fast}
        />
      )}
    </span>
  )
}

function FailedCard({
  meta,
  onReconnect,
  reconnecting = false,
  onClose,
  onOpenKnownHosts,
}: Omit<ConnectOverlayProps, 'meta'> & { meta: SessionMeta }) {
  const motionSafe = useMotionSafe()
  const error = meta.error
  const hostKeyChanged = error?.code === 'host-key-changed' && error.hostKey
  const Icon = error?.code.startsWith('host-key') ? ShieldAlert : TriangleAlert
  return (
    <motion.div
      role="alert"
      className="pointer-events-auto w-full max-w-[440px] rounded-[14px] border border-line bg-surface p-5 shadow-pop"
      initial={motionSafe ? { opacity: 0, y: 8, scale: 0.97 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
      transition={motionSafe ? spring : fast}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-err/12 text-err">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold tracking-tight text-fg">
            {`Couldn't connect to ${error?.hopLabel ?? meta.label}`}
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 break-words text-muted">{error?.message ?? 'The connection failed.'}</p>
        </div>
      </div>
      {hostKeyChanged && <HostKeyChanged error={error} onOpenKnownHosts={onOpenKnownHosts} />}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {meta.kind === 'ssh' && (
          <Button size="sm" icon={<RotateCw aria-hidden className="size-3.5" />} loading={reconnecting} onClick={onReconnect}>
            Reconnect
          </Button>
        )}
      </div>
    </motion.div>
  )
}

function HostKeyChanged({ error, onOpenKnownHosts }: { error: SessionError; onOpenKnownHosts?: () => void }) {
  const info = error.hostKey!
  const expected = info.known.filter((k) => k.keyType === info.keyType)
  const openssh = expected.some((k) => k.source === 'openssh')
  const app = expected.some((k) => k.source === 'app')
  return (
    <div className="mt-4 flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg border border-line bg-canvas/60 px-3 py-2.5 text-[12px]">
        {expected.map((k) => (
          <Fingerprint key={`${k.source}-${k.fingerprint}`} term="Expected" value={k.fingerprint} />
        ))}
        <Fingerprint term="Got" value={info.fingerprint} tone="text-err" />
      </dl>
      {openssh && <CopyCommand command={`ssh-keygen -R '${info.host}'`} />}
      {app && onOpenKnownHosts && (
        <Button variant="ghost" size="sm" className="self-start" onClick={onOpenKnownHosts}>
          Open known hosts
        </Button>
      )}
    </div>
  )
}

function Fingerprint({ term, value, tone = 'text-fg' }: { term: string; value: string; tone?: string }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className={`min-w-0 font-mono break-all ${tone}`}>{value}</dd>
    </>
  )
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas/60 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate text-[12px] text-fg">{command}</code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={copy}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
      >
        {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </div>
  )
}
