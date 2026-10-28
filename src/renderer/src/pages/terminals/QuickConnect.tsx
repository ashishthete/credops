import { Star } from 'lucide-react'
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useInventory } from '../../inventory/store'
import { useConnect } from '../../terminal/connect'
import { toggleFavourite, useFavourites } from '../../terminal/favourites'
import { Button } from '../../ui/Button'
import { fuzzyMatch } from '../../ui/commands'
import { Dialog } from '../../ui/Dialog'
import { formatShortcut, isMac } from '../../ui/shortcuts'
import { createStore } from '../../ui/store'

const openStore = createStore(false)
export const openQuickConnect = () => openStore.set(true)
export const closeQuickConnect = () => openStore.set(false)

export interface QuickHost {
  id: string
  label: string
  /** Address, tags, environment and region names: matched too, a little below the label. */
  keywords: string[]
}

/** As much as a favourite gains on a query; the palette uses the same nudge. */
const FAVOURITE_BOOST = 8

/**
 * Hosts for a fuzzy query on the label (or a keyword), best first, favourites ahead of near ties. With no
 * query: favourites, then the rest, each by label.
 */
export function rankHosts<T extends QuickHost>(hosts: readonly T[], query: string, favourites: readonly string[]): { host: T; indices: number[] }[] {
  const starred = new Set(favourites)
  if (!query.trim()) {
    const byLabel = (a: T, b: T) => a.label.localeCompare(b.label)
    return [...hosts.filter((h) => starred.has(h.id)).sort(byLabel), ...hosts.filter((h) => !starred.has(h.id)).sort(byLabel)].map((host) => ({
      host,
      indices: [],
    }))
  }
  const scored: { host: T; indices: number[]; score: number }[] = []
  for (const host of hosts) {
    const label = fuzzyMatch(query, host.label)
    const keyword = Math.max(...host.keywords.map((k) => fuzzyMatch(query, k)?.score ?? -Infinity), -Infinity)
    if (!label && keyword === -Infinity) continue
    const score = Math.max(label?.score ?? -Infinity, keyword - 3) + (starred.has(host.id) ? FAVOURITE_BOOST : 0)
    scored.push({ host, indices: label?.indices ?? [], score })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/**
 * Opens a session to an inventory host by typing part of its name; ⌘D (Ctrl+D) or the star marks a
 * favourite, listed first here and in the palette. Only inventory hosts: an address that isn't one is
 * added on the Hosts page first.
 */
export function QuickConnect() {
  const open = useSyncExternalStore(openStore.subscribe, openStore.get)
  return (
    <Dialog open={open} onClose={closeQuickConnect} title="Quick connect" description="Open a session to a host from your inventory." width={560}>
      {open && <QuickConnectBody />}
    </Dialog>
  )
}

function QuickConnectBody() {
  const data = useInventory()
  const favourites = useFavourites()
  const { connect } = useConnect()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listboxId = useId()
  const optionId = (i: number) => `${listboxId}-opt-${i}`

  const hosts = useMemo(() => {
    if (!data) return []
    const envById = new Map(data.environments.map((e) => [e.id, e]))
    const regionById = new Map(data.regions.map((r) => [r.id, r]))
    return data.hosts.map((h) => {
      const envs = h.environments.flatMap((m) => envById.get(m.environmentId) ?? [])
      const region = regionById.get(h.regionId)
      return {
        id: h.id,
        label: h.label,
        address: h.address,
        envs,
        region: region?.code,
        keywords: [h.address, ...h.tags, ...envs.map((e) => e.name), ...(region ? [region.code, region.displayName] : [])],
      }
    })
  }, [data])
  const results = useMemo(() => rankHosts(hosts, query, favourites), [hosts, query, favourites])
  const activeIndex = results.length ? Math.min(active, results.length - 1) : -1
  const starred = new Set(favourites)

  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  })

  const go = (h: (typeof hosts)[number]) => {
    closeQuickConnect()
    // A host in exactly one environment connects with its defaults, as the palette's Connect to does.
    void connect(h.id, h.envs.length === 1 ? h.envs[0].id : undefined)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const n = results.length
    const mod = isMac() ? e.metaKey : e.ctrlKey
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault()
      setActive((activeIndex + 1) % n)
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault()
      setActive((activeIndex - 1 + n) % n)
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      go(results[activeIndex].host)
    } else if (mod && e.key.toLowerCase() === 'd' && activeIndex >= 0) {
      e.preventDefault()
      toggleFavourite(results[activeIndex].host.id)
    }
  }

  return (
    <>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label="Host"
        placeholder="Host name, address, tag or environment"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        className="mb-2 h-9 w-full rounded-lg border border-line bg-canvas/60 px-3 text-[13px] text-fg placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
      />
      <div className="max-h-[45vh] overflow-y-auto">
        <div id={listboxId} role="listbox" aria-label="Hosts">
          {results.map(({ host: h, indices }, i) => {
            const fav = starred.has(h.id)
            return (
              <div
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseMove={i === activeIndex ? undefined : () => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h)}
                className={`flex h-10 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] select-none ${
                  i === activeIndex ? 'bg-accent/12 text-fg shadow-[inset_2px_0_0_0_var(--accent)]' : 'text-fg/80'
                }`}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={fav ? `Unstar ${h.label}` : `Star ${h.label}`}
                  aria-pressed={fav}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFavourite(h.id)
                  }}
                  className={`grid size-6 shrink-0 place-items-center rounded-md hover:bg-surface-2 ${fav ? 'text-warn' : 'text-muted/60 hover:text-muted'}`}
                >
                  <Star aria-hidden className="size-3.5" fill={fav ? 'currentColor' : 'none'} />
                </button>
                <span className="min-w-0 truncate font-medium">
                  <Highlighted text={h.label} indices={indices} />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{h.address}</span>
                <span className="shrink-0 text-[11.5px] text-muted">{[...h.envs.map((e) => e.name), h.region].filter(Boolean).join(' · ')}</span>
              </div>
            )
          })}
        </div>
        {results.length === 0 && (
          <p className="py-8 text-center text-[12.5px] text-muted">
            {!data ? 'Loading…' : hosts.length === 0 ? 'No hosts yet. Add one on the Hosts page.' : 'No host matches. Quick connect only opens hosts in your inventory.'}
          </p>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11.5px] text-muted">
        <span>
          ↵ connects · {formatShortcut('mod+d').join('')} stars the highlighted host
        </span>
        <Button variant="ghost" size="sm" onClick={closeQuickConnect}>
          Cancel
        </Button>
      </div>
    </>
  )
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>
  const hit = new Set(indices)
  return (
    <>
      {text.split('').map((ch, i) =>
        hit.has(i) ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  )
}
