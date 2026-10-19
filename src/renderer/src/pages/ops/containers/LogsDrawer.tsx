import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
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
  const closeRef = useRef<HTMLButtonElement>(null)
  // Chars ever received per follow, so the pane knows what is new once the text is trimmed at its cap.
  const totals = useRef(new Map<string, number>())
  const [, bump] = useState(0)
  const followed = useSyncExternalStore(followStore.subscribe, followStore.get)

  useEffect(() => closeRef.current?.focus(), [])
  useEffect(
    () =>
      onContainerLog((event) => {
        if ('chunk' in event) totals.current.set(event.followId, (totals.current.get(event.followId) ?? 0) + event.chunk.length)
        else if (event.followId === liveId.current) setEndNote(true)
        bump((n) => n + 1)
      }),
    [],
  )
  const liveId = useRef<string | null>(null)

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
      if (cancelled) return void stop(got)
      liveId.current = got
      setFollowId(got)
    })
    return () => {
      cancelled = true
      liveId.current = null
      setFollowId(null)
      if (id) void stop(id)
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

function stop(followId: string): Promise<void> {
  clearFollow(followId)
  return api.invoke('containers:unfollow', followId).catch(() => {})
}
