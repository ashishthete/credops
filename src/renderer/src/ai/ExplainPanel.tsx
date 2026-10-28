import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, CircleCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { commandRisk, type ExplainSubject, type Explanation, type RedactionKind } from '../../../shared/ai'
import { sessionStore } from '../terminal/sessions'
import { tunnelStore } from '../tunnels/store'
import { Badge } from '../ui/Badge'
import { Button, type ButtonProps } from '../ui/Button'
import { registerCommand } from '../ui/commands'
import { ConfirmDialog, plural, type ConfirmRequest } from '../ui/common'
import { fast, spring, useMotionSafe } from '../ui/motion'
import type { Tone } from '../ui/tone'
import { CommandCard } from './CommandCard'
import { closeExplain, explain, explainStore, lastFailureStore, noteFailure } from './explain-store'
import { runInTerminal } from './run-command'
import { useAiConfigured } from './useAiConfigured'

export const NOT_CONFIGURED_HINT = 'Set up Claude in Settings to explain failures'
const PHRASES = ['Reading the last 200 log lines…', 'Redacting secrets…', 'Asking Claude…']
const CONFIDENCE_TONE: Record<Explanation['confidence'], Tone> = { high: 'success', medium: 'warn', low: 'error' }
const REDACTION_NOUN: Record<RedactionKind, [string, string]> = {
  secret: ['secret', 'secrets'],
  key: ['key', 'keys'],
  token: ['token', 'tokens'],
  env: ['environment value', 'environment values'],
  url: ['URL', 'URLs'],
  ip: ['IP address', 'IP addresses'],
  host: ['host name', 'host names'],
  user: ['user name', 'user names'],
  email: ['email address', 'email addresses'],
}

/** `Explain` with a sparkle; disabled with a hint while Claude isn't set up. */
export function ExplainButton({ subject, ...rest }: { subject: ExplainSubject } & Omit<ButtonProps, 'onClick'>) {
  const configured = useAiConfigured()
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Sparkles aria-hidden className="size-3" />}
      disabled={configured !== true}
      title={configured === false ? NOT_CONFIGURED_HINT : undefined}
      onClick={(e) => void explain(subject, e.currentTarget)}
      {...rest}
    >
      Explain
    </Button>
  )
}

/** Tracks the latest tunnel or SSH failure and offers it in the palette. */
function useExplainLastCommand(): void {
  const tunnels = useSyncExternalStore(tunnelStore.subscribe, tunnelStore.get)
  const sessions = useSyncExternalStore(sessionStore.subscribe, sessionStore.get)
  const last = useSyncExternalStore(lastFailureStore.subscribe, lastFailureStore.get)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    const failedNow = new Set<string>()
    for (const r of Object.values(tunnels.runtime)) {
      if (r.state !== 'failed') continue
      failedNow.add(`t:${r.id}`)
      if (!seen.current.has(`t:${r.id}`)) noteFailure({ kind: 'tunnel', tunnelId: r.id })
    }
    for (const m of sessions.sessions) {
      if (m.kind !== 'ssh' || !m.error) continue
      const key = `s:${m.id}:${m.attempt}`
      failedNow.add(key)
      if (!seen.current.has(key)) noteFailure({ kind: 'session', sessionId: m.id })
    }
    seen.current = failedNow
  }, [tunnels, sessions])

  useEffect(() => {
    if (!last) return
    return registerCommand({
      id: 'ai.explain-last',
      title: 'Explain last failure',
      section: 'AI',
      keywords: ['claude', 'why', 'error', 'fix'],
      run: () => void explain(last, null),
    })
  }, [last])
}

function Loading({ motionSafe }: { motionSafe: boolean }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 1800)
    return () => clearInterval(t)
  }, [])
  const bar = (w: string) =>
    motionSafe ? (
      <div data-shimmer aria-hidden className={`skeleton-shimmer h-3 rounded-md ${w}`} />
    ) : (
      <div aria-hidden className={`h-3 rounded-md bg-surface-2 ${w}`} />
    )
  return (
    <div className="space-y-4" aria-busy="true">
      <p role="status" className="text-[12.5px] text-muted">
        {PHRASES[i]}
      </p>
      <div className="space-y-2">
        {bar('w-3/4')}
        {bar('w-full')}
        {bar('w-5/6')}
        {bar('w-2/3')}
      </div>
    </div>
  )
}

