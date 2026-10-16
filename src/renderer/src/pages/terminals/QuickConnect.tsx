import { motion } from 'framer-motion'
import { CornerDownLeft, History, Search, Server, SquareTerminal } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { HostMeta } from '../../../../shared/inventory'
import { useInventory } from '../../inventory/store'
import { openLocal, openSsh } from '../../terminal/sessions'
import { Button } from '../../ui/Button'
import { fuzzyMatch, getRecents, markRecent } from '../../ui/commands'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { formatShortcut, isMac } from '../../ui/shortcuts'

const MAX_RESULTS = 50
const recentId = (hostId: string) => `connect:${hostId}`

interface Result {
  host: HostMeta
  recent: boolean
}

/** Recently connected hosts first on an empty query; otherwise the best fuzzy match, recents breaking ties. */
function rankHosts(hosts: readonly HostMeta[], query: string): Result[] {
  const recents = getRecents()
  const rank = (h: HostMeta) => {
    const at = recents.indexOf(recentId(h.id))
    return at < 0 ? Infinity : at
  }
  const scored = hosts.flatMap((host) => {
    const match = fuzzyMatch(query, host.label) ?? fuzzyMatch(query, host.address)
    return match ? [{ host, score: match.score, recency: rank(host) }] : []
  })
  scored.sort((a, b) =>
    query.trim()
      ? b.score - a.score || a.recency - b.recency || a.host.label.localeCompare(b.host.label)
      : a.recency - b.recency || a.host.label.localeCompare(b.host.label),
  )
  return scored.slice(0, MAX_RESULTS).map((s) => ({ host: s.host, recent: s.recency !== Infinity }))
}

/** The Terminals empty state: pick a host to connect to, or open a local shell. */
export function QuickConnect({ visible }: { visible: boolean }) {
  const motionSafe = useMotionSafe()
  const inventory = useInventory()
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)

  const results = useMemo(() => rankHosts(inventory?.hosts ?? [], query), [inventory, query])
  const activeIndex = results.length ? Math.min(active, results.length - 1) : -1

  // The deck stays mounted while hidden, so autofocus happens each time it is shown.
  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])

  const run = async (open: () => Promise<string | undefined>) => {
    if (busy) return
    setBusy(true)
    // On success the deck swaps this view for the tab; on failure the store has toasted.
    if (!(await open())) setBusy(false)
  }

  const connect = (host: HostMeta) => {
    markRecent(recentId(host.id))
    void run(() => openSsh(host.id))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const n = results.length
    // The field has focus, which the window's mod+t yields to; the hint below promises it works here.
    if ((isMac() ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault()
      void run(openLocal)
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault()
      setActive((activeIndex + 1) % n)
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault()
      setActive((activeIndex - 1 + n) % n)
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      connect(results[activeIndex].host)
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`
  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  })

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Terminals</h1>
      </header>
      <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 pt-[8vh] pb-10">
        <motion.div
          className="w-full max-w-[520px]"
          initial={motionSafe ? { opacity: 0, y: 10, scale: 0.98 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
          transition={motionSafe ? spring : fast}
        >
          <div className="mb-5 flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-line bg-surface-2 text-accent">
              <SquareTerminal aria-hidden className="size-5" strokeWidth={1.8} />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-fg">Open a terminal</h2>
              <p className="text-[12.5px] text-muted">Connect to a host, or start a shell on this Mac.</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop">
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search aria-hidden className="size-4 shrink-0 text-muted" />
              <input
                ref={input}
                type="search"
                autoFocus
                aria-label="Connect to a host"
                role="searchbox"
                aria-controls={listId}
                aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                placeholder="Search hosts…"
                value={query}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onKeyDown}
                className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <ul id={listId} role="listbox" aria-label="Hosts" className="max-h-[320px] overflow-y-auto p-1.5">
              {results.map(({ host, recent }, i) => (
                <motion.li
                  key={host.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  layout={motionSafe ? 'position' : false}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={motionSafe ? spring : fast}
                  onMouseMove={() => i !== activeIndex && setActive(i)}
                  onClick={() => connect(host)}
                  className={`relative flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-[13px] ${
                    i === activeIndex ? 'text-fg' : 'text-fg/85'
                  }`}
                >
                  {i === activeIndex && (
                    <motion.span
                      layoutId={motionSafe ? 'quick-connect-active' : undefined}
                      transition={spring}
                      className="absolute inset-0 rounded-lg bg-accent/12"
                    />
                  )}
                  <Server aria-hidden className={`relative size-3.5 shrink-0 ${i === activeIndex ? 'text-accent' : 'text-muted'}`} />
                  <span className="relative truncate font-medium">{host.label}</span>
                  <span className="relative min-w-0 flex-1 truncate text-[12px] text-muted">{host.address}</span>
                  {recent && !query.trim() && <History aria-label="Recent" className="relative size-3.5 shrink-0 text-muted" />}
                  {i === activeIndex && <CornerDownLeft aria-hidden className="relative size-3.5 shrink-0 text-muted" />}
                </motion.li>
              ))}
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-[12.5px] text-muted">
                  {!inventory ? 'Loading hosts…' : inventory.hosts.length ? `No hosts match “${query}”` : 'No hosts yet. Add one on the Hosts page.'}
                </li>
              )}
            </ul>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" icon={<SquareTerminal aria-hidden className="size-3.5" />} disabled={busy} onClick={() => void run(openLocal)}>
              New local shell
            </Button>
            <p className="text-[11.5px] text-muted">
              {`${formatShortcut('mod+t').join('')} local shell · ${formatShortcut('mod+k').join('')} connect to any host`}
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
