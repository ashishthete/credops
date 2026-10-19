import { motion } from 'framer-motion'
import { Layers, Link2, Lock, Network, Pencil, Plus, Trash2, Unlink } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { EnvironmentMeta, ProductMeta } from '../../../../shared/inventory'
import type { InventoryData } from '../../inventory/store'
import { ROLE_ORDER } from '../../inventory/tree'
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
    <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        {lead}
        <h2 className="truncate text-[19px] font-semibold tracking-tight text-fg">{title}</h2>
        {badges}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

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
  /** Takes an environment out of this product; it stays in its other products. */
  onRemoveEnvironment: (environmentId: string) => void
}

export function ProductView({ product, data, stagger, onOpen, onNewEnvironment, onEdit, onDelete, onRemoveEnvironment }: ProductViewProps) {
  const envs = data.environments.filter((e) => e.productIds.includes(product.id)).sort((a, b) => a.name.localeCompare(b.name))
  const productName = new Map(data.products.map((p) => [p.id, p.name]))
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
            <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon={<Network aria-hidden className="size-3.5" />} onClick={() => navigate(showProductOnMapPath(product.id))}>
              Show on map
            </Button>
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
              <EnvironmentCard
                key={env.id}
                env={env}
                index={i}
                stagger={stagger}
                others={env.productIds.filter((id) => id !== product.id).map((id) => productName.get(id) ?? id)}
                onOpen={() => onOpen(env.id)}
                menu={
                  <RowMenu
                    label={`${env.name} options`}
                    className="absolute top-3 right-3"
                    items={[{ label: `Remove from ${product.name}`, icon: Unlink, run: () => onRemoveEnvironment(env.id) }]}
                  />
                }
              />
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
  others,
  onOpen,
  menu,
}: {
  env: EnvironmentMeta
  index: number
  stagger: boolean
  others: string[]
  onOpen: () => void
  /** Sits beside the card button, not inside it: a button can't hold another. */
  menu: ReactNode
}) {
  const motionSafe = useMotionSafe()
  const counts = ROLE_ORDER.map((role) => ({ role, n: env.hosts.filter((h) => h.role === role).length })).filter((c) => c.n)
  return (
    <motion.li
      initial={stagger ? (motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }) : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionSafe ? { ...spring, delay: staggerDelay(index) } : { ...fast, delay: staggerDelay(index) }}
      className="relative"
    >
      <motion.button
        type="button"
        onClick={onOpen}
        whileHover={motionSafe ? { y: -2 } : undefined}
        whileTap={motionSafe ? { scale: 0.985 } : undefined}
        transition={spring}
        className="group relative flex w-full flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface/60 p-4 pr-11 pl-5 text-left transition-[border-color,background-color] hover:border-muted/30 hover:bg-surface"
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
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <span className="text-fg/85 tabular-nums">{plural(env.hosts.length, 'host')}</span>
          {counts.map(({ role, n }) => (
            <span key={role} className="rounded-full bg-white/[0.05] px-1.5 leading-[18px] tabular-nums">
              {ROLE_LABEL[role]} {n}
            </span>
          ))}
        </span>
        {others.length > 0 && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <Badge tone="info">
              <Link2 aria-hidden className="size-3" />
              Shared
            </Badge>
            <span className="truncate">with {others.join(', ')}</span>
          </span>
        )}
      </motion.button>
      {menu}
    </motion.li>
  )
}