function Answer({ e, requestId, onRun }: { e: Explanation; requestId: string; onRun: (i: number) => void }) {
  const [showCause, setShowCause] = useState(false)
  const [done, setDone] = useState<Set<number>>(new Set())
  const counts = Object.entries(e.redactions).filter(([, n]) => (n ?? 0) > 0) as [RedactionKind, number][]
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Badge tone={CONFIDENCE_TONE[e.confidence]} dot>
          {`${e.confidence[0].toUpperCase()}${e.confidence.slice(1)} confidence`}
        </Badge>
        <p className="text-[15px] leading-6 font-medium text-fg">{e.summary}</p>
      </div>

      <section>
        <button
          type="button"
          aria-expanded={showCause}
          className="flex items-center gap-1 text-[12.5px] font-semibold text-fg"
          onClick={() => setShowCause((v) => !v)}
        >
          <ChevronRight aria-hidden className={`size-3.5 transition-transform ${showCause ? 'rotate-90' : ''}`} />
          Cause
        </button>
        {showCause && <p className="mt-1.5 pl-[18px] text-[12.5px] leading-5 text-muted">{e.cause}</p>}
      </section>

      {e.steps.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[12.5px] font-semibold text-fg">Fix steps</h3>
          <ol className="space-y-1">
            {e.steps.map((s, i) => {
              const on = done.has(i)
              return (
                <li key={i}>
                  <button
                    type="button"
                    aria-pressed={on}
                    className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] leading-5 hover:bg-surface-2/60"
                    onClick={() =>
                      setDone((d) => {
                        const n = new Set(d)
                        if (n.has(i)) n.delete(i)
                        else n.add(i)
                        return n
                      })
                    }
                  >
                    {on ? (
                      <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
                    ) : (
                      <span aria-hidden className="mt-px w-3.5 shrink-0 text-center text-muted tabular-nums">
                        {i + 1}
                      </span>
                    )}
                    <span className={on ? 'text-muted line-through' : 'text-fg'}>{s}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {e.commands.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[12.5px] font-semibold text-fg">Commands</h3>
          <ul className="space-y-2">
            {e.commands.map((c, i) => (
              <CommandCard key={i} command={c} index={i} requestId={requestId} target={e.target} onRun={onRun} />
            ))}
          </ul>
        </section>
      )}

      <details className="rounded-[10px] border border-line px-3 py-2 text-[12px] text-muted">
        <summary className="cursor-pointer font-medium text-fg">Sent to Claude</summary>
        <p className="mt-2">
          {counts.length ? counts.map(([k, n]) => `${plural(n, REDACTION_NOUN[k][0], REDACTION_NOUN[k][1])} redacted`).join(' · ') : 'Nothing needed redacting'}
          {` · ${e.model} · server-side fallback on`}
        </p>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-canvas/60 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all">
          {e.sentContext}
        </pre>
      </details>
    </div>
  )
}

/** The right-side Explain drawer. Opening it reads; only a confirmed Run in terminal writes to a session. */
export function ExplainPanel() {
  const s = useSyncExternalStore(explainStore.subscribe, explainStore.get)
  const motionSafe = useMotionSafe()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const panel = useRef<HTMLElement>(null)
  useExplainLastCommand()

  useEffect(() => {
    if (!s.open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeExplain()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [s.open])

  const onRun = (index: number) => {
    const e = s.explanation
    const requestId = s.requestId
    const c = e?.commands[index]
    if (!e || !c || !requestId) return
    const host = c.where === 'host'
    setConfirm({
      title: host ? `Run on ${e.target.hostLabel ?? 'the host'}?` : 'Run locally?',
      description: host
        ? 'Opens a new terminal on the host and types this command. Read it first.'
        : 'Opens a local shell and types this command. Read it first.',
      code: c.command,
      confirmLabel: commandRisk(c.command, c.risk) === 'destructive' ?'Run destructive command' : 'Run',
      ...(e.target.protected && e.target.environmentName ? { typeToConfirm: e.target.environmentName } : {}),
      run: () =>
        runInTerminal(e, requestId, index, () => {
          closeExplain()
          navigate('/terminals')
        }),
    })
  }

  return (
    <>
      <AnimatePresence>
        {s.open && (
          <motion.aside
            ref={panel}
            key="explain"
            role="dialog"
            aria-label="Explain failure"
            tabIndex={-1}
            data-motion={motionSafe ? 'slide' : undefined}
            className="fixed inset-y-0 right-0 z-40 flex w-[min(440px,100vw)] flex-col border-l border-line bg-surface shadow-pop focus:outline-none"
            initial={motionSafe ? { x: '100%' } : { opacity: 0 }}
            animate={motionSafe ? { x: 0 } : { opacity: 1 }}
            exit={motionSafe ? { x: '100%', transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
          >
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
              <Sparkles aria-hidden className="size-4 text-accent" />
              <h2 className="flex-1 text-[13.5px] font-semibold text-fg">Explain failure</h2>
              <button type="button" aria-label="Close" className="rounded p-1 text-muted hover:text-fg" onClick={closeExplain}>
                <X aria-hidden className="size-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {s.state === 'loading' && <Loading motionSafe={motionSafe} />}
              {s.state === 'error' && (
                <p role="alert" className="text-[12.5px] leading-5 text-err">
                  {s.error}
                </p>
              )}
              {s.state === 'ready' && s.explanation && s.requestId && <Answer e={s.explanation} requestId={s.requestId} onRun={onRun} />}
            </div>
            {s.state === 'loading' && (
              <footer className="flex justify-end border-t border-line px-4 py-3">
                <Button variant="ghost" size="sm" onClick={closeExplain}>
                  Cancel
                </Button>
              </footer>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
