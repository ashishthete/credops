import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { AppWindow, ChevronRight, Database, Inbox, Layers, Link2, Lock, MoreHorizontal, Pencil, Plus, Server, ShieldCheck, SquareTerminal, Trash2, type LucideIcon } from 'lucide-react'
import { Fragment, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type RefObject } from 'react'
import type { ProductIcon } from '../../../../shared/inventory'
import { SERVICE_KIND_LABEL, type ServiceKind } from '../../../../shared/services'
import { isFocusable, moveFocus, type NodeKey, type TreeRow } from '../../inventory/tree'
import { exitFast, fast, spring, useMotionSafe } from '../../ui/motion'
import { RegionChip } from '../../ui/RegionChip'
import { PRODUCT_ICON } from './ProductDialog'

/** Type chips and icons: accent for apps, amber for databases, violet for bastions. */
const KIND_COLOR: Record<ServiceKind, string> = { service: 'var(--accent)', db: 'var(--warn)', bastion: 'var(--violet)' }
const KIND_ICON: Record<ServiceKind, LucideIcon> = { service: AppWindow, db: Database, bastion: ShieldCheck }
const KIND_CHIP: Record<ServiceKind, string> = { service: 'app', db: 'db', bastion: 'bastion' }

export interface InventoryTreeProps {
  rows: TreeRow[]
  selected: NodeKey | null
  onSelect: (key: NodeKey) => void
  onToggle: (key: NodeKey) => void
  /** True when dropping `drag` on `target` would change something. */
  canDrop: (drag: TreeRow, target: TreeRow) => boolean
  onDropHost: (host: TreeRow, environment: TreeRow) => void
  onDropEnvironment: (environment: TreeRow, product: TreeRow) => void
  onDropService: (service: TreeRow, environment: TreeRow) => void
  /** Adds or edits from a product, environment or service row's menu; without it those rows have no menu. */
  onRowAction?: (row: TreeRow, action: RowAction) => void
  productIcons?: Readonly<Record<string, ProductIcon>>
}

type MoveKey = Parameters<typeof moveFocus>[2]

export type RowAction = 'newEnvironment' | 'editProduct' | 'newHost' | 'addService' | 'editEnvironment' | 'connectService' | 'editService' | 'deleteService'

type MenuKind = 'product' | 'environment' | 'service'
const hasRowMenu = (kind: TreeRow['kind']): kind is MenuKind => kind === 'product' || kind === 'environment' || kind === 'service'
const groupOf = (a: { action: RowAction; danger?: true }) =>
  a.danger ? 'delete' : a.action.startsWith('edit') ? 'edit' : a.action.startsWith('connect') ? 'connect' : 'add'

/** What a row's menu offers, in order. */
const ROW_ACTIONS: Record<MenuKind, { action: RowAction; label: string; icon: LucideIcon; danger?: true }[]> = {
  product: [
    { action: 'newEnvironment', label: 'New environment', icon: Layers },
    { action: 'editProduct', label: 'Edit product', icon: Pencil },
  ],
  environment: [
    { action: 'newHost', label: 'New host', icon: Server },
    { action: 'addService', label: 'Add service', icon: Plus },
    { action: 'editEnvironment', label: 'Edit environment', icon: Pencil },
  ],
  service: [
    { action: 'connectService', label: 'Connect to host', icon: SquareTerminal },
    { action: 'editService', label: 'Edit service', icon: Pencil },
    { action: 'deleteService', label: 'Delete service', icon: Trash2, danger: true },
  ],
}

interface MenuAt {
  row: TreeRow
  x: number
  y: number
  /** Top edge of the options button, when opened from it: a flipped menu sits above this. */
  up?: number
}

/**
 * What a row does when used. Rows read it through a ref that always holds the latest handlers, so
 * they can be memoized: a hover or a selection re-renders the rows it changes, not the whole tree.
 */
