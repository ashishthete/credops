import { motion } from 'framer-motion'
import { Boxes, Inbox, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { EnvironmentMeta, Membership, ProductMeta } from '../../../../shared/inventory'
import { inv, inventoryStore, loadInventory, useInventory, type InventoryData } from '../../inventory/store'
import { buildTree, environmentKey, selectionFromKey, type NodeKey, type TreeRow } from '../../inventory/tree'
import { Badge } from '../../ui/Badge'
import { registerCommand } from '../../ui/commands'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { fast, useMotionSafe } from '../../ui/motion'
import { useShortcut } from '../../ui/shortcuts'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { useVaultStatus } from '../../vault/status'
import { HostDialog } from '../hosts/HostDialog'
import { HostView } from '../hosts/HostView'
import { EnvironmentDialog } from './EnvironmentDialog'
import { EnvironmentView } from './EnvironmentView'
import { InventoryTree } from './InventoryTree'
import { ProductDialog } from './ProductDialog'
import { PaneHeader, ProductView } from './ProductView'

/** Every node of the fully expanded tree: the expandable ones, and all keys. */
function everyNode(data: InventoryData): { expandable: Set<NodeKey>; all: Set<NodeKey> } {
  const expandable = new Set<NodeKey>()
  let rows: TreeRow[] = []
  // Each pass opens one more level: products, then environments, then (no-op) hosts.
  for (let i = 0; i < 3; i++) {
    rows = buildTree(data, expandable)
    rows.forEach((r) => r.expandable && expandable.add(r.key))
  }
  return { expandable, all: new Set(rows.map((r) => r.key)) }
}

const parentOf = (key: NodeKey) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : key)

type Dialogs =
  | { kind: 'product'; product?: ProductMeta }
  | { kind: 'environment'; environment?: EnvironmentMeta; productIds: string[] }
  | { kind: 'host'; presetEnvironment: Membership; envKey: NodeKey }
  | null

