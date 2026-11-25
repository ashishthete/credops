import { motion } from 'framer-motion'
import { Boxes, Download, Inbox, Plus, Upload, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router'
import type { EnvironmentMeta, Membership, ProductMeta } from '../../../../shared/inventory'
import type { ServiceMeta } from '../../../../shared/services'
import { deployStore, loadDeploy, startDeploySync } from '../../deploy/store'
import { regionHintText } from '../../inventory/regions'
import { inv, inventoryStore, loadInventory, reloadInventory, useInventory, type InventoryData } from '../../inventory/store'
import { buildTree, byPosition, environmentKey, selectionFromKey, type NodeKey, type TreeRow, type TreeService } from '../../inventory/tree'
import { Badge } from '../../ui/Badge'
import { registerCommand } from '../../ui/commands'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { fast, useMotionSafe } from '../../ui/motion'
import { useShortcut } from '../../ui/shortcuts'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { api } from '../../lib/api'
import { useVaultStatus } from '../../vault/status'
import { useConnect } from '../../terminal/connect'
import { HostDialog } from '../hosts/HostDialog'
import { HostView } from '../hosts/HostView'
import { EnvironmentDialog } from './EnvironmentDialog'
import { EnvironmentView } from './EnvironmentView'
import { InventoryTree, type RowAction } from './InventoryTree'
import { ProductDialog } from './ProductDialog'
import { PaneHeader, ProductView } from './ProductView'
import { ServiceView } from './ServiceView'
import { RegionsUpgradeBanner } from './RegionsUpgradeBanner'
import { deleteRequest, ServiceDialog } from './services/ServiceDialog'
import { useConfigTransfer } from '../settings/ConfigTransfer'
import { ResizablePanel } from '../../ui/ResizablePanel'

/** Every node of the fully expanded tree: the expandable ones, and all keys. */
function everyNode(data: InventoryData, services: readonly TreeService[]): { expandable: Set<NodeKey>; all: Set<NodeKey> } {
  const expandable = new Set<NodeKey>()
  let rows: TreeRow[] = []
  // Each pass opens one more level: products, then environments, then (no-op) services.
  for (let i = 0; i < 3; i++) {
    rows = buildTree(data, expandable, services)
    rows.forEach((r) => r.expandable && expandable.add(r.key))
  }
  return { expandable, all: new Set(rows.filter((r) => r.kind !== 'hint').map((r) => r.key)) }
}

const parentOf = (key: NodeKey) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : key)

type Dialogs =
  | { kind: 'product'; product?: ProductMeta }
  /** `productId` presets a new environment's product; `locked` keeps it there (opened from that product). */
  | { kind: 'environment'; environment?: EnvironmentMeta; productId?: string; locked?: boolean }
  | { kind: 'host'; presetEnvironment: Membership; envKey: NodeKey }
  /** Mounted while open, as ServicesSection mounts it. Adds a service, or edits `service`. */
  | { kind: 'service'; environment: EnvironmentMeta; service?: ServiceMeta }
  | null

