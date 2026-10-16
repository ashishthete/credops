// Command registry, fuzzy matcher and palette open-state: small module-level stores read
// through useSyncExternalStore.

export interface Command {
  id: string
  title: string
  section: string
  keywords?: string[]
  shortcut?: string
  run: () => void
}

type Listener = () => void

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const commandStore = createStore<readonly Command[]>([])
export const paletteOpenStore = createStore(false)

/** Adds a command to the palette. Returns a function that removes it again. */
export function registerCommand(cmd: Command): () => void {
  commandStore.set([...commandStore.get().filter((c) => c.id !== cmd.id), cmd])
  return () => {
    // Only remove our own registration, not a later one that reused the id.
    if (commandStore.get().includes(cmd)) commandStore.set(commandStore.get().filter((c) => c !== cmd))
  }
}

// Focus is captured on open and handed back on close, so ⌘K never strands the caret.
let returnFocus: Element | null = null

function setPaletteOpen(open: boolean) {
  if (open === paletteOpenStore.get()) return
  if (open) {
    returnFocus = document.activeElement
  } else {
    const el = returnFocus
    returnFocus = null
    if (el instanceof HTMLElement && el.isConnected) el.focus()
  }
  paletteOpenStore.set(open)
}

export const openCommandPalette = () => setPaletteOpen(true)
export const closeCommandPalette = () => setPaletteOpen(false)
export const toggleCommandPalette = () => setPaletteOpen(!paletteOpenStore.get())

// Recents: newest first, kept in memory and mirrored to localStorage when available.
const RECENTS_KEY = 'opsdeck.palette.recents'
const MAX_RECENTS = 5

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

let recents = loadRecents()

export function getRecents(): readonly string[] {
  return recents
}

export function markRecent(id: string): void {
  // Drop ids that are no longer registered so they don't hold recent slots.
  const registered = new Set(commandStore.get().map((c) => c.id))
  recents = [id, ...recents.filter((r) => r !== id && registered.has(r))].slice(0, MAX_RECENTS)
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
  } catch {
    // Storage unavailable; in-memory recents still work for this session.
  }
}

export interface FuzzyMatch {
  score: number
  /** Indices in the text that matched, for highlighting. */
  indices: number[]
}

/** Subsequence match: every query char must appear in order. Rewards runs and word starts. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  const indices: number[] = []
  let score = 0
  let prev = -2
  for (let i = 0, qi = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue
    const wordStart = i === 0 || /[\s\-_/.:]/.test(t[i - 1])
    score += 1
    if (i === prev + 1) score += 5
    if (wordStart) score += 8
    if (i === 0) score += 4
    indices.push(i)
    prev = i
    qi++
  }
  if (indices.length < q.length) return null
  // Prefer tighter, earlier matches and shorter titles.
  score -= (indices[indices.length - 1] - indices[0]) * 0.5 + indices[0] * 0.2 + t.length * 0.05
  return { score, indices }
}

export interface RankedCommand {
  command: Command
  indices: number[]
  /** Section to display under: "Recent" for recents on an empty query. */
  group: string
}

export function rankCommands(
  commands: readonly Command[],
  query: string,
  recentIds: readonly string[],
): RankedCommand[] {
  const recency = (id: string) => {
    const i = recentIds.indexOf(id)
    return i === -1 ? 0 : MAX_RECENTS - i
  }

  if (!query.trim()) {
    const recent = recentIds
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is Command => c !== undefined)
      .map((command) => ({ command, indices: [], group: 'Recent' }))
    const rest = commands
      .filter((c) => !recentIds.includes(c.id))
      .map((command) => ({ command, indices: [], group: command.section }))
    return [...recent, ...groupBySection(rest)]
  }

  const scored: Array<RankedCommand & { score: number }> = []
  for (const command of commands) {
    const title = fuzzyMatch(query, command.title)
    const keyword = Math.max(
      ...(command.keywords ?? []).map((k) => fuzzyMatch(query, k)?.score ?? -Infinity),
      -Infinity,
    )
    if (!title && keyword === -Infinity) continue
    const score = Math.max(title?.score ?? -Infinity, keyword - 3) + recency(command.id) * 2
    scored.push({ command, indices: title?.indices ?? [], group: command.section, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return groupBySection(scored)
}

// Keeps sections contiguous, ordered by their best-ranked member.
function groupBySection<T extends { group: string }>(items: T[]): T[] {
  const order: string[] = []
  const bySection = new Map<string, T[]>()
  for (const item of items) {
    if (!bySection.has(item.group)) {
      order.push(item.group)
      bySection.set(item.group, [])
    }
    bySection.get(item.group)!.push(item)
  }
  return order.flatMap((s) => bySection.get(s)!)
}
