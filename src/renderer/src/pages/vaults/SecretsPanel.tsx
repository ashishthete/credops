import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { REVEAL_HIDE_MS, type SecretMeta } from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'
import { vaultStatusStore } from '../../vault/status'
import { attempt, ListRow, RowMenu, type ConfirmRequest } from './common'
import { SecretDialog } from './SecretDialog'

export const MASK = '••••••••'

// Revealed values live here, not in component state: a lock mid-reveal unmounts the page, and the
// retried reveal (after the unlock) must still reach the row that remounts. Cleared on every lock.
interface Reveal {
  value: string
  until: number
  timer: ReturnType<typeof setTimeout>
}
let reveals: ReadonlyMap<string, Reveal> = new Map()
const listeners = new Set<() => void>()

function setReveals(next: Map<string, Reveal>) {
  reveals = next
  listeners.forEach((l) => l())
}

function hide(id: string) {
  const r = reveals.get(id)
  if (!r) return
  clearTimeout(r.timer)
  const next = new Map(reveals)
  next.delete(id)
  setReveals(next)
}

function show(id: string, value: string) {
  const prev = reveals.get(id)
  if (prev) clearTimeout(prev.timer)
  const next = new Map(reveals)
  next.set(id, { value, until: Date.now() + REVEAL_HIDE_MS, timer: setTimeout(() => hide(id), REVEAL_HIDE_MS) })
  setReveals(next)
}

/** Hides every revealed value. */
export function hideAllReveals(): void {
  if (!reveals.size) return
  reveals.forEach((r) => clearTimeout(r.timer))
  setReveals(new Map())
}

vaultStatusStore.subscribe(() => {
  if (!vaultStatusStore.get()?.unlocked) hideAllReveals()
})

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function useReveal(id: string): Reveal | undefined {
  return useSyncExternalStore(subscribe, () => reveals.get(id))
}

interface SecretsPanelProps {
  secrets: SecretMeta[]
  stagger: boolean
  onChanged: (next: SecretMeta) => void
  onDeleted: (id: string) => void
  confirm: (req: ConfirmRequest) => void
}

export function SecretsPanel({ secrets, stagger, onChanged, onDeleted, confirm }: SecretsPanelProps) {
  // Kept after close so the dialog keeps its title while it animates out.
  const [editing, setEditing] = useState<SecretMeta | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  return (
    <>
      <ul className="flex flex-col">
        <AnimatePresence initial={stagger}>
          {secrets.map((s, i) => (
            <SecretRow
              key={s.id}
              secret={s}
              index={i}
              stagger={stagger}
              onEdit={() => {
                setEditing(s)
                setEditOpen(true)
              }}
              onDelete={() =>
                confirm({
                  title: `Delete ${s.name}?`,
                  description: 'The secret and its value are removed from this vault.',
                  confirmLabel: 'Delete secret',
                  run: async () => {
                    const ok = await attempt("Couldn't delete the secret", async () => {
                      await api.invoke('secret:delete', s.id)
                      return true
                    })
                    if (ok) {
                      hide(s.id)
                      onDeleted(s.id)
                      toast({ title: `Deleted ${s.name}`, tone: 'success' })
                    }
                  },
                })
              }
            />
          ))}
        </AnimatePresence>
      </ul>
      <SecretDialog
        open={editOpen}
        secret={editing ?? undefined}
        vaultId={editing?.vaultId ?? ''}
        onClose={() => setEditOpen(false)}
        onSaved={(s) => {
          hide(s.id)
          onChanged(s)
          setEditOpen(false)
        }}
      />
    </>
  )
}

interface SecretRowProps {
  secret: SecretMeta
  index: number
  stagger: boolean
  onEdit: () => void
  onDelete: () => void
}

function SecretRow({ secret: s, index, stagger, onEdit, onDelete }: SecretRowProps) {
  const reveal = useReveal(s.id)
  const [revealing, setRevealing] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const motionSafe = useMotionSafe()

  const toggleReveal = async () => {
    if (reveal) return hide(s.id)
    setRevealing(true)
    const res = await attempt("Couldn't reveal the secret", () => api.invoke('secret:reveal', s.id))
    setRevealing(false)
    if (res) show(s.id, res.value)
  }

  const copy = async () => {
    const res = await attempt("Couldn't copy the secret", () => api.invoke('secret:copy', s.id))
    if (!res) return
    toast({ title: `Copied · clears in ${Math.round(res.clearsInMs / 1000)} s`, tone: 'success' })
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1400)
  }

  const RevealIcon = reveal ? EyeOff : Eye
  return (
    <ListRow label={s.name} index={index} stagger={stagger}>
      <div className="flex w-[34%] min-w-0 shrink-0 items-center gap-2.5">
        <span className="truncate text-[13px] font-medium text-fg">{s.name}</span>
        <Badge className="shrink-0">{s.kind}</Badge>
      </div>

      <div className="relative min-w-0 flex-1">
        <div className="relative flex max-h-32 min-h-8 items-center overflow-auto rounded-md bg-canvas/50 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--border)]">
          {reveal ? (
            <motion.code
              key="value"
              initial={motionSafe ? { opacity: 0, filter: 'blur(6px)', letterSpacing: '0.3em' } : { opacity: 0 }}
              animate={motionSafe ? { opacity: 1, filter: 'blur(0px)', letterSpacing: '0em' } : { opacity: 1 }}
              transition={motionSafe ? { duration: 0.32, ease: 'easeOut' } : fast}
              className="min-w-0 font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap text-fg select-all"
            >
              {reveal.value}
            </motion.code>
          ) : (
            <motion.span
              key="mask"
              initial={motionSafe ? { opacity: 0, letterSpacing: '0.05em' } : false}
              animate={{ opacity: 1, letterSpacing: '0.18em' }}
              transition={fast}
              className="font-mono text-[12.5px] text-muted/80 select-none"
            >
              {MASK}
            </motion.span>
          )}
          {reveal && (
            <span
              key={reveal.until}
              aria-hidden
              className="toast-drain absolute inset-x-0 bottom-0 h-[2px] bg-accent/70"
              style={{ animationDuration: `${Math.max(0, reveal.until - Date.now())}ms` }}
            />
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void toggleReveal()}
          disabled={revealing}
          aria-pressed={!!reveal}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/6 hover:text-fg disabled:opacity-55"
        >
          <RevealIcon aria-hidden className="size-3.5" />
          {reveal ? 'Hide' : 'Reveal'}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/6 hover:text-fg"
        >
          <span className="relative grid size-3.5 place-items-center">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={copied ? 'done' : 'copy'}
                initial={motionSafe ? { scale: 0.4, opacity: 0, rotate: -30 } : { opacity: 0 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={motionSafe ? spring : fast}
                className={copied ? 'text-ok' : ''}
              >
                {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
              </motion.span>
            </AnimatePresence>
          </span>
          Copy
        </button>
        <RowMenu
          label={`${s.name} options`}
          items={[
            { label: 'Edit', icon: Pencil, run: onEdit },
            { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
          ]}
        />
      </div>
    </ListRow>
  )
}
