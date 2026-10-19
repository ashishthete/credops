/**
 * The `OD-*` lines the generated shell prints (generate.ts) and events.ts reads. This is the one list of
 * marker names; a test sweeps every generated command so a new echo cannot drift from it.
 */
export const MARK = {
  PREV: 'OD-PREV',
  HEAD: 'OD-HEAD',
  LOCK: 'OD-LOCK',
  LOCK_ERROR: 'OD-LOCK-ERROR',
  UNLOCK: 'OD-UNLOCK',
  BACKUP: 'OD-BACKUP',
  HEALTH: 'OD-HEALTH',
  ENV: 'OD-ENV',
  TAG: 'OD-TAG',
  PF: 'OD-PF',
} as const
export type MarkName = (typeof MARK)[keyof typeof MARK]

const BY_NAME = new Set<string>(Object.values(MARK))
/** Lock holder rc: another release holds a repo. */
export const RC_LOCK_BUSY = 42
/** Break-lock rc: at least one lock changed since preflight and was kept. */
export const RC_BREAK_KEPT = 43

/** `OD-NAME rest`, or null when the line is not a marker. `rest` is everything after the first space. */
export function parseMarker(line: string): { mark: MarkName; rest: string } | null {
  const m = /^(OD-[A-Z]+(?:-[A-Z]+)*)(?: (.*))?$/s.exec(line)
  if (!m || !BY_NAME.has(m[1])) return null
  return { mark: m[1] as MarkName, rest: m[2] ?? '' }
}

/** `OD-PF <check> k=v k=v`: values hold no spaces (free text is base64). A bare token becomes `tok: ''`. */
export function parsePfLine(rest: string): { check: string; fields: Record<string, string> } | null {
  const parts = rest.split(' ').filter(Boolean)
  const check = parts.shift()
  if (!check) return null
  const fields: Record<string, string> = {}
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq < 0) fields[p] = ''
    else fields[p.slice(0, eq)] = p.slice(eq + 1)
  }
  return { check, fields }
}

export type PrevValue = { kind: 'sha'; sha: string } | { kind: 'none' } | { kind: 'unknown' }

/** `unknown` (origin unreachable) is never a first deploy and never a commit. */
export function parsePrev(rest: string): PrevValue | null {
  const v = rest.trim()
  if (v === 'none') return { kind: 'none' }
  if (v === 'unknown') return { kind: 'unknown' }
  return /^[0-9a-f]{40}$/.test(v) ? { kind: 'sha', sha: v } : null
}

const STREAM = /^([A-Za-z0-9_-]{1,64}):([a-z_]{1,32})\t([\s\S]*)$/

/** A line the streamed steps write to stream.log (and print the tail of on failure): `<runId>:<kind>\t<text>`. */
export function parseStreamLine(line: string): { runId: string; kind: string; text: string } | null {
  const m = STREAM.exec(line)
  return m ? { runId: m[1], kind: m[2], text: m[3] } : null
}
