/** Trimmed, non-empty text within `max`; the message names the field and never carries the value. */
export function checkText(raw: string, what: string, max: number): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length === 0 || s.length > max) throw new Error(`${what} must be 1-${max} characters`)
  return s
}

/** A `#rrggbb` color, lowercased. */
export function checkHexColor(raw: string, what: string, pattern: RegExp): string {
  if (typeof raw !== 'string' || !pattern.test(raw)) throw new Error(`${what} color must be #rrggbb`)
  return raw.toLowerCase()
}
