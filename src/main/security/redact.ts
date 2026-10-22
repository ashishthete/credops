export const REDACTED = '‹redacted›'

export const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|webhook/i
// An unterminated block is redacted through the end of the string.
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const MIN_SECRET_LENGTH = 4

/** Replaces every occurrence of `secret` in `s`, even fused to other characters (a PIN inside "pin123456x"). */
function maskOne(s: string, secret: string, counter?: { n: number }): string {
  let out = ''
  let from = 0
  for (let at = s.indexOf(secret); at !== -1; at = s.indexOf(secret, at + 1)) {
    if (at < from) continue
    out += s.slice(from, at) + REDACTED
    from = at + secret.length
    if (counter) counter.n++
  }
  return from === 0 ? s : out + s.slice(from)
}

/** Masks `knownSecrets` in `s` with the same rules as `redact`, and says how many occurrences it masked. */
export function maskKnownSecrets(s: string, knownSecrets: readonly string[]): { text: string; count: number } {
  const counter = { n: 0 }
  const usable = [...new Set(knownSecrets)].filter((x) => x.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)
  const text = usable.reduce((acc, secret) => (acc.includes(secret) ? maskOne(acc, secret, counter) : acc), s)
  return { text, count: counter.n }
}

/**
 * Longest first, so a secret that contains another is masked whole. A plain indexOf scan, not
 * one alternation regex: V8 rejects a large pattern ("Regular expression too large", for
 * example one 64 KiB secret) with a message that quotes every secret in it.
 */
function buildSecretMasker(knownSecrets: readonly string[]): ((s: string) => string) | null {
  const usable = [...new Set(knownSecrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  if (!usable.length) return null
  return (s) => usable.reduce((acc, secret) => (acc.includes(secret) ? maskOne(acc, secret) : acc), s)
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-copies `value` with secrets masked: values under sensitive keys, PEM
 * private-key blocks, and any occurrence of `knownSecrets` inside strings.
 * Non-plain objects are stringified (Date as ISO, any ArrayBuffer view as
 * `[buffer N bytes]` so raw bytes, which may be key material, never leak).
 */
export function redact<T>(value: T, knownSecrets: readonly string[] = []): T {
  const maskSecrets = buildSecretMasker(knownSecrets)
  const ancestors = new Set<object>()

  const maskString = (s: string): string => {
    const noPem = s.replace(PEM_BLOCK, REDACTED)
    return maskSecrets ? maskSecrets(noPem) : noPem
  }

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskString(v)
    if (typeof v === 'bigint') return v.toString()
    if (v === null || typeof v !== 'object') {
      return typeof v === 'function' || typeof v === 'symbol' ? maskString(String(v)) : v
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '[invalid date]' : v.toISOString()
    if (ArrayBuffer.isView(v)) return `[buffer ${v.byteLength} bytes]`
    if (ancestors.has(v)) return '[circular]'

    if (!Array.isArray(v) && !isPlainObject(v)) return maskString(String(v))

    ancestors.add(v)
    try {
      if (Array.isArray(v)) return v.map(walk)
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(v)) {
        out[maskString(key)] = SENSITIVE_KEY.test(key) ? REDACTED : walk(child)
      }
      return out
    } finally {
      ancestors.delete(v)
    }
  }

  return walk(value) as T
}