export function ProductsPage() {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  // The tree lists every environment's services.
  const services = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  useEffect(() => startDeploySync(), [])
  const status = useVaultStatus()
  const corruptIds = useMemo(() => status?.corruptVaultIds ?? [], [status])
  const [params, setParams] = useSearchParams()
  const [expanded, setExpanded] = useState<Set<NodeKey> | null>(null)
  // Cards cascade in on the first view only, not on every selection.
  const [fresh, setFresh] = useState(true)
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // Products, environments, services and runbooks: what this page and its environment views edit.
  const transfer = useConfigTransfer('products')

  // The shell loads the inventory on mount; this covers the page rendered on its own (F22).
  useEffect(() => {
    if (inventoryStore.get() === null) void loadInventory()
  }, [])

  const nodes = useMemo(() => (data ? everyNode(data, services) : null), [data, services])
  // Everything starts open the first time data arrives.
  if (nodes && expanded === null) setExpanded(new Set(nodes.expandable))
  const rows = useMemo(() => (data && expanded ? buildTree(data, expanded, services) : []), [data, expanded, services])

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
  const newEnvironment = (productId = sel.productId, locked = false) => openDialog({ kind: 'environment', productId, locked })

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
  const { connect } = useConnect()

  /** A row's menu: the same dialogs as the page's own buttons, preset to that row. */
  const rowAction = (row: TreeRow, action: RowAction) => {
    const product = row.kind === 'product' ? data?.products.find((p) => p.id === row.id) : undefined
    const service = row.kind === 'service' ? services.find((x) => x.id === row.id) : undefined
    const environment = row.kind === 'environment' ? env(row.id) : service ? env(service.environmentId) : undefined
    if (action === 'newEnvironment' && product) newEnvironment(product.id, true)
    else if (action === 'editProduct' && product) openDialog({ kind: 'product', product })
    else if (action === 'editEnvironment' && environment) openDialog({ kind: 'environment', environment })
    else if (action === 'moveEnvironmentUp' && environment) void moveEnvironment(environment, -1)
    else if (action === 'moveEnvironmentDown' && environment) void moveEnvironment(environment, 1)
    else if (action === 'newHost' && environment) openDialog({ kind: 'host', presetEnvironment: { environmentId: environment.id, role: 'app' }, envKey: row.key })
    else if (action === 'addService' && environment) {
      // Its services show on the environment's page, so that is where the new one lands.
      if (row.key !== selected) select(row.key)
      openDialog({ kind: 'service', environment })
    } else if (action === 'connectService' && service) void connect(service.hostId, service.environmentId, service.path || undefined)
    else if (action === 'editService' && environment && service) openDialog({ kind: 'service', environment, service })
    else if (action === 'deleteService' && environment && service) {
      setConfirm(deleteRequest(environment, service, () => row.key === selected && row.parentKey && select(row.parentKey)))
    }
  }

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
    if (drag.kind === 'environment' && target.kind === 'product') return env(drag.id)?.productId !== target.id
    // Within its product an environment takes the place of the one it lands on.
    if (drag.kind === 'environment' && target.kind === 'environment') return drag.id !== target.id && env(drag.id)?.productId === env(target.id)?.productId
    if (drag.kind === 'service' && target.kind === 'environment') {
      const svc = services.find((s) => s.id === drag.id)
      return !!svc && svc.environmentId !== target.id
    }
    return false
  }

  const dropHost = (host: TreeRow, target: TreeRow) =>
    whileDropping(async () => {
      // A new membership starts as app; the role in the source environment doesn't carry over.
      const role = env(target.id)?.defaultJumpHostId === host.id ? 'bastion' : 'app'
      // Worked out before the drop; the host itself never counts, so the order doesn't matter.
      const meta = data?.hosts.find((h) => h.id === host.id)
      const hint = data && meta ? regionHintText(data, target.id, meta) : null
      if (await inv.putHost(target.id, host.id, role)) {
        expand(target.key)
        toast({ title: `Added ${host.label} to ${target.label}`, description: hint ?? undefined, tone: 'success' })
      }
    })

  /** A product's environments in their order, as ids. */
  const orderOf = (productId: string) => (data?.environments ?? []).filter((e) => e.productId === productId).sort(byPosition).map((e) => e.id)

  /** Puts the environment where `to` is in its product's order; the ones between shift by one. */
  const placeEnvironment = (id: string, productId: string, to: number) =>
    whileDropping(async () => {
      const ids = orderOf(productId)
      const from = ids.indexOf(id)
      if (from < 0 || to < 0 || to >= ids.length || from === to) return
      ids.splice(to, 0, ...ids.splice(from, 1))
      await inv.reorderEnvironments(productId, ids)
    })

  const moveEnvironment = (e: EnvironmentMeta, by: -1 | 1) => placeEnvironment(e.id, e.productId, orderOf(e.productId).indexOf(e.id) + by)

  const reorderEnvironment = (from: TreeRow, onto: TreeRow) => {
    const e = env(from.id)
    return e ? placeEnvironment(e.id, e.productId, orderOf(e.productId).indexOf(onto.id)) : undefined
  }

  /** Move up and Move down show only where there is somewhere to go. */
  const canRowAction = (row: TreeRow, action: RowAction) => {
    if (action !== 'moveEnvironmentUp' && action !== 'moveEnvironmentDown') return true
    const e = env(row.id)
    if (!e) return false
    const ids = orderOf(e.productId)
    return action === 'moveEnvironmentUp' ? ids[0] !== e.id : ids[ids.length - 1] !== e.id
  }

  // A drop re-parents the environment, so it asks first.
  const dropEnvironment = (from: TreeRow, target: TreeRow) =>
    setConfirm({
      title: `Move ${from.label} to ${target.label}?`,
      description: 'Its hosts, checkouts and services go with it.',
      confirmLabel: 'Move',
      gentle: { cancelLabel: 'Cancel' },
      run: () =>
        whileDropping(async () => {
          if (await inv.setEnvironmentProduct(from.id, target.id)) {
            expand(target.key)
            toast({ title: `Moved ${from.label} to ${target.label}`, tone: 'success' })
          }
        }),
    })

  // A drop moves the service to another environment, so it asks first and says what stays behind.
  const dropService = (from: TreeRow, target: TreeRow) => {
    const svc = services.find((s) => s.id === from.id)
    const source = svc && env(svc.environmentId)
    const dest = env(target.id)
    if (!svc || !source || !dest) return
    const detachCheckout = svc.kind === 'service' && svc.deploymentId !== null
    const checkout = detachCheckout ? deployStore.get().deployments.find((d) => d.id === svc.deploymentId)?.name : undefined
    const guarded = [source, dest].filter((e) => e.protected).map((e) => e.name)
    setConfirm({
      title: `Move ${svc.name} to ${dest.name}?`,
      description:
        (guarded.length ? `${guarded.join(' and ')} ${guarded.length > 1 ? 'are' : 'is'} protected. ` : '') +
        (detachCheckout
          ? `It keeps its host and settings, but its checkout${checkout ? ` ${checkout}` : ''} stays in ${source.name}: it can't be deployed until you give it a checkout in ${dest.name}.`
          : `It leaves ${source.name} and keeps its host and settings.`),
      confirmLabel: detachCheckout ? 'Move without checkout' : 'Move',
      gentle: { cancelLabel: 'Cancel' },
      run: () =>
        whileDropping(async () => {
          const moved = await attempt("Couldn't move the service", () => api.invoke('service:move', svc.id, dest.id, { detachCheckout }))
          if (!moved) return
          await Promise.all([loadDeploy(), reloadInventory()])
          expand(target.key)
          if (selected === from.key) select(`${target.key}/s:${svc.id}`)
          toast({ title: `Moved ${svc.name} to ${dest.name}`, tone: 'success' })
        }),
    })
  }

  /** Opens a product with its environments in view. */
  const showProduct = (id: string) => {
    expand(`p:${id}`)
    select(`p:${id}`)
  }

  const askDeleteProduct = (p: ProductMeta) => {
    // Main refuses while the product has environments; its message says so, and the toast offers to show them.
    if (data?.environments.some((e) => e.productId === p.id)) {
      void (async () => {
        const refuse = (message: string) =>
          toast({ title: `Couldn't delete ${p.name}`, description: message, tone: 'error', action: { label: 'Show them', run: () => showProduct(p.id) } })
        const deleted = await attempt(
          "Couldn't delete the product",
          async () => {
            await api.invoke('product:delete', p.id)
            return true
          },
          refuse,
        )
        if (deleted) {
          // They were moved away since this view last read them.
          await reloadInventory()
          toast({ title: `Deleted ${p.name}`, tone: 'success' })
        }
      })()
      return
    }
    setConfirm({
      title: `Delete ${p.name}?`,
      description: 'It has no environments, so nothing else is removed.',
      confirmLabel: 'Delete product',
      run: async () => {
        if (await inv.deleteProduct(p.id)) toast({ title: `Deleted ${p.name}`, tone: 'success' })
      },
    })
  }

  const askDeleteEnvironment = (e: EnvironmentMeta, key: NodeKey) => {
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
    if (sel.serviceId) {
      const svc = services.find((x) => x.id === sel.serviceId)
      const e = svc && env(svc.environmentId)
      if (!svc || !e) return null
      const envKey = parentOf(selected)
      return (
        <ServiceView
          key={svc.id}
          service={svc}
          env={e}
          data={data}
          onEdit={() => openDialog({ kind: 'service', environment: e, service: svc })}
          onDelete={() => setConfirm(deleteRequest(e, svc, () => select(envKey)))}
          onOpenEnvironment={() => select(envKey)}
        />
      )
    }
    if (sel.environmentId) {
      const e = env(sel.environmentId)
      if (!e) return null
      return (
        <EnvironmentView
          env={e}
          data={data}
          onNewHost={() => openDialog({ kind: 'host', presetEnvironment: { environmentId: e.id, role: 'app' }, envKey: selected })}
          onEdit={() => openDialog({ kind: 'environment', environment: e })}
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
          onNewEnvironment={() => newEnvironment(p.id, true)}
          onEdit={() => openDialog({ kind: 'product', product: p })}
          onDelete={() => askDeleteProduct(p)}
        />
      )
    }
    const looseHosts = data.hosts.filter((h) => h.environments.length === 0).length
    return (
      <>
        <PaneHeader lead={<Inbox aria-hidden className="size-4 text-muted" />} title="Unassigned hosts" />
        <p className="max-w-[64ch] px-8 pt-2 text-[13px] leading-5 text-muted">
          {plural(looseHosts, 'host')} in no environment. Drag them onto an environment in the tree.
        </p>
      </>
    )
  }

  return (
    <div className="flex h-full">
      {/* An aside, not a nav: the shell's sidebar is the app's one navigation landmark. */}
      <ResizablePanel panel="products" defaultWidth={272} label="Inventory" className="flex flex-col border-r border-line bg-surface/40">
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
              onDropService={dropService}
              onReorderEnvironment={(e, onto) => void reorderEnvironment(e, onto)}
              onRowAction={rowAction}
              canRowAction={canRowAction}
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
          <RailButton icon={Upload} label="Import products…" disabled={transfer.busy} onClick={() => void transfer.openImport()} />
          <RailButton icon={Download} label="Export products…" disabled={transfer.busy} onClick={() => void transfer.exportConfig()} />
        </div>
      </ResizablePanel>

      <section aria-label="Details" className="flex min-w-0 flex-1 flex-col">
        {data && (
          <RegionsUpgradeBanner
            data={data}
            onOpen={(id) => {
              const e = env(id)
              if (!e) return
              const key = environmentKey(e)
              expand(parentOf(key))
              select(key)
            }}
          />
        )}
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
          productId={dialog.productId}
          productLocked={dialog.locked}
          data={data}
          corruptVaultIds={corruptIds}
          onClose={closeDialog}
          onSaved={(e) => {
            closeDialog()
            const key = environmentKey(e)
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
            // It joins as a service named after it, listed on the environment's page.
            expand(dialog.envKey)
            select(dialog.envKey)
            const envId = dialog.presetEnvironment.environmentId
            const d = inventoryStore.get()
            const hint = d && h.environments.some((m) => m.environmentId === envId) ? regionHintText(d, envId, h) : null
            if (hint) toast({ title: 'In another region', description: hint })
          }}
        />
      )}
      {dialog?.kind === 'service' && dialogOpen && <ServiceDialog env={dialog.environment} service={dialog.service} onClose={closeDialog} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      {transfer.dialog}
    </div>
  )
}

function RailButton({ icon: Icon = Plus, label, onClick, disabled = false }: { icon?: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/[0.04] hover:text-fg disabled:cursor-wait disabled:opacity-55 disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      <Icon aria-hidden className="size-3.5" />
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
