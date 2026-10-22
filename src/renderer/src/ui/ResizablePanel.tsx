import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { readStored, writeStored } from './storage'

export const PANEL_MIN = 200
export const PANEL_MAX = 560
/** The content beside the panel never gets squeezed below this. */
export const CONTENT_MIN = 360
const KEY_STEP = 16

const storageKey = (panel: string) => `opsdeck.panel-width.${panel}`

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function readWidth(panel: string, fallback: number): number {
  const n = Number(readStored(storageKey(panel)))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

interface Props {
  /** Identifies the panel in localStorage, so each remembers its own width. */
  panel: string
  defaultWidth: number
  as?: 'aside' | 'nav'
  label?: string
  className?: string
  children: ReactNode
}

/**
 * A fixed-side list column with a drag handle on its right border. Drag, arrow keys (16px) or
 * double-click (reset) change the width; it persists per panel.
 */
export function ResizablePanel({ panel, defaultWidth, as: Tag = 'aside', label, className = '', children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [stored, setStored] = useState(() => readWidth(panel, defaultWidth))
  // Room the parent offers; 0 until measured (and in jsdom), which leaves only the static clamps.
  const [avail, setAvail] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const parent = wrapRef.current?.parentElement
    if (!parent) return
    const measure = () => setAvail(parent.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  const max = avail > 0 ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, avail - CONTENT_MIN)) : PANEL_MAX
  const width = clamp(stored, PANEL_MIN, max)

  const commit = useCallback(
    (next: number) => {
      const w = Math.round(clamp(next, PANEL_MIN, max))
      setStored(w)
      writeStored(storageKey(panel), String(w))
    },
    [panel, max],
  )

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: width }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d) setStored(clamp(d.startWidth + e.clientX - d.startX, PANEL_MIN, max))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    commit(d.startWidth + e.clientX - d.startX)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') commit(width - KEY_STEP)
    else if (e.key === 'ArrowRight') commit(width + KEY_STEP)
    else return
    e.preventDefault()
  }

  return (
    <div ref={wrapRef} className="relative flex shrink-0" style={{ width }}>
      <Tag aria-label={label} className={`${className} min-w-0 flex-1`}>
        {children}
      </Tag>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label ? `Resize ${label}` : 'Resize panel'}
        aria-valuenow={width}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(defaultWidth)}
        data-dragging={dragging || undefined}
        className="group absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize touch-none outline-none"
      >
        <span
          aria-hidden
          className={`absolute inset-y-0 left-[2px] w-0.5 transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent ${
            dragging ? 'bg-accent' : ''
          }`}
        />
      </div>
    </div>
  )
}
