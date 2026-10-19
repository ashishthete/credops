const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "3 days ago"; anything under a minute is "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const sec = Math.round((Date.parse(iso) - now) / 1000)
  if (Number.isNaN(sec)) return iso
  const abs = Math.abs(sec)
  const unit = UNITS.find(([, s]) => abs >= s)
  if (!unit) return 'just now'
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.trunc(sec / unit[1]), unit[0])
}