interface TreeActions {
  select: (row: TreeRow) => void
  toggle: (row: TreeRow) => void
  hover: (row: TreeRow, on: boolean) => void
  menu: (row: TreeRow, x: number, y: number, up?: number) => void
  dragStart: (row: TreeRow, e: DragEvent) => void
  dragOver: (row: TreeRow, e: DragEvent) => void
  dragLeave: (row: TreeRow, e: DragEvent) => void
  drop: (row: TreeRow, e: DragEvent) => void
  dragEnd: () => void
}
const MOVE_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** The visible row that carries tabIndex 0: the selection, or its nearest visible ancestor. */
function tabbableKey(rows: TreeRow[], selected: NodeKey | null): NodeKey | null {
  rows = rows.filter(isFocusable)
  const keys = new Set(rows.map((r) => r.key))
  for (let k = selected; k; k = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : null) {
    if (keys.has(k)) return k
  }
  return rows[0]?.key ?? null
}

/** Product → environment → service, as an ARIA tree of flat rows. Hosts, environments and services drag onto parents. */
export function InventoryTree({
  rows,
  selected,
  onSelect,
  onToggle,
  canDrop,
  onDropHost,
  onDropEnvironment,
  onDropService,
  onRowAction,
  productIcons = {},
}: InventoryTreeProps) {
  const tree = useRef<HTMLUListElement>(null)
  const focusNext = useRef<NodeKey | null>(null)
  const drag = useRef<TreeRow | null>(null)
  const [dragging, setDragging] = useState<TreeRow | null>(null)
  const [over, setOver] = useState<NodeKey | null>(null)
  const [hovered, setHovered] = useState<TreeRow | null>(null)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const tabKey = useMemo(() => tabbableKey(rows, selected), [rows, selected])
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])

  // Keyboard moves land focus after the row they target has rendered.
  useEffect(() => {
    const key = focusNext.current
    if (!key) return
    focusNext.current = null
    const els = tree.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []
    ;[...els].find((el) => el.dataset.key === key)?.focus()
  })

  // Rows can leave without a mouseleave or dragend (a collapse, a refresh): drop state that points at them.
  useEffect(() => {
    const keys = new Set(rows.map((r) => r.key))
    if (hovered && !keys.has(hovered.key)) setHovered(null)
    if (drag.current && !keys.has(drag.current.key)) endDrag()
  }, [rows, hovered])

  // Collapsing a row that holds focus would strand it on a hidden row; it moves to the collapsed row.
  const toggle = (row: TreeRow) => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key
    if (row.expanded && focused?.startsWith(`${row.key}/`) && tree.current?.contains(document.activeElement)) focusNext.current = row.key
    onToggle(row.key)
  }

  /** Product, environment and service rows have a menu of adds and edits. */
  const hasMenu = (row: TreeRow): boolean => !!onRowAction && hasRowMenu(row.kind)
  const openMenu = (row: TreeRow, x: number, y: number, up?: number) => {
    if (!hasMenu(row)) return
    // The options button toggles: a second click on it closes its own menu.
    setMenu((m) => (up !== undefined && m?.row.key === row.key ? null : { row, x, y, up }))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key ?? tabKey
    if (!key) return
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const el = tree.current && [...tree.current.querySelectorAll<HTMLElement>('[data-key]')].find((x) => x.dataset.key === key)
      const row = rows.find((r) => r.key === key)
      if (!el || !row) return
      e.preventDefault()
      const box = el.getBoundingClientRect()
      openMenu(row, box.left + 32, box.top + 28)
      return
    }
    if (MOVE_KEYS.has(e.key)) {
      e.preventDefault()
      const next = moveFocus(rows, key, e.key as MoveKey)
      if (next.toggle) onToggle(next.toggle)
      if (next.focus !== selected) onSelect(next.focus)
      focusNext.current = next.focus
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(key)
    }
  }

  const endDrag = () => {
    drag.current = null
    setDragging(null)
    setOver(null)
  }

  const latest: TreeActions = {
    select: (row) => onSelect(row.key),
    toggle,
    hover: (row, on) => setHovered((h) => (on ? (row.sharedCount > 0 ? row : null) : h?.key === row.key ? null : h)),
    menu: (row, x, y, up) => openMenu(row, x, y, up),
    dragStart: (row, e) => {
      if (row.kind !== 'host' && row.kind !== 'environment' && row.kind !== 'service') return
      drag.current = row
      setDragging(row)
      e.dataTransfer.effectAllowed = row.kind === 'service' ? 'move' : 'copy'
      e.dataTransfer.setData('text/plain', row.label)
    },
    dragOver: (row, e) => {
      if (!drag.current || !canDrop(drag.current, row)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = drag.current.kind === 'service' ? 'move' : 'copy'
      if (over !== row.key) setOver(row.key)
    },
    dragLeave: (row, e) => {
      if (over === row.key && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    drop: (row, e) => {
      e.preventDefault()
      const from = drag.current
      endDrag()
      // The key lives in a ref, not dataTransfer (F30); a drop that changes nothing is ignored.
      if (!from || !canDrop(from, row)) return
      if (from.kind === 'host') onDropHost(from, row)
      else if (from.kind === 'environment') onDropEnvironment(from, row)
      else if (from.kind === 'service') onDropService(from, row)
    },
    dragEnd: endDrag,
  }
  const actions = useRef(latest)
  useLayoutEffect(() => {
    actions.current = latest
  })

  const closeMenu = () => {
    setMenu(null)
    // Focus goes back to the row the menu was opened on.
    if (menu) focusNext.current = menu.row.key
  }

  return (
    <>
      <ul ref={tree} role="tree" aria-label="Products" onKeyDown={onKeyDown} className="flex flex-col pb-2">
        {/* Rows animate their own height, so a row coming or going needn't re-render its siblings. */}
        <AnimatePresence initial={false} presenceAffectsLayout={false}>
          {rows.map((row) =>
            row.kind === 'hint' ? (
              <TreeHint
                key={row.key}
                row={row}
                target={(row.parentKey && byKey.get(row.parentKey)) || row}
                over={over === row.parentKey}
                actions={actions}
              />
            ) : (
              <TreeItem
                key={row.key}
                row={row}
                selected={row.key === selected}
                tabbable={row.key === tabKey}
                dragging={dragging?.key === row.key}
                dropTarget={!!dragging && dragging.key !== row.key && canDrop(dragging, row)}
                over={over === row.key}
                sharedHighlight={!!hovered && hovered.key !== row.key && hovered.kind === row.kind && hovered.id === row.id}
                icon={row.kind === 'product' ? productIcons[row.id] : undefined}
                menuOpen={menu?.row.key === row.key}
                hasMenu={hasMenu(row)}
                actions={actions}
              />
            ),
          )}
        </AnimatePresence>
      </ul>
      {menu && <RowMenu menu={menu} onClose={closeMenu} onAction={onRowAction} />}
    </>
  )
}

interface TreeItemProps {
  row: TreeRow
  selected: boolean
  tabbable: boolean
  dragging: boolean
  dropTarget: boolean
  over: boolean
  sharedHighlight: boolean
  icon?: ProductIcon
  /** Product, environment and service rows open a menu of adds and edits. */
  hasMenu: boolean
  /** Its menu is open on this row. */
  menuOpen?: boolean
  actions: RefObject<TreeActions>
}

const TreeItem = memo(function TreeItem({
  row,
  selected,
  tabbable,
  dragging,
  dropTarget,
  over,
  sharedHighlight,
  icon,
  hasMenu,
  menuOpen,
  actions,
}: TreeItemProps) {
  const motionSafe = useMotionSafe()
  const onToggle = () => actions.current.toggle(row)
  const onHover = (on: boolean) => actions.current.hover(row, on)
  const onMenu = hasMenu ? (x: number, y: number, up?: number) => actions.current.menu(row, x, y, up) : undefined
  const drag = {
    onDragStart: (e: DragEvent) => actions.current.dragStart(row, e),
    onDragOver: (e: DragEvent) => actions.current.dragOver(row, e),
    onDragLeave: (e: DragEvent) => actions.current.dragLeave(row, e),
    onDrop: (e: DragEvent) => actions.current.drop(row, e),
    onDragEnd: () => actions.current.dragEnd(),
  }
  // Rows on their way out stay mounted for the exit animation, but nothing can reach them (F19).
  const present = useIsPresent()
  const draggable = present && (row.kind === 'host' || row.kind === 'environment' || row.kind === 'service')
  const pulse = sharedHighlight && motionSafe
  const descId = useId()
  // A hidden description carries the role, protection, region and other places; its name stays the bare label.
  // What the row is, since an environment and a host can share a name.
  const kindLabel =
    row.kind === 'host'
      ? `Host ${row.label}`
      : row.kind === 'environment'
        ? `Environment ${row.label}`
        : row.kind === 'service' && row.serviceKind
          ? `${SERVICE_KIND_LABEL[row.serviceKind]} ${row.label}`
          : undefined
  const alsoIn = row.alsoIn?.length ? `Also in ${row.alsoIn.join(', ')}` : undefined
  const description = kindLabel
    ? [
        kindLabel,
        row.kind === 'service' && row.hostLabel && `On ${row.hostLabel}`,
        row.protected && 'Protected',
        row.kind === 'environment' && row.childCount === 0 && 'No services',
        row.region && `Region ${row.region.code}`,
        alsoIn,
      ]
        .filter(Boolean)
        .join('. ')
    : undefined
  const describedBy = description ? `${descId}-d` : undefined
  const tint = (pct: number) => `color-mix(in oklab, ${row.color} ${pct}%, transparent)`

  return (
    <motion.li
      role="treeitem"
      aria-label={row.label}
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-describedby={describedBy}
      aria-hidden={present ? undefined : true}
      inert={!present}
      tabIndex={present && tabbable ? 0 : -1}
      data-key={present ? row.key : undefined}
      data-shared-highlight={sharedHighlight || undefined}
      data-pulse={pulse || undefined}
      data-drop-target={dropTarget || undefined}
      draggable={draggable}
      onClick={() => actions.current.select(row)}
      onContextMenu={(e) => {
        if (!onMenu) return
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={(e) => e.target === e.currentTarget && onHover(true)}
      onBlur={(e) => e.target === e.currentTarget && onHover(false)}
      // framer-motion forwards native onDrag* listeners on draggable elements, but types them as its pan gesture.
      {...(drag as Record<never, never>)}
      initial={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden' } : { opacity: 0 }}
      animate={
        motionSafe
          ? {
              height: 'auto',
              opacity: 1,
              transitionEnd: { overflow: 'visible' },
            }
          : { opacity: 1 }
      }
      exit={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden', transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      className={`group/row rounded-lg py-px outline-none select-none focus-visible:outline-none ${present ? '' : 'pointer-events-none'}`}
    >
      <div
        className={`relative flex h-[30px] cursor-default items-center gap-1.5 rounded-lg pr-1.5 text-[13px] transition-[color,opacity] group-focus-visible/row:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_70%,transparent)] ${
          selected ? 'text-fg' : 'text-fg/75 hover:bg-white/[0.035] hover:text-fg'
        } ${dragging ? 'opacity-45' : ''}`}
        style={{ paddingLeft: 6 + row.depth * 14 }}
      >
        {selected && (
          <motion.span
            aria-hidden
            layoutId={motionSafe ? 'tree-active' : undefined}
            transition={spring}
            className="absolute inset-0 rounded-lg"
            style={{
              background: tint(11),
              boxShadow: `inset 2px 0 0 0 ${row.color}`,
            }}
          />
        )}
        {sharedHighlight && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-lg"
            style={{
              boxShadow: `inset 0 0 0 1px ${tint(70)}, 0 0 14px -4px ${row.color}`,
            }}
            animate={pulse ? { opacity: [0.35, 1, 0.35] } : undefined}
            transition={pulse ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } : undefined}
          />
        )}
        {dropTarget && (
          <span
            aria-hidden
            className={`absolute inset-0 rounded-lg transition-[background-color,box-shadow] ${
              over
                ? 'bg-accent/15 shadow-[inset_0_0_0_1.5px_var(--accent),0_0_18px_-6px_var(--accent)]'
                : 'bg-accent/[0.05] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_40%,transparent)]'
            }`}
          />
        )}

        <span
          aria-hidden
          data-testid="tree-chevron"
          onClick={(e) => {
            e.stopPropagation()
            if (row.expandable) onToggle()
          }}
          className={`relative grid size-4 shrink-0 place-items-center rounded text-muted transition-colors hover:text-fg ${
            row.expandable ? '' : 'invisible'
          }`}
        >
          {motionSafe ? (
            <motion.span initial={false} animate={{ rotate: row.expanded ? 90 : 0 }} transition={spring} className="grid">
              <ChevronRight className="size-3.5" strokeWidth={2.2} />
            </motion.span>
          ) : (
            <ChevronRight className={`size-3.5 ${row.expanded ? 'rotate-90' : ''}`} strokeWidth={2.2} />
          )}
        </span>

        <RowIcon row={row} icon={icon} />
        <span
          title={kindLabel}
          className={`relative min-w-0 flex-1 truncate ${row.kind === 'product' || row.kind === 'group' ? 'font-medium' : ''}`}
        >
          {row.label}
          {row.kind === 'service' && row.hostLabel && <span className="ml-1.5 text-[11.5px] text-muted">{row.hostLabel}</span>}
        </span>
        {description && (
          <span id={describedBy} className="sr-only">
            {description}
          </span>
        )}
        {row.protected && <Lock aria-hidden className="relative size-3 shrink-0 text-warn/90" strokeWidth={2.2} />}
        {row.kind === 'host' && alsoIn && (
          <span title={alsoIn} className="relative grid shrink-0 place-items-center text-muted">
            <Link2 aria-hidden className="size-3" strokeWidth={2.4} />
          </span>
        )}
        {row.region && !row.regionOnParent && <RegionChip region={row.region} className="relative" />}
        {row.kind === 'service' && row.serviceKind && (
          <span
            title={SERVICE_KIND_LABEL[row.serviceKind]}
            className="relative shrink-0 rounded-full px-1.5 text-[10.5px] leading-[16px] font-medium"
            style={{
              color: KIND_COLOR[row.serviceKind],
              background: `color-mix(in oklab, ${KIND_COLOR[row.serviceKind]} 13%, transparent)`,
            }}
          >
            {KIND_CHIP[row.serviceKind]}
          </span>
        )}
        {row.expandable && !row.expanded && row.childCount > 0 && (
          <span className="relative shrink-0 text-[11px] text-muted tabular-nums">{row.childCount}</span>
        )}
        {onMenu && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Options for ${row.label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen || false}
            onClick={(e) => {
              e.stopPropagation()
              const box = e.currentTarget.getBoundingClientRect()
              onMenu(box.left, box.bottom + 2, box.top)
            }}
            // Over the row's end, not beside it: a hidden button keeps no room from the label.
            className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded bg-[color-mix(in_oklab,var(--surface)_40%,var(--bg))] text-muted opacity-0 shadow-[-8px_0_6px_-1px_color-mix(in_oklab,var(--surface)_40%,var(--bg))] transition-[opacity,color,background-color] group-hover/row:opacity-100 group-focus-visible/row:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
          >
            <MoreHorizontal aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
    </motion.li>
  )
})

function RowIcon({ row, icon }: { row: TreeRow; icon?: ProductIcon }) {
  if (row.kind === 'product') {
    const Icon = PRODUCT_ICON[icon ?? 'boxes']
    return (
      <span
        aria-hidden
        className="relative grid size-5 shrink-0 place-items-center rounded-md"
        style={
          {
            color: row.color,
            background: `color-mix(in oklab, ${row.color} 16%, transparent)`,
          } as CSSProperties
        }
      >
        <Icon className="size-3" strokeWidth={2.2} />
      </span>
    )
  }
  if (row.kind === 'environment') {
    return (
      <span aria-hidden className="relative grid size-4 shrink-0 place-items-center">
        <span
          className="size-2 rounded-full"
          style={{
            background: row.color,
            boxShadow: `0 0 8px -1px ${row.color}`,
          }}
        />
      </span>
    )
  }
  if (row.kind === 'service' && row.serviceKind) {
    const Icon = KIND_ICON[row.serviceKind]
    return <Icon aria-hidden className="relative size-3.5 shrink-0" style={{ color: KIND_COLOR[row.serviceKind] }} strokeWidth={2} />
  }
  const Icon = row.kind === 'group' ? Inbox : Server
  return <Icon aria-hidden className="relative size-3.5 shrink-0 text-muted" strokeWidth={2} />
}

/** "No services — drag a host here", under an empty environment; a drop here lands on the environment. */
const TreeHint = memo(function TreeHint({
  row,
  target,
  over,
  actions,
}: {
  row: TreeRow
  /** The environment a drop here lands on. */
  target: TreeRow
  over: boolean
  actions: RefObject<TreeActions>
}) {
  const motionSafe = useMotionSafe()
  const present = useIsPresent()
  const drop = {
    onDragOver: (e: DragEvent) => actions.current.dragOver(target, e),
    onDragLeave: (e: DragEvent) => actions.current.dragLeave(target, e),
    onDrop: (e: DragEvent) => actions.current.drop(target, e),
  }
  return (
    <motion.li
      role="none"
      aria-hidden={present ? undefined : true}
      {...(drop as Record<never, never>)}
      initial={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden' } : { opacity: 0 }}
      animate={
        motionSafe
          ? {
              height: 'auto',
              opacity: 1,
              transitionEnd: { overflow: 'visible' },
            }
          : { opacity: 1 }
      }
      exit={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden', transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      className="select-none"
    >
      <div
        className={`flex h-6 items-center rounded-lg pr-2 text-[12px] text-muted italic ${over ? 'bg-accent/10 text-fg' : ''}`}
        style={{ paddingLeft: 6 + row.depth * 16 + 24 }}
      >
        {row.label}
      </div>
    </motion.li>
  )
})

/** A product, environment or service row's adds and edits, at a point; arrows move, Escape closes. */
function RowMenu({
  menu,
  onClose,
  onAction,
}: {
  menu: MenuAt
  onClose: () => void
  onAction?: (row: TreeRow, action: RowAction) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { row } = menu
  const kind = row.kind

  // Keep the menu on screen: flip above its anchor when it would run off the bottom, and pull it in from the right.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const gap = 8
    el.style.left = `${Math.max(gap, Math.min(menu.x, window.innerWidth - width - gap))}px`
    el.style.top = `${menu.y + height > window.innerHeight - gap ? Math.max(gap, (menu.up ?? menu.y) - height - 2) : menu.y}px`
  }, [menu.x, menu.y])

  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    items?.[0]?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (ref.current?.contains(t)) return
      // The options button toggles; a mousedown on it must not close the menu and let the click reopen it.
      if (t.closest?.('button[aria-haspopup="menu"][aria-expanded="true"]')) return
      onClose()
    }
    const away = () => onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once per menu
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      els[(n + els.length) % els.length]?.focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(els.length - 1)
    else if (e.key === 'Tab') onClose()
  }

  const item = 'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] transition-colors focus:outline-none'
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Options for ${row.label}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-50 w-[200px] rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
    >
      {hasRowMenu(kind) &&
        ROW_ACTIONS[kind].map(({ action, label, icon: Icon, danger }, i, all) => (
          <Fragment key={action}>
            {/* Adds, edits and deletes each sit apart. */}
            {i > 0 && groupOf(all[i - 1]) !== groupOf(all[i]) && <div role="separator" className="my-1 h-px bg-line/70" />}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose()
                onAction?.(row, action)
              }}
              className={`${item} ${danger ? 'text-err hover:bg-err/12 focus:bg-err/12' : 'text-fg/90 hover:bg-white/6 focus:bg-white/6'}`}
            >
              <Icon aria-hidden className="size-3.5 opacity-80" />
              {label}
            </button>
          </Fragment>
        ))}
    </div>
  )
}
