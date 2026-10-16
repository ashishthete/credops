import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { ChevronRight, Inbox, Link2, Lock, Server } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import type { ProductIcon } from '../../../../shared/inventory'
import { moveFocus, type NodeKey, type TreeRow } from '../../inventory/tree'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { PRODUCT_ICON } from './ProductDialog'

export interface InventoryTreeProps {
  rows: TreeRow[]
  selected: NodeKey | null
  onSelect: (key: NodeKey) => void
  onToggle: (key: NodeKey) => void
  /** True when dropping `drag` on `target` would change something. */
  canDrop: (drag: TreeRow, target: TreeRow) => boolean
  onDropHost: (host: TreeRow, environment: TreeRow) => void
  onDropEnvironment: (environment: TreeRow, product: TreeRow) => void
  productIcons?: Readonly<Record<string, ProductIcon>>
}

type MoveKey = Parameters<typeof moveFocus>[2]
const MOVE_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** The visible row that carries tabIndex 0: the selection, or its nearest visible ancestor. */
function tabbableKey(rows: TreeRow[], selected: NodeKey | null): NodeKey | null {
  const keys = new Set(rows.map((r) => r.key))
  for (let k = selected; k; k = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : null) {
    if (keys.has(k)) return k
  }
  return rows[0]?.key ?? null
}

/** Product → environment → host, as an ARIA tree of flat rows. Hosts and environments drag onto parents. */
export function InventoryTree({ rows, selected, onSelect, onToggle, canDrop, onDropHost, onDropEnvironment, productIcons = {} }: InventoryTreeProps) {
  const tree = useRef<HTMLUListElement>(null)
  const focusNext = useRef<NodeKey | null>(null)
  const drag = useRef<TreeRow | null>(null)
  const [dragging, setDragging] = useState<TreeRow | null>(null)
  const [over, setOver] = useState<NodeKey | null>(null)
  const [hovered, setHovered] = useState<TreeRow | null>(null)
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

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key ?? tabKey
    if (!key) return
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

  return (
    <ul ref={tree} role="tree" aria-label="Products" onKeyDown={onKeyDown} className="flex flex-col pb-2">
      <AnimatePresence initial={false}>
        {rows.map((row) => (
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
            {...dropHandlers(row)}
          />
        ))}
      </AnimatePresence>
    </ul>
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
  onSelect: () => void
  onToggle: () => void
  onHover: (on: boolean) => void
  onDragStart: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
}

function TreeItem({ row, selected, tabbable, dragging, dropTarget, over, sharedHighlight, icon, onSelect, onToggle, onHover, ...drag }: TreeItemProps) {
  const motionSafe = useMotionSafe()
  // Rows on their way out stay mounted for the exit animation, but nothing can reach them (F19).
  const present = useIsPresent()
  const draggable = present && (row.kind === 'host' || row.kind === 'environment')
  const pulse = sharedHighlight && motionSafe
  const descId = useId()
  // The visible Shared badge and a hidden "Protected" describe the row; its name stays the bare label.
  const describedBy = [row.protected && `${descId}-p`, row.sharedCount > 0 && `${descId}-s`].filter(Boolean).join(' ') || undefined
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
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={(e) => e.target === e.currentTarget && onHover(true)}
      onBlur={(e) => e.target === e.currentTarget && onHover(false)}
      // framer-motion forwards native onDrag* listeners on draggable elements, but types them as its pan gesture.
      {...(drag as Record<never, never>)}
      initial={motionSafe ? { height: 0, opacity: 0, overflow: 'hidden' } : { opacity: 0 }}
      animate={motionSafe ? { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } } : { opacity: 1 }}
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
            style={{ background: tint(11), boxShadow: `inset 2px 0 0 0 ${row.color}` }}
          />
        )}
        {sharedHighlight && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-lg"
            style={{ boxShadow: `inset 0 0 0 1px ${tint(70)}, 0 0 14px -4px ${row.color}` }}
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
        <span className={`relative min-w-0 flex-1 truncate ${row.kind === 'product' || row.kind === 'group' ? 'font-medium' : ''}`}>
          {row.label}
        </span>
        {row.protected && (
          <span id={`${descId}-p`} className="sr-only">
            Protected
          </span>
        )}
        {row.protected && <Lock aria-hidden className="relative size-3 shrink-0 text-warn/90" strokeWidth={2.2} />}
        {row.sharedCount > 0 && (
          <span
            id={`${descId}-s`}
            title={`Also in ${row.sharedCount} other ${row.sharedCount === 1 ? 'place' : 'places'}`}
            className="relative inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium"
            style={{ color: row.color, background: tint(13), boxShadow: `inset 0 0 0 1px ${tint(26)}` }}
          >
            <Link2 aria-hidden className="size-2.5" strokeWidth={2.4} />
            Shared
          </span>
        )}
        {row.kind === 'host' && row.role && <span className="relative shrink-0 text-[10.5px] text-muted">{row.role}</span>}
        {row.expandable && !row.expanded && (
          <span className="relative shrink-0 text-[11px] text-muted tabular-nums">{row.childCount}</span>
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
        style={{ color: row.color, background: `color-mix(in oklab, ${row.color} 16%, transparent)` } as CSSProperties}
      >
        <Icon className="size-3" strokeWidth={2.2} />
      </span>
    )
  }
  if (row.kind === 'environment') {
    return (
      <span aria-hidden className="relative grid size-4 shrink-0 place-items-center">
        <span className="size-2 rounded-full" style={{ background: row.color, boxShadow: `0 0 8px -1px ${row.color}` }} />
      </span>
    )
  }
  const Icon = row.kind === 'group' ? Inbox : Server
  return <Icon aria-hidden className="relative size-3.5 shrink-0 text-muted" strokeWidth={2} />
}
