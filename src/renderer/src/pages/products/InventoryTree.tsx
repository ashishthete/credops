import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { Check, ChevronRight, Inbox, Link2, Lock, MoreHorizontal, Server, Unlink } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { HOST_ROLES, type HostRole, type ProductIcon } from '../../../../shared/inventory'
import { isFocusable, moveFocus, type NodeKey, type TreeRow } from '../../inventory/tree'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { PRODUCT_ICON } from './ProductDialog'
import { ROLE_LABEL } from './ProductView'

/** Role chips: accent for app, amber for db, violet for bastion, muted for other. */
const ROLE_COLOR: Record<HostRole, string> = {
  app: 'var(--accent)',
  db: 'var(--warn)',
  bastion: '#a78bfa',
  other: 'var(--muted)',
}

export interface InventoryTreeProps {
  rows: TreeRow[]
  selected: NodeKey | null
  onSelect: (key: NodeKey) => void
  onToggle: (key: NodeKey) => void
  /** True when dropping `drag` on `target` would change something. */
  canDrop: (drag: TreeRow, target: TreeRow) => boolean
  onDropHost: (host: TreeRow, environment: TreeRow) => void
  onDropEnvironment: (environment: TreeRow, product: TreeRow) => void
  /** Sets a host's role in the environment it is listed under. */
  onSetRole: (host: TreeRow, environment: TreeRow, role: HostRole) => void
  onRemoveHost: (host: TreeRow, environment: TreeRow) => void
  productIcons?: Readonly<Record<string, ProductIcon>>
}

type MoveKey = Parameters<typeof moveFocus>[2]
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

