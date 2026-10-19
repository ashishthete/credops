import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fast, spring, useMotionSafe } from '../ui/motion'
import { isMac, useShortcut } from '../ui/shortcuts'
import { attachSession, getTerminal, setLastSize } from './registry'

const CHUNK_CHARS = 32 * 1024
const RESIZE_DEBOUNCE_MS = 50

/** Splits input into chunks of at most CHUNK_CHARS without cutting a surrogate pair. */
function* chunks(data: string): Generator<string> {
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + CHUNK_CHARS, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
    yield data.slice(i, end)
    i = end
  }
}

/** Combos the app owns: xterm lets these through to the window shortcut handler. */
function isAppCombo(e: KeyboardEvent): boolean {
  const modPressed = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!modPressed || e.altKey) return false
  if (e.shiftKey) return e.code === 'BracketRight' || e.code === 'BracketLeft'
  return /^[twfk1-8]$/i.test(e.key)
}

/** Mounted only for the visible view: a hidden view's listener would preventDefault mod+f first. */
function SearchShortcut({ onFire }: { onFire: () => void }) {
  useShortcut('mod+f', onFire)
  return null
}

export function TerminalView({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const motionSafe = useMotionSafe()
  const host = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [opened, setOpened] = useState(visible)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  if (visible && !opened) setOpened(true)

  // Mount: open the term into our div, wire input, size and selection. Runs once, on first visible.
  useEffect(() => {
    const el = host.current
    if (!opened || !el) return
    const { term, fit } = getTerminal(sessionId)
    if (term.element) el.appendChild(term.element)
    else term.open(el)
    void attachSession(sessionId)

    let lastSent = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const syncSize = () => {
      if (!visibleRef.current) return
      try {
        fit.fit()
      } catch {
        return // not laid out yet
      }
      const { cols, rows } = term
      if (!cols || !rows) return
      setLastSize(cols, rows)
      const key = `${cols}x${rows}`
      clearTimeout(timer) // a pending resize is stale as soon as the size changes again
      if (key === lastSent) return
      timer = setTimeout(() => {
        lastSent = key
        api.invoke('session:resize', sessionId, cols, rows).catch(() => {})
      }, RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(syncSize)
    observer.observe(el)
    syncSize()

    const subs = [
      term.onData((data) => {
        for (const chunk of chunks(data)) api.invoke('session:write', sessionId, chunk).catch(() => {})
      }),
      term.onSelectionChange(() => {
        const selection = term.getSelection()
        if (selection) navigator.clipboard?.writeText(selection).catch(() => {})
      }),
    ]
    term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && isAppCombo(e)))

    return () => {
      observer.disconnect()
      clearTimeout(timer)
      subs.forEach((s) => s.dispose())
      term.attachCustomKeyEventHandler(() => true)
    }
  }, [opened, sessionId])

  // Becoming visible: refit (it was display:none) and give the terminal the keyboard.
  useEffect(() => {
    if (!visible || !opened) return
    const { term, fit } = getTerminal(sessionId)
    try {
      fit.fit()
    } catch {
      /* not laid out yet */
    }
    term.focus()
  }, [visible, opened, sessionId])

  const openSearch = () => {
    setSearching(true)
    searchInput.current?.focus()
    searchInput.current?.select()
  }

  const closeSearch = () => {
    const { term, search } = getTerminal(sessionId)
    search.clearDecorations()
    setSearching(false)
    term.focus()
  }

  const find = (backwards: boolean, incremental = false) => {
    if (!query && !incremental) return
    const { search } = getTerminal(sessionId)
    if (backwards) search.findPrevious(query)
    else search.findNext(query, { incremental })
  }

  return (
    <div className={`relative size-full ${visible ? '' : 'hidden'}`} data-testid={`terminal-${sessionId}`}>
      {visible && <SearchShortcut onFire={openSearch} />}
      <div ref={host} className="size-full overflow-hidden bg-canvas p-2" />
      <AnimatePresence>
        {searching && visible && (
          <motion.div
            role="search"
            className="absolute right-4 top-3 flex items-center gap-1 rounded-ui border border-line bg-surface-2 py-1 pl-2 pr-1 shadow-pop"
            initial={motionSafe ? { opacity: 0, y: -8, scale: 0.97 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
            exit={motionSafe ? { opacity: 0, y: -8, scale: 0.97 } : { opacity: 0 }}
            transition={motionSafe ? spring : fast}
          >
            <Search size={14} className="text-muted" aria-hidden />
            <input
              ref={searchInput}
              autoFocus
              aria-label="Search terminal"
              placeholder="Find"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (e.target.value) getTerminal(sessionId).search.findNext(e.target.value, { incremental: true })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  find(e.shiftKey)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeSearch()
                }
              }}
              className="w-44 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-muted"
            />
            <button type="button" aria-label="Previous match" onClick={() => find(true)} className="rounded p-1 text-muted hover:bg-surface hover:text-fg">
              <ChevronUp size={14} />
            </button>
            <button type="button" aria-label="Next match" onClick={() => find(false)} className="rounded p-1 text-muted hover:bg-surface hover:text-fg">
              <ChevronDown size={14} />
            </button>
            <button type="button" aria-label="Close search" onClick={closeSearch} className="rounded p-1 text-muted hover:bg-surface hover:text-fg">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