export function ProductsPage() {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const status = useVaultStatus()
  const corruptIds = useMemo(() => status?.corruptVaultIds ?? [], [status])
  const [params, setParams] = useSearchParams()
  const [expanded, setExpanded] = useState<Set<NodeKey> | null>(null)
  // Cards cascade in on the first view only, not on every selection.
  const [fresh, setFresh] = useState(true)
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  // The shell loads the inventory on mount; this covers the page rendered on its own (F22).
  useEffect(() => {
    if (inventoryStore.get() === null) void loadInventory()
  }, [])

  const nodes = useMemo(() => (data ? everyNode(data) : null), [data])
  // Everything starts open the first time data arrives.
  if (nodes && expanded === null) setExpanded(new Set(nodes.expandable))
  const rows = useMemo(() => (data && expanded ? buildTree(data, expanded) : []), [data, expanded])

  const firstProduct = data && [...data.products].sort((a, b) => a.name.localeCompare(b.name))[0]
  const wanted = params.get('node')
  const selected: NodeKey | null =
    wanted && nodes?.all.has(wanted) ? wanted : firstProduct ? `p:${firstProduct.id}` : null
  const sel = selected ? selectionFromKey(selected) : {}

  const select = useCallback(
    (key: NodeKey) => {
      setFresh(false)
      setParams(
        (p) => {
          const out = new URLSearchParams(p)
          out.set('node', key)
          return out
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const expand = useCallback((...keys: NodeKey[]) => setExpanded((s) => new Set([...(s ?? []), ...keys])), [])
  const toggle = (key: NodeKey) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const openDialog = (d: NonNullable<Dialogs>) => {
    setDialog(d)
    setDialogOpen(true)
  }
  const closeDialog = () => setDialogOpen(false)

  const newProduct = () => openDialog({ kind: 'product' })
  const newEnvironment = (productId = sel.productId) => openDialog({ kind: 'environment', productIds: productId ? [productId] : [] })

  const openNewRef = useRef({ newProduct, newEnvironment, hasProduct: !!sel.productId })
  useEffect(() => {
    openNewRef.current = { newProduct, newEnvironment, hasProduct: !!sel.productId }
  })
  useEffect(() => {
    const off = [
      registerCommand({
        id: 'products.newProduct',
        title: 'New product',
        section: 'Products',
        keywords: ['project', 'app'],
        run: () => openNewRef.current.newProduct(),
      }),
      registerCommand({
        id: 'products.newEnvironment',
        title: 'New environment',
        section: 'Products',
        keywords: ['staging', 'prod', 'env'],
        run: () => openNewRef.current.newEnvironment(),
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [])
  useShortcut('mod+n', () => (openNewRef.current.hasProduct ? openNewRef.current.newEnvironment() : openNewRef.current.newProduct()))

  const env = (id: string) => data?.environments.find((e) => e.id === id)

  // One drop at a time: the next is judged against the result of the last.
  const [dropping, setDropping] = useState(false)
  const whileDropping = async (fn: () => Promise<void>) => {
    setDropping(true)
    try {
      await fn()
    } finally {
      setDropping(false)
    }
  }

  const canDrop = (drag: TreeRow, target: TreeRow) => {
    if (dropping) return false
    if (drag.kind === 'host' && target.kind === 'environment') return !env(target.id)?.hosts.some((h) => h.hostId === drag.id)
    if (drag.kind === 'environment' && target.kind === 'product') return !env(drag.id)?.productIds.includes(target.id)
    return false
  }

  const dropHost = (host: TreeRow, target: TreeRow) =>
    whileDropping(async () => {
      if (await inv.putHost(target.id, host.id, host.role ?? 'other')) {
        expand(target.key)
        toast({ title: `Added ${host.label} to ${target.label}`, tone: 'success' })
      }
    })

  const dropEnvironment = (from: TreeRow, target: TreeRow) =>
    whileDropping(async () => {
      const e = env(from.id)
      if (!e) return
      if (await inv.setEnvironmentProducts(e.id, [...e.productIds, target.id])) {
        expand(target.key)
        toast({ title: `Added ${from.label} to ${target.label}`, tone: 'success' })
      }
    })

  const askDeleteProduct = (p: ProductMeta) =>
    setConfirm({
      title: `Delete ${p.name}?`,
      description: 'Its environments and hosts are kept. Environments in no other product move to Unassigned.',
      confirmLabel: 'Delete product',
      run: async () => {
        if (await inv.deleteProduct(p.id)) toast({ title: `Deleted ${p.name}`, tone: 'success' })
      },
    })

  const askDeleteEnvironment = (e: EnvironmentMeta, key: NodeKey) =>
    setConfirm({
      title: `Delete ${e.name}?`,
      description: 'Its hosts are kept, along with their places in other environments.',
      confirmLabel: 'Delete environment',
      typeToConfirm: e.protected ? e.name : undefined,
      run: async () => {
        if (await inv.deleteEnvironment(e.id)) {
          select(parentOf(key))
          toast({ title: `Deleted ${e.name}`, tone: 'success' })
        }
      },
    })

  const askRemoveHost = (e: EnvironmentMeta, hostId: string) => {
    const label = data?.hosts.find((h) => h.id === hostId)?.label ?? 'this host'
    setConfirm({
      title: `Remove ${label} from ${e.name}?`,
      description: 'The host is kept, along with its places in other environments.',
      confirmLabel: 'Remove host',
      typeToConfirm: e.protected ? e.name : undefined,
      run: async () => {
        if (await inv.removeHost(e.id, hostId)) toast({ title: `Removed ${label} from ${e.name}`, tone: 'success' })
      },
    })
  }

  const productIcons = useMemo(() => Object.fromEntries((data?.products ?? []).map((p) => [p.id, p.icon])), [data])

  const details = () => {
    if (!data || !expanded) return <DetailsSkeleton />
    if (!selected) {
      return (
        <EmptyState
          icon={Boxes}
          title="No products yet"
          text="Create your first product to group environments."
          action={{ label: 'New product', run: newProduct }}
        />
      )
    }
    if (sel.hostId) {
      if (!data.hosts.some((x) => x.id === sel.hostId)) return null
      return <HostView key={sel.hostId} hostId={sel.hostId} environmentId={sel.environmentId} onDeleted={() => select(parentOf(selected))} />
    }
    if (sel.environmentId) {
      const e = env(sel.environmentId)
      if (!e) return null
      return (
        <EnvironmentView
          env={e}
          envKey={selected}
          data={data}
          onSelect={select}
          onRemoveHost={(id) => askRemoveHost(e, id)}
          onNewHost={() => openDialog({ kind: 'host', presetEnvironment: { environmentId: e.id, role: 'app' }, envKey: selected })}
          onEdit={() => openDialog({ kind: 'environment', environment: e, productIds: e.productIds })}
          onDelete={() => askDeleteEnvironment(e, selected)}
        />
      )
    }
    if (sel.productId) {
      const p = data.products.find((x) => x.id === sel.productId)
      if (!p) return null
      return (
        <ProductView
          product={p}
          data={data}
          stagger={fresh}
          onOpen={(id) => {
            expand(selected)
            select(`${selected}/e:${id}`)
          }}
          onNewEnvironment={() => newEnvironment(p.id)}
          onEdit={() => openDialog({ kind: 'product', product: p })}
          onDelete={() => askDeleteProduct(p)}
        />
      )
    }
    const loose = data.environments.filter((e) => e.productIds.length === 0).length
    const looseHosts = data.hosts.filter((h) => h.environments.length === 0).length
    return (
      <>
        <PaneHeader lead={<Inbox aria-hidden className="size-4 text-muted" />} title="Unassigned" />
        <p className="max-w-[64ch] px-8 pt-2 text-[13px] leading-5 text-muted">
          {plural(loose, 'environment')} in no product and {plural(looseHosts, 'host')} in no environment. Drag them onto a product
          or environment in the tree.
        </p>
      </>
    )
  }

  return (
    <div className="flex h-full">
      {/* An aside, not a nav: the shell's sidebar is the app's one navigation landmark. */}
      <aside aria-label="Inventory" className="flex w-[272px] shrink-0 flex-col border-r border-line bg-surface/40">
        <div className="app-drag flex h-16 shrink-0 items-end justify-between px-5 pb-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-fg">Products</h1>
          {data && data.products.length > 0 && <Badge tone="info">{data.products.length}</Badge>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
          {data && expanded ? (
            <InventoryTree
              rows={rows}
              selected={selected}
              onSelect={select}
              onToggle={toggle}
              canDrop={canDrop}
              onDropHost={(h, e) => void dropHost(h, e)}
              onDropEnvironment={(e, p) => void dropEnvironment(e, p)}
              productIcons={productIcons}
            />
          ) : (
            <div className="flex flex-col gap-1.5 px-2 pt-1">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className={`h-6 ${i % 3 === 0 ? 'w-full' : 'ml-4 w-[85%]'}`} />
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-0.5 border-t border-line/70 p-2.5">
          <RailButton label="New product" onClick={newProduct} />
          <RailButton label="New environment" onClick={() => newEnvironment()} />
        </div>
      </aside>

      <section aria-label="Details" className="flex min-w-0 flex-1 flex-col">
        <motion.div
          key={selected ?? 'none'}
          className="flex min-h-0 flex-1 flex-col"
          initial={motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 }}
          animate={{ opacity: 1, y: 0 }}
          transition={fast}
        >
          {details()}
        </motion.div>
      </section>

      {dialog?.kind === 'product' && (
        <ProductDialog
          open={dialogOpen}
          product={dialog.product}
          onClose={closeDialog}
          onSaved={(p, created) => {
            closeDialog()
            if (created) select(`p:${p.id}`)
          }}
        />
      )}
      {dialog?.kind === 'environment' && data && (
        <EnvironmentDialog
          open={dialogOpen}
          environment={dialog.environment}
          productIds={dialog.productIds}
          data={data}
          corruptVaultIds={corruptIds}
          onClose={closeDialog}
          onSaved={(e) => {
            closeDialog()
            const key = environmentKey(e, sel.productId)
            expand(parentOf(key))
            if (key !== selected) select(key)
          }}
        />
      )}
      {dialog?.kind === 'host' && (
        <HostDialog
          open={dialogOpen}
          presetEnvironment={dialog.presetEnvironment}
          onClose={closeDialog}
          onSaved={(h) => {
            closeDialog()
            expand(dialog.envKey)
            select(`${dialog.envKey}/h:${h.id}`)
          }}
        />
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function RailButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/[0.04] hover:text-fg"
    >
      <Plus aria-hidden className="size-3.5" />
      {label}
    </button>
  )
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-8 pt-8">
      <Skeleton className="h-6 w-48" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
