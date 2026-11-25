import { AnimatePresence, motion } from 'framer-motion'
import { AppWindow, ArrowUpRight, Database, Lock, Plus, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import type { EnvironmentMeta, HostMeta } from '../../../../shared/inventory'
import { SERVICE_KIND_LABEL, type ServiceKind, type ServiceMeta } from '../../../../shared/services'
import { deployStore, startDeploySync } from '../../deploy/store'
import type { InventoryData } from '../../inventory/store'
import { environmentKey } from '../../inventory/tree'
import { useMenuPopover, type ConfirmRequest } from '../../ui/common'
import { exitFast, fast, spring, useMotionSafe } from '../../ui/motion'
import { deleteRequest, ServiceDialog } from '../products/services/ServiceDialog'

const KIND_ICON: Record<ServiceKind, LucideIcon> = { service: AppWindow, db: Database, bastion: ShieldCheck }

interface HostServicesProps {
  host: HostMeta
  data: InventoryData
  /** Asks before deleting; the caller owns the confirmation. */
  onConfirm: (request: ConfirmRequest) => void
}

/** The services a host runs, by environment: open, delete, and add one in any environment. */
export function HostServices({ host, data, onConfirm }: HostServicesProps) {
  const motionSafe = useMotionSafe()
  const navigate = useNavigate()
  useEffect(() => startDeploySync(), [])
  const all = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  const [adding, setAdding] = useState<EnvironmentMeta | null>(null)
  const list = useRef<HTMLUListElement>(null)

  const productName = useMemo(() => new Map(data.products.map((p) => [p.id, p.name])), [data.products])
  const envById = useMemo(() => new Map(data.environments.map((e) => [e.id, e])), [data.environments])
  const where = (e: EnvironmentMeta) => `${productName.get(e.productId) ?? ''} ${e.name}`
  const rows = useMemo(
    () =>
      all
        .filter((s) => s.hostId === host.id)
        .flatMap((s) => {
          const env = envById.get(s.environmentId)
          return env ? [{ svc: s, env }] : []
        })
        .sort((a, b) => where(a.env).localeCompare(where(b.env)) || a.svc.name.localeCompare(b.svc.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `where` reads productName
    [all, host.id, envById, productName],
  )
  const envs = useMemo(
    () => [...data.environments].sort((a, b) => where(a).localeCompare(where(b))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `where` reads productName
    [data.environments, productName],
  )

  const open = (svc: ServiceMeta, env: EnvironmentMeta) => navigate(`/products?node=${encodeURIComponent(`${environmentKey(env)}/s:${svc.id}`)}`)

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <p className="text-[12.5px] text-muted">No services. Add one to put {host.label} in an environment; until then it connects with its own settings.</p>
      )}
      {/* Focus lands here when the menu closes with nothing to return to. */}
      <ul ref={list} tabIndex={-1} aria-label="Services" className="flex flex-col gap-1 focus:outline-none">
        <AnimatePresence initial={false}>
          {rows.map(({ svc, env }) => {
            const Icon = KIND_ICON[svc.kind]
            const product = productName.get(env.productId)
            return (
              <motion.li
                key={svc.id}
                layout={motionSafe ? 'position' : false}
                initial={motionSafe ? { opacity: 0, x: -6 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={motionSafe ? { opacity: 0, x: -10, transition: exitFast } : { opacity: 0, transition: exitFast }}
                transition={motionSafe ? spring : fast}
                className="group flex h-10 items-center gap-2.5 rounded-lg border border-line/70 bg-surface/50 pr-1.5 pl-3"
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: env.color, boxShadow: `0 0 10px ${env.color}` }} />
                <span className="flex min-w-0 shrink items-center gap-1 text-[12px] text-muted">
                  {product && <span className="truncate">{product} ›</span>}
                  <span className="truncate text-fg/85">{env.name}</span>
                  {env.protected && <Lock aria-label="Protected" className="size-3 shrink-0 text-warn" />}
                </span>
                <Icon aria-hidden className="ml-1 size-3.5 shrink-0 text-muted" />
                <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
                <span className="shrink-0 rounded-full bg-white/[0.05] px-1.5 text-[10.5px] leading-[16px] font-medium text-muted">
                  {SERVICE_KIND_LABEL[svc.kind]}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`Open ${svc.name} in ${env.name}`}
                    title={`Open in ${env.name}`}
                    onClick={() => open(svc, env)}
                    className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
                  >
                    <ArrowUpRight aria-hidden className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${svc.name} from ${env.name}`}
                    title="Delete service"
                    onClick={() => onConfirm(deleteRequest(env, svc))}
                    className="grid size-7 place-items-center rounded-md text-muted opacity-60 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-err/12 hover:text-err focus-visible:opacity-100"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                </span>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      {envs.length > 0 && <AddMenu envs={envs} productName={productName} anchor={() => list.current} onPick={setAdding} />}
      {adding && <ServiceDialog env={adding} hostId={host.id} onClose={() => setAdding(null)} />}
    </div>
  )
}

function AddMenu({
  envs,
  productName,
  anchor,
  onPick,
}: {
  envs: EnvironmentMeta[]
  productName: Map<string, string>
  anchor: () => HTMLElement | null
  onPick: (e: EnvironmentMeta) => void
}) {
  const motionSafe = useMotionSafe()
  const { open, setOpen, close, triggerProps, menuProps } = useMenuPopover({ fallback: anchor })

  return (
    <div className="relative self-start">
      <button
        {...triggerProps}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-muted/40 hover:text-fg"
      >
        <Plus aria-hidden className="size-3.5" />
        Add service…
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            {...menuProps}
            aria-label="Add a service in"
            initial={motionSafe ? { opacity: 0, scale: 0.95, y: -4 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
            exit={{ opacity: 0, transition: exitFast }}
            transition={motionSafe ? spring : fast}
            style={{ transformOrigin: 'top left' }}
            className="absolute top-full left-0 z-40 mt-1 max-h-64 w-[260px] overflow-y-auto rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
          >
            <p className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-muted">In which environment?</p>
            {envs.map((e) => (
              <button
                key={e.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false)
                  onPick(e)
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-fg/90 transition-colors hover:bg-white/6 focus:bg-white/6 focus:outline-none"
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: e.color }} />
                <span className="truncate">{e.name}</span>
                {productName.get(e.productId) && <span className="ml-auto truncate text-[11.5px] text-muted">{productName.get(e.productId)}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
