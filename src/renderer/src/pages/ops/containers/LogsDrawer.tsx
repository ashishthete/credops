import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { RotateCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { LOG_TAIL_DEFAULT } from '../../../../../shared/ops'
import type { SessionError } from '../../../../../shared/ssh'
import { api } from '../../../lib/api'
import { clearFollow, followStore, onContainerLog } from '../../../ops/containers'
import { OutputPane } from '../../../ops/OutputPane'
import type { HostOutput } from '../../../ops/runs'
import { Button } from '../../../ui/Button'
import { attempt } from '../../../ui/common'
import { SelectField } from '../../../ui/Field'
import { fast, spring, useMotionSafe } from '../../../ui/motion'
import { Switch } from '../../../ui/Switch'
import { vaultStatusStore } from '../../../vault/status'

export const TAILS = [100, 200, 1000, 5000] as const

/**
 * What the drawer shows. `follow` starts a live follow and resolves with its followId (lines arrive as
 * `containers:logs` events). With `snapshot` the drawer opens on a tail snapshot and a Follow switch;
 * without it the drawer is always live. `hint` is an action shown under the end of a follow.
 */
export interface LogsTarget {
  /** What the drawer is following; a new id starts over. Defaults to the title. */
  id?: string
  title: string
  follow: (tail: number) => Promise<string | undefined>
  snapshot?: (tail: number) => Promise<string | undefined>
  hint?: { label: string; run: () => void }
}
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside the sheet. */
function trapTab(e: globalThis.KeyboardEvent, sheet: HTMLElement): void {
  if (e.key !== 'Tab' || e.defaultPrevented) return
  const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)]
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
    e.preventDefault()
    first.focus()
  }
}

