import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** Lists with more rows than this draw only the rows near the view; shorter ones draw every row, as before. */
export const WINDOW_AFTER = 100
/** How far past the view, each way, rows are still drawn. */
const OVERSCAN_PX = 400
/** The view's height before it has been measured (and in jsdom, which has no layout). */
const FALLBACK_VIEW_PX = 600

interface Options {
  /** One stable key per item, in list order: measured heights are kept by key. */
  keys: readonly string[]
  /** An item's height before it has been drawn and measured. Keep it stable (useCallback). */
  estimate: (index: number) => number
  /** Space below an item that its own box doesn't include (a margin). Keep it stable (useCallback). */
  gap?: (index: number) => number
  /** The element that scrolls. */
  scroller: RefObject<HTMLElement | null>
  /** The element the items are laid out in, somewhere inside the scroller. */
  list: RefObject<HTMLElement | null>
  /**
   * The item that must stay drawn (the selection, the active option): when it changes, the view scrolls the
   * least it can to show it, and while scrolled away it is still drawn, out of flow, so focus and
   * aria-activedescendant keep their element.
   */
  keep?: number
  enabled: boolean
}

export interface ListWindow {
  enabled: boolean
  /** Items [start, end) are drawn in flow, between a spacer of `before` and one of `after` pixels. */
  start: number
  end: number
  before: number
  after: number
  /** Whether to draw item `i`: in flow, pinned (the kept item while out of range; draw it with pinnedStyle), or not. */
  show: (i: number) => 'flow' | 'pinned' | null
  pinnedStyle: (i: number) => CSSProperties
  /** A ref for item `i`'s element, so its real height replaces the estimate. */
  measure: (i: number) => (el: HTMLElement | null) => void
}

const noMeasure = () => () => {}

/** The first index in `offsets` (ascending) whose value is above `value`. */
function firstAbove(offsets: number[], value: number): number {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid]! > value) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Windowing for a long list of variable-height items: only those near the scroller's view are drawn, with
 * spacers standing in for the rest. Disabled, it draws everything and touches nothing.
 */
export function useListWindow({ keys, estimate, gap, scroller, list, keep = -1, enabled }: Options): ListWindow {
  const n = keys.length
  const sizes = useRef(new Map<string, number>())
  const [measured, setMeasured] = useState(0)
  // offsets[i] is item i's top, offsets[n] the whole height.
  const offsets = useMemo(() => {
    const out = [0]
    for (let i = 0; i < n; i++) out.push(out[i]! + (sizes.current.get(keys[i]!) ?? estimate(i) + (gap?.(i) ?? 0)))
    return out
    // `measured` stands for the sizes map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, n, estimate, gap, measured])

  // Where the list starts inside the scroller's content.
  const origin = useCallback(() => {
    const s = scroller.current
    const l = list.current
    return s && l ? l.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop : 0
  }, [scroller, list])

  // `sync`: the top came from bringing the kept item into view, and the scroller has yet to follow.
  const [view, setView] = useState({ top: 0, height: 0, sync: false })
  const [kept, setKept] = useState<number | null>(null)
  const height = view.height || FALLBACK_VIEW_PX
  let top = view.top
  if (enabled && keep !== kept) {
    setKept(keep)
    if (keep >= 0 && keep < n) {
      const a = offsets[keep]!
      const b = offsets[keep + 1]!
      const next = a < top ? a : b > top + height ? Math.max(0, b - height) : top
      if (next !== top) {
        top = next
        setView({ top: next, height: view.height, sync: true })
      }
    }
  }

  useLayoutEffect(() => {
    const s = scroller.current
    if (!enabled || !view.sync || !s) return
    s.scrollTop = origin() + view.top
  }, [enabled, view, scroller, origin])

  useLayoutEffect(() => {
    const s = scroller.current
    if (!enabled || !s) return
    const read = () => {
      const t = Math.max(0, s.scrollTop - origin())
      const h = s.clientHeight
      setView((v) => (v.top === t && v.height === h && !v.sync ? v : { top: t, height: h, sync: false }))
    }
    // Only the height at first: the top may be waiting for the scroller to follow the kept item.
    setView((v) => (v.height === s.clientHeight ? v : { ...v, height: s.clientHeight }))
    s.addEventListener('scroll', read, { passive: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    resize?.observe(s)
    return () => {
      s.removeEventListener('scroll', read)
      resize?.disconnect()
    }
  }, [enabled, scroller, origin])

  const measure = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      const key = keys[i]
      // Unlaid-out elements (jsdom, display: none) measure 0; the estimate stands.
      if (!el || key === undefined || !el.offsetHeight) return
      const size = el.offsetHeight + (gap?.(i) ?? 0)
      if (Math.abs((sizes.current.get(key) ?? -1) - size) < 0.5) return
      sizes.current.set(key, size)
      setMeasured((m) => m + 1)
    },
    [keys, gap],
  )

  if (!enabled) {
    return { enabled, start: 0, end: n, before: 0, after: 0, show: () => 'flow', pinnedStyle: () => ({}), measure: noMeasure }
  }
  const start = Math.min(n, Math.max(0, firstAbove(offsets, top - OVERSCAN_PX) - 1))
  const end = Math.max(start, Math.min(n, firstAbove(offsets, top + height + OVERSCAN_PX)))
  return {
    enabled,
    start,
    end,
    before: offsets[start]!,
    after: offsets[n]! - offsets[end]!,
    show: (i) => (i >= start && i < end ? 'flow' : i === keep ? 'pinned' : null),
    pinnedStyle: (i) => ({ position: 'absolute', top: offsets[i], left: 0, right: 0 }),
    measure,
  }
}