/** Product → environment → host, as an ARIA tree of flat rows. Hosts and environments drag onto parents. */
export function InventoryTree({
  rows,
  selected,
  onSelect,
  onToggle,
  canDrop,
  onDropHost,
  onDropEnvironment,
  onSetRole,
  onRemoveHost,
  productIcons = {},
}: InventoryTreeProps) {
  const tree = useRef<HTMLUListElement>(null)
  const focusNext = useRef<NodeKey | null>(null)
  const drag = useRef<TreeRow | null>(null)
  const [dragging, setDragging] = useState<TreeRow | null>(null)
  const [over, setOver] = useState<NodeKey | null>(null)
  const [hovered, setHovered] = useState<TreeRow | null>(null)
  const [menu, setMenu] = useState<{
    host: TreeRow
    env: TreeRow
    x: number
    y: number
  } | null>(null)
  const tabKey = useMemo(() => tabbableKey(rows, selected), [rows, selected])

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

  /** The role menu belongs to a host listed under an environment. */
  const openMenu = (host: TreeRow, x: number, y: number) => {
    const env = rows.find((r) => r.key === host.parentKey)
    if (host.kind === 'host' && env?.kind === 'environment') setMenu({ host, env, x, y })
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

  const dropHandlers = (row: TreeRow) => ({
    onDragStart: (e: DragEvent) => {
      if (row.kind !== 'host' && row.kind !== 'environment') return
      drag.current = row
      setDragging(row)
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('text/plain', row.label)
    },
    onDragOver: (e: DragEvent) => {
      if (!drag.current || !canDrop(drag.current, row)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (over !== row.key) setOver(row.key)
    },
    onDragLeave: (e: DragEvent) => {
      if (over === row.key && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = drag.current
      endDrag()
      // The key lives in a ref, not dataTransfer (F30); a drop that changes nothing is ignored.
      if (!from || !canDrop(from, row)) return
      if (from.kind === 'host') onDropHost(from, row)
      else if (from.kind === 'environment') onDropEnvironment(from, row)
    },
    onDragEnd: endDrag,
  })

  const closeMenu = () => {
    setMenu(null)
    // Focus goes back to the row the menu was opened on.
    if (menu) focusNext.current = menu.host.key
  }

  return (
    <>
      <ul ref={tree} role="tree" aria-label="Products" onKeyDown={onKeyDown} className="flex flex-col pb-2">
        <AnimatePresence initial={false}>
          {rows.map((row) =>
            row.kind === 'hint' ? (
              <TreeHint
                key={row.key}
                row={row}
                over={over === row.parentKey}
                {...pick(dropHandlers(rows.find((r) => r.key === row.parentKey) ?? row))}
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
                onSelect={() => onSelect(row.key)}
                onToggle={() => toggle(row)}
                onHover={(on) => setHovered((h) => (on ? (row.sharedCount > 0 ? row : null) : h?.key === row.key ? null : h))}
                onMenu={
                  row.kind === 'host' && rows.some((r) => r.key === row.parentKey && r.kind === 'environment')
                    ? (x, y) => openMenu(row, x, y)
                    : undefined
                }
                {...dropHandlers(row)}
              />
            ),
          )}
        </AnimatePresence>
      </ul>
      {menu && <RoleMenu menu={menu} onClose={closeMenu} onSetRole={onSetRole} onRemove={onRemoveHost} />}
    </>
  )
}

/** A hint row only takes drops; it can't be dragged. */
const pick = ({
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) => ({
  onDragOver,
  onDragLeave,
  onDrop,
})

interface TreeItemProps {
  row: TreeRow
  selected: boolean
  tabbable: boolean
  dragging: boolean
  dropTarget: boolean
  over: boolean
  sharedHighlight: boolean
  icon?: ProductIcon
  onSelect: () => void
  onToggle: () => void
  onHover: (on: boolean) => void
  /** Host rows under an environment: opens the role menu at a point. */
  onMenu?: (x: number, y: number) => void
  onDragStart: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
}

function TreeItem({
  row,
  selected,
  tabbable,
  dragging,
  dropTarget,
  over,
  sharedHighlight,
  icon,
  onSelect,
  onToggle,
  onHover,
  onMenu,
  ...drag
}: TreeItemProps) {
  const motionSafe = useMotionSafe()
  // Rows on their way out stay mounted for the exit animation, but nothing can reach them (F19).
  const present = useIsPresent()
  const draggable = present && (row.kind === 'host' || row.kind === 'environment')
  const pulse = sharedHighlight && motionSafe
  const descId = useId()
  // The visible Shared badge and a hidden "Protected" describe the row; its name stays the bare label.
  // What the row is, since an environment and a host can share a name.
  const kindLabel = row.kind === 'host' ? `Host ${row.label}` : row.kind === 'environment' ? `Environment ${row.label}` : undefined
  const alsoIn = row.alsoIn?.length ? `Also in ${row.alsoIn.join(', ')}` : undefined
  const description = kindLabel
    ? [
        kindLabel,
        row.kind === 'host' && row.role && `Role ${ROLE_LABEL[row.role]}`,
        row.protected && 'Protected',
        row.kind === 'environment' && row.sharedCount > 0 && 'Shared',
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
      onClick={onSelect}
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
      exit={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden', transition: fast } : { opacity: 0, transition: fast }}
      transition={motionSafe ? spring : fast}
      className={`group/row rounded-lg py-px outline-none select-none focus-visible:outline-none ${present ? '' : 'pointer-events-none'}`}
    >
      <div
        className={`relative flex h-[30px] cursor-default items-center gap-2 rounded-lg pr-2 text-[13px] transition-[color,opacity] group-focus-visible/row:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_70%,transparent)] ${
          selected ? 'text-fg' : 'text-fg/75 hover:bg-white/[0.035] hover:text-fg'
        } ${dragging ? 'opacity-45' : ''}`}
        style={{ paddingLeft: 6 + row.depth * 16 }}
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
        {row.kind !== 'host' && row.sharedCount > 0 && (
          <span
            title={`Also in ${row.sharedCount} other ${row.sharedCount === 1 ? 'place' : 'places'}`}
            className="relative inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium"
            style={{
              color: row.color,
              background: tint(13),
              boxShadow: `inset 0 0 0 1px ${tint(26)}`,
            }}
          >
            <Link2 aria-hidden className="size-2.5" strokeWidth={2.4} />
            Shared
          </span>
        )}
        {row.kind === 'host' && row.role && (
          <span
            title={`Role: ${ROLE_LABEL[row.role]}`}
            className="relative shrink-0 rounded-full px-1.5 text-[10.5px] leading-[16px] font-medium"
            style={{
              color: ROLE_COLOR[row.role],
              background: `color-mix(in oklab, ${ROLE_COLOR[row.role]} 13%, transparent)`,
            }}
          >
            {row.role}
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
            onClick={(e) => {
              e.stopPropagation()
              const box = e.currentTarget.getBoundingClientRect()
              onMenu(box.left, box.bottom + 2)
            }}
            className="relative grid size-5 shrink-0 place-items-center rounded text-muted opacity-0 transition-[opacity,color,background-color] group-hover/row:opacity-100 group-focus-visible/row:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
          >
            <MoreHorizontal aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
    </motion.li>
  )
}

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
  const Icon = row.kind === 'group' ? Inbox : Server
  return <Icon aria-hidden className="relative size-3.5 shrink-0 text-muted" strokeWidth={2} />
}

/** "No hosts — drag one here", under an empty environment; a drop here lands on the environment. */
function TreeHint({
  row,
  over,
  ...drop
}: {
  row: TreeRow
  over: boolean
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) {
  const motionSafe = useMotionSafe()
  const present = useIsPresent()
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
      exit={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden', transition: fast } : { opacity: 0, transition: fast }}
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
}

/** Role radios and remove for a host row, at a point; arrows move, Escape closes. */
function RoleMenu({
  menu,
  onClose,
  onSetRole,
  onRemove,
}: {
  menu: { host: TreeRow; env: TreeRow; x: number; y: number }
  onClose: () => void
  onSetRole: (host: TreeRow, environment: TreeRow, role: HostRole) => void
  onRemove: (host: TreeRow, environment: TreeRow) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { host, env } = menu

  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ;(ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? items?.[0])?.focus()
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
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
      aria-label={`Options for ${host.label}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-50 w-[200px] rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
    >
      {HOST_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          role="menuitemradio"
          aria-checked={host.role === role}
          onClick={() => {
            onClose()
            if (host.role !== role) onSetRole(host, env, role)
          }}
          className={`${item} text-fg/90 hover:bg-white/6 focus:bg-white/6`}
        >
          <Check aria-hidden className={`size-3.5 ${host.role === role ? 'opacity-90' : 'opacity-0'}`} />
          Role: {ROLE_LABEL[role]}
        </button>
      ))}
      <div role="separator" className="my-1 h-px bg-line/70" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          onRemove(host, env)
        }}
        className={`${item} text-err hover:bg-err/12 focus:bg-err/12`}
      >
        <Unlink aria-hidden className="size-3.5 opacity-80" />
        Remove from {env.label}
      </button>
    </div>
  )
}