/** Logs in a side sheet: a tail snapshot, or a live follow that stops on close. */
export function LogsDrawer({ target, onClose }: { target: LogsTarget | null; onClose: () => void }) {
  const motionSafe = useMotionSafe()
  return (
    <AnimatePresence>
      {target && (
        <>
          <motion.div
            key="scrim"
            aria-hidden
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fast}
            className="app-no-drag fixed inset-0 z-30 bg-black/30"
          />
          <motion.aside
            key="sheet"
            role="dialog"
            aria-label={target.title}
            aria-modal="true"
            initial={motionSafe ? { x: '100%' } : { opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={motionSafe ? { x: '100%', transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            className="fixed top-0 right-0 bottom-0 z-40 flex w-[min(640px,90vw)] flex-col border-l border-line bg-surface shadow-pop"
          >
            <LogsBody key={target.id ?? target.title} target={target} onClose={onClose} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

function LogsBody({ target, onClose }: { target: LogsTarget; onClose: () => void }) {
  const { title, hint } = target
  const live = !target.snapshot
  // The latest callbacks; the effects below restart on the tail and the switch, not on a caller's re-render.
  const fns = useRef(target)
  fns.current = target
  const [tail, setTail] = useState<number>(LOG_TAIL_DEFAULT)
  const [following, setFollowing] = useState(live)
  const [text, setText] = useState<string | null>(null)
  const [followId, setFollowId] = useState<string | null>(null)
  const [endNote, setEndNote] = useState(false)
  const [endError, setEndError] = useState<SessionError | null>(null)
  const vault = useSyncExternalStore(vaultStatusStore.subscribe, vaultStatusStore.get)
  // A follow the lock ended can only start again once the vault is open.
  const waitingUnlock = endError?.code === 'locked' && vault?.unlocked === false
  // False while the sheet animates out: the follow stops at the close, not after the animation.
  const present = useIsPresent()
  const presentRef = useRef(present)
  presentRef.current = present
  // Every follow this sheet started, cleared from the store when it unmounts.
  const started = useRef(new Set<string>())
  const closeRef = useRef<HTMLButtonElement>(null)
  const liveId = useRef<string | null>(null)
  // Follows that ended, including one that ended before its reply named it.
  const endedIds = useRef(new Map<string, SessionError | null>())
  // Chars ever received per follow, so the pane knows what is new once the text is trimmed at its cap.
  const totals = useRef(new Map<string, number>())
  const [, bump] = useState(0)
  const followed = useSyncExternalStore(followStore.subscribe, followStore.get)

  useEffect(() => closeRef.current?.focus(), [])
  useEffect(
    () => () => {
      for (const id of started.current) clearFollow(id)
    },
    [],
  )
  // Escape closes and Tab stays inside, from anywhere, while the sheet is open.
  useEffect(() => {
    if (!present) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      // Something above the sheet (the palette) may have used the key already.
      if (e.defaultPrevented) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Tab') {
        const sheet = closeRef.current?.closest<HTMLElement>('[role="dialog"]')
        if (sheet) trapTab(e, sheet)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [present, onClose])
  useEffect(
    () =>
      onContainerLog((event) => {
        if ('chunk' in event) totals.current.set(event.followId, (totals.current.get(event.followId) ?? 0) + event.chunk.length)
        else {
          endedIds.current.set(event.followId, event.error)
          if (event.followId === liveId.current) {
            setEndNote(true)
            setEndError(event.error)
            setFollowing(false)
          }
        }
        bump((n) => n + 1)
      }),
    [],
  )

  // A snapshot while not following (with a snapshot to take).
  useEffect(() => {
    const snapshot = fns.current.snapshot
    if (following || !snapshot) return
    let stale = false
    setText(null)
    void attempt("Couldn't load the logs", () => snapshot(tail)).then((out) => {
      if (!stale && out !== undefined) setText(out)
    })
    return () => {
      stale = true
    }
  }, [following, tail])

  // A follow lives exactly as long as the switch is on, the tail unchanged and the drawer open.
  useEffect(() => {
    if (!following || !present) return
    let cancelled = false
    let id: string | null = null
    setEndNote(false)
    setEndError(null)
    const follow = fns.current.follow
    void attempt("Couldn't follow the logs", () => follow(tail)).then((got) => {
      if (got === undefined) {
        if (!cancelled) setFollowing(false)
        return
      }
      id = got
      started.current.add(got)
      if (cancelled) return void stop(got, true)
      // It ended before this reply named it.
      if (endedIds.current.has(got)) {
        setEndNote(true)
        setEndError(endedIds.current.get(got) ?? null)
        setFollowing(false)
        return
      }
      liveId.current = got
      setFollowId(got)
    })
    return () => {
      cancelled = true
      liveId.current = null
      // While the sheet animates out its last lines stay on screen; unmounting clears them. A live-only
      // drawer also keeps the lines of a follow that ended on its own, until the next follow names its own.
      const closing = !presentRef.current
      const keep = closing || (live && !!id && endedIds.current.has(id))
      if (!keep) setFollowId(null)
      if (id) void stop(id, !keep)
    }
  }, [following, present, tail, live])

  const output = useMemo<HostOutput | undefined>(() => {
    if (following || live) {
      const t = followId ? followed[followId] : undefined
      return t === undefined || !followId ? undefined : { text: t, errRanges: [], total: totals.current.get(followId) ?? t.length }
    }
    return text === null ? undefined : { text, errRanges: [], total: text.length }
  }, [following, live, followId, followed, text])

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-fg">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close logs"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-muted hover:text-fg"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="flex items-end gap-5 px-5 py-3">
        <div className="w-32">
          <SelectField label="Tail" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAILS.map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </SelectField>
        </div>
        {!live && (
          <label className="flex h-9 items-center gap-2 text-[12.5px] text-fg/85">
            <Switch label="Follow" checked={following} onChange={setFollowing} />
            Follow
          </label>
        )}
        {endNote && !endError && <span className="pb-2.5 text-[12px] text-muted">The follow ended</span>}
        {live && endNote && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCw aria-hidden className="size-3.5" />}
            disabled={waitingUnlock}
            title={waitingUnlock ? 'Unlock the vault first' : undefined}
            onClick={() => setFollowing(true)}
            className="mb-0.5"
          >
            Follow again
          </Button>
        )}
      </div>
      {endError && (
        <motion.div
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={fast}
          className="mx-5 mb-3 flex items-center gap-3 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-[12.5px] text-fg/90"
        >
          <span className="min-w-0 flex-1">{endError.message}</span>
          {hint && (
            <Button size="sm" variant="ghost" onClick={hint.run}>
              {hint.label}
            </Button>
          )}
        </motion.div>
      )}
      <div className="min-h-0 flex-1 px-5 pb-5">
        <OutputPane key={`${following}:${followId}:${tail}`} output={output} label={title} dimTimestamps className="h-full max-h-none" />
      </div>
    </>
  )
}

function stop(followId: string, clear: boolean): Promise<void> {
  if (clear) clearFollow(followId)
  return api.invoke('containers:unfollow', followId).catch(() => {})
}
