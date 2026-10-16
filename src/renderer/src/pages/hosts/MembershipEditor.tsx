import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Lock, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { HOST_ROLES, type EnvironmentMeta, type HostMeta, type HostRole } from '../../../../shared/inventory'
import { inv, type InventoryData } from '../../inventory/store'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { ROLE_LABEL } from '../products/ProductView'

interface MembershipEditorProps {
  host: HostMeta
  data: InventoryData
  /** Asks before removing; the caller owns the confirmation. */
  onRemove: (env: EnvironmentMeta) => void
}

/** The environments a host belongs to: a role per environment, add, and remove. */
export function MembershipEditor({ host, data, onRemove }: MembershipEditorProps) {
  const motionSafe = useMotionSafe()
  const productName = new Map(data.products.map((p) => [p.id, p.name]))
  const where = (e: EnvironmentMeta) => e.productIds.map((id) => productName.get(id)).filter(Boolean).join(', ')
  const rows = host.environments
    .flatMap((m) => {
      const env = data.environments.find((e) => e.id === m.environmentId)
      return env ? [{ env, role: m.role }] : []
    })
    .sort((a, b) => a.env.name.localeCompare(b.env.name))
  const joined = new Set(host.environments.map((m) => m.environmentId))
  const available = data.environments.filter((e) => !joined.has(e.id)).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && <p className="text-[12.5px] text-muted">Not in any environment. It connects with its own settings and the app defaults.</p>}
      <ul className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {rows.map(({ env, role }) => (
            <motion.li
              key={env.id}
              layout={motionSafe ? 'position' : false}
              initial={motionSafe ? { opacity: 0, x: -6 } : { opacity: 0 }}
              animate={{ opacity: 1, x: 0 }}
              exit={motionSafe ? { opacity: 0, x: -10, transition: fast } : { opacity: 0, transition: fast }}
              transition={motionSafe ? spring : fast}
              className="group flex h-10 items-center gap-3 rounded-lg border border-line/70 bg-surface/50 pr-1.5 pl-3"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: env.color, boxShadow: `0 0 10px ${env.color}` }} />
              <span className="truncate text-[13px] font-medium text-fg">{env.name}</span>
              {env.protected && <Lock aria-label="Protected" className="size-3 shrink-0 text-warn" />}
              {where(env) && <span className="truncate text-[12px] text-muted">{where(env)}</span>}
              <span className="relative ml-auto">
                <select
                  aria-label={`Role in ${env.name}`}
                  value={role}
                  onChange={(e) => void inv.putHost(env.id, host.id, e.target.value as HostRole)}
                  className="h-7 appearance-none rounded-md border border-transparent bg-white/[0.04] pr-7 pl-2.5 text-[12.5px] text-fg transition-colors hover:border-line focus:border-accent/60 focus:outline-none"
                >
                  {HOST_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-muted" />
              </span>
              <button
                type="button"
                aria-label={`Remove ${host.label} from ${env.name}`}
                title={`Remove from ${env.name}`}
                onClick={() => onRemove(env)}
                className="grid size-7 place-items-center rounded-md text-muted opacity-60 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {available.length > 0 && <AddMenu envs={available} where={where} onPick={(e) => void inv.putHost(e.id, host.id, 'other')} />}
    </div>
  )
}

function AddMenu({ envs, where, onPick }: { envs: EnvironmentMeta[]; where: (e: EnvironmentMeta) => string; onPick: (e: EnvironmentMeta) => void }) {
  const motionSafe = useMotionSafe()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="relative self-start">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-muted/40 hover:text-fg"
      >
        <Plus aria-hidden className="size-3.5" />
        Add to environment…
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Add to environment"
            onKeyDown={onKeyDown}
            initial={motionSafe ? { opacity: 0, scale: 0.95, y: -4 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
            exit={{ opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            style={{ transformOrigin: 'top left' }}
            className="absolute top-full left-0 z-40 mt-1 max-h-64 w-[240px] overflow-y-auto rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
          >
            {envs.map((e) => (
              <button
                key={e.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  onPick(e)
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-fg/90 transition-colors hover:bg-white/6 focus:bg-white/6 focus:outline-none"
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: e.color }} />
                <span className="truncate">{e.name}</span>
                {where(e) && <span className="ml-auto truncate text-[11.5px] text-muted">{where(e)}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
