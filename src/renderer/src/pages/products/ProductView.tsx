import { motion } from 'framer-motion'
import { Layers, Lock, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { EnvironmentMeta, ProductMeta } from '../../../../shared/inventory'
import { SERVICE_KIND_LABEL } from '../../../../shared/services'
import { deployStore } from '../../deploy/store'
import type { InventoryData } from '../../inventory/store'
import { byPosition, ROLE_ORDER, SERVICE_ORDER } from '../../inventory/tree'
import { showProductOnMapPath } from '../../map/commands'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { plural, RowMenu } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { ProductTile } from './ProductDialog'

export const ROLE_LABEL = { app: 'App', db: 'Database', bastion: 'Bastion', other: 'Other' } as const
export { ROLE_ORDER }

/** The details pane's title row, in the Vaults page's shape. */
export function PaneHeader({ lead, title, badges, actions }: { lead: ReactNode; title: string; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="@container/pane app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        {lead}
        <h2 title={title} className="min-w-0 truncate text-[19px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {badges}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

/**
 * A secondary header button's label: on a narrow pane only the icon shows, so the title keeps its room.
 * The button carries the label as its accessible name and tooltip.
 */
export const PaneLabel = ({ children }: { children: string }) => <span className="hidden @3xl/pane:inline">{children}</span>
export const paneLabel = (label: string) => ({ 'aria-label': label, title: label, children: <PaneLabel>{label}</PaneLabel> })

export const GlowDot = ({ color }: { color: string }) => (
  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }} />
)

interface ProductViewProps {
  product: ProductMeta
  data: InventoryData
  /** Cards cascade in on the page's first view only. */
  stagger: boolean
  onOpen: (environmentId: string) => void
  onNewEnvironment: () => void
  onEdit: () => void
  onDelete: () => void
}

export function ProductView({ product, data, stagger, onOpen, onNewEnvironment, onEdit, onDelete }: ProductViewProps) {
  const envs = data.environments.filter((e) => e.productId === product.id).sort(byPosition)
  const navigate = useNavigate()

  return (
    <>
      <PaneHeader
        lead={<ProductTile icon={product.icon} color={product.color} />}
        title={product.name}
        badges={<Badge tone="info">{plural(envs.length, 'environment')}</Badge>}
        actions={
          <>
            <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={onNewEnvironment}>
              New environment
            </Button>
            <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit} {...paneLabel('Edit')} />
            <Button size="sm" variant="ghost" icon={<Network aria-hidden className="size-3.5" />} onClick={() => navigate(showProductOnMapPath(product.id))} {...paneLabel('Show on map')} />
            <RowMenu label={`${product.name} options`} items={[{ label: 'Delete', icon: Trash2, run: onDelete, danger: true }]} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8">
        {product.description && <p className="mb-5 max-w-[64ch] text-[13px] leading-5 text-muted">{product.description}</p>}
        {envs.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No environments yet"
            text="Add one here, or drag an environment onto this product in the tree."
            action={{ label: 'New environment', run: onNewEnvironment }}
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {envs.map((env, i) => (
              <EnvironmentCard key={env.id} env={env} index={i} stagger={stagger} onOpen={() => onOpen(env.id)} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function EnvironmentCard({
  env,
  index,
  stagger,
  onOpen,
}: {
  env: EnvironmentMeta
  index: number
  stagger: boolean
  onOpen: () => void
}) {
  const motionSafe = useMotionSafe()
  const services = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  const mine = services.filter((s) => s.environmentId === env.id)
  const counts = SERVICE_ORDER.map((kind) => ({ kind, n: mine.filter((s) => s.kind === kind).length })).filter((c) => c.n)
  return (
    <motion.li
      initial={stagger ? (motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }) : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionSafe ? { ...spring, delay: staggerDelay(index) } : { ...fast, delay: staggerDelay(index) }}
      className="relative flex"
    >
      <motion.button
        type="button"
        onClick={onOpen}
        whileHover={motionSafe ? { y: -2 } : undefined}
        whileTap={motionSafe ? { scale: 0.985 } : undefined}
        transition={spring}
        className="group relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface/60 p-4 pl-5 text-left transition-[border-color,background-color] hover:border-muted/30 hover:bg-surface"
      >
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: env.color, boxShadow: `0 0 14px ${env.color}` }} />
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-fg">{env.name}</span>
          {env.protected && (
            <Badge tone="warn">
              <Lock aria-hidden className="size-3" />
              Protected
            </Badge>
          )}
        </span>
        <span className="flex flex-col gap-1.5 text-[12px] text-muted">
          <span className="text-fg/85 tabular-nums">
            {plural(mine.length, 'service')} on {plural(env.hosts.length, 'host')}
          </span>
          {counts.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {counts.map(({ kind, n }) => (
                <span key={kind} className="rounded-full bg-white/[0.05] px-1.5 leading-[18px] tabular-nums">
                  {SERVICE_KIND_LABEL[kind]} {n}
                </span>
              ))}
            </span>
          )}
        </span>
      </motion.button>
    </motion.li>
  )
}
