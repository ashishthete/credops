import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { LOG_TAIL_DEFAULT } from '../../../../../shared/ops'
import { api } from '../../../lib/api'
import { clearFollow, followStore, onContainerLog } from '../../../ops/containers'
import { OutputPane } from '../../../ops/OutputPane'
import type { HostOutput } from '../../../ops/runs'
import { attempt } from '../../../ui/common'
import { SelectField } from '../../../ui/Field'
import { fast, spring, useMotionSafe } from '../../../ui/motion'
import { Switch } from '../../../ui/Switch'

const TAILS = [100, 200, 1000, 5000] as const
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside the sheet. */
function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)]
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !e.currentTarget.contains(document.activeElement))) {
    e.preventDefault()
    first.focus()
  }
}

/** The logs of one container in a side sheet: a tail snapshot, or a live follow that stops on close. */
export function LogsDrawer({
  target,
  onClose,
}: {
  target: { hostId: string; environmentId: string | null; ref: string } | null
  onClose: () => void
}) {
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
            className="fixed inset-0 z-30 bg-black/30"
          />
          <motion.aside
            key="sheet"
            role="dialog"
            aria-label={`Logs of ${target.ref}`}
            aria-modal="true"
            onKeyDown={trapTab}
            initial={motionSafe ? { x: '100%' } : { opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={motionSafe ? { x: '100%', transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            className="fixed top-0 right-0 bottom-0 z-40 flex w-[min(640px,90vw)] flex-col border-l border-line bg-surface shadow-pop"
          >
            <LogsBody target={target} onClose={onClose} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

function LogsBody({ target, onClose }: { target: { hostId: string; environmentId: string | null; ref: string }; onClose: () => void }) {
  const { hostId, environmentId, ref } = target
  const [tail, setTail] = useState<number>(LOG_TAIL_DEFAULT)
  const [following, setFollowing] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [followId, setFollowId] = useState<string | null>(null)
  const [endNote, setEndNote] = useState(false)
  // False while the sheet animates out: the follow stops at the close, not after the animation.
  const present = useIsPresent()
  const presentRef = useRef(present)
  presentRef.current = present
  // Every follow this sheet started, cleared from the store when it unmounts.
  const started = useRef(new Set<string>())
  const closeRef = useRef<HTMLButtonElement>(null)
  const liveId = useRef<string | null>(null)
  // Follows that ended, including one that ended before its reply named it.
  const endedIds = useRef(new Set<string>())
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
  // Escape closes from anywhere while the sheet is open.
  useEffect(() => {
    if (!present) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [present, onClose])
  useEffect(
    () =>
      onContainerLog((event) => {
        if ('chunk' in event) totals.current.set(event.followId, (totals.current.get(event.followId) ?? 0) + event.chunk.length)
        else {
          endedIds.current.add(event.followId)
          if (event.followId === liveId.current) {
            setEndNote(true)
            setFollowing(false)
          }
        }
        bump((n) => n + 1)
      }),
    [],
  )

  // A snapshot while not following.
  useEffect(() => {
    if (following) return
    let stale = false
    setText(null)
    void attempt("Couldn't load the logs", () => api.invoke('containers:logs', hostId, environmentId, ref, tail)).then((out) => {
      if (!stale && out !== undefined) setText(out)
    })
    return () => {
      stale = true
    }
  }, [following, tail, hostId, environmentId, ref])

  // A follow lives exactly as long as the switch is on, the tail unchanged and the drawer open.
  useEffect(() => {
    if (!following || !present) return
    let cancelled = false
    let id: string | null = null
    setEndNote(false)
    void attempt("Couldn't follow the logs", () => api.invoke('containers:follow', hostId, environmentId, ref, tail)).then((got) => {
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
        setFollowing(false)
        return
      }
      liveId.current = got
      setFollowId(got)
    })
    return () => {
      cancelled = true
      liveId.current = null
      // While the sheet animates out its last lines stay on screen; unmounting clears them.
      const closing = !presentRef.current
      if (!closing) setFollowId(null)
      if (id) void stop(id, !closing)
    }
  }, [following, present, tail, hostId, environmentId, ref])

  const output = useMemo<HostOutput | undefined>(() => {
    if (following) {
      const t = followId ? followed[followId] : undefined
      return t === undefined || !followId ? undefined : { text: t, errRanges: [], total: totals.current.get(followId) ?? t.length }
    }
    return text === null ? undefined : { text, errRanges: [], total: text.length }
  }, [following, followId, followed, text])

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-fg">
          Logs <span className="font-mono text-[13px] font-normal text-muted">{ref}</span>
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
        <label className="flex h-9 items-center gap-2 text-[12.5px] text-fg/85">
          <Switch label="Follow" checked={following} onChange={setFollowing} />
          Follow
        </label>
        {endNote && <span className="pb-2.5 text-[12px] text-muted">The follow ended</span>}
      </div>
      <div className="min-h-0 flex-1 px-5 pb-5">
        <OutputPane key={`${following}:${followId}:${tail}`} output={output} label={ref} dimTimestamps className="h-full max-h-none" />
      </div>
    </>
  )
}

function stop(followId: string, clear: boolean): Promise<void> {
  if (clear) clearFollow(followId)
  return api.invoke('containers:unfollow', followId).catch(() => {})
}
