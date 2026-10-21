import type { CommitInfo } from './deploy'

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/
const SECTIONS = ['Features', 'Enhancements', 'Fixes', 'Hotfixes'] as const
type Section = (typeof SECTIONS)[number]
const TYPE_SECTION: Record<string, Section | null> = {
  feat: 'Features',
  perf: 'Enhancements',
  refactor: 'Enhancements',
  enh: 'Enhancements',
  fix: 'Fixes',
  hotfix: 'Hotfixes',
  chore: null,
  ci: null,
  build: null,
  docs: null,
  test: null,
}

/** The deterministic commit-list notes: grouped by conventional prefix, chores and merges dropped. */
export function fallbackNotes(commits: Pick<CommitInfo, 'subject'>[]): string {
  const out: Record<Section, string[]> = { Features: [], Enhancements: [], Fixes: [], Hotfixes: [] }
  const seen = new Set<string>()
  for (const c of commits) {
    const subject = c.subject.replace(/\s+/g, ' ').trim()
    if (subject === '' || /^Merge\b/i.test(subject)) continue
    const m = CONVENTIONAL.exec(subject)
    const type = m?.[1]?.toLowerCase()
    const section = type !== undefined && type in TYPE_SECTION ? TYPE_SECTION[type]! : 'Enhancements'
    if (section === null) continue
    const text = m && type !== undefined && type in TYPE_SECTION ? m[2]! : subject
    const line = text.charAt(0).toUpperCase() + text.slice(1)
    const key = `${section}\0${line.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out[section].push(line)
  }
  return SECTIONS.filter((s) => out[s].length > 0)
    .map((s) => [`## ${s}`, ...out[s].map((l) => `- ${l}`)].join('\n'))
    .join('\n\n')
}
