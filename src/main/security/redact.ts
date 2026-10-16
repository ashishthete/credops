export const REDACTED = '‹redacted›'

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|webhook/i
// An unterminated block is redacted through the end of the string.
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const MIN_SECRET_LENGTH = 4
// Shorter secrets (a PIN, a short word) also occur inside unrelated numbers and words, so they
// are masked only as whole tokens.
const MIN_ANYWHERE_LENGTH = 8
const WORD_CHAR = /[\p{L}\p{N}]/u

const isBoundary = (s: string, at: number): boolean => at < 0 || at >= s.length || !WORD_CHAR.test(s[at]!)

/** Replaces each occurrence of `secret` in `s`; short ones only with a non-alphanumeric char or the edge on both sides. */
function maskOne(s: string, secret: string): string {
  const anywhere = secret.length >= MIN_ANYWHERE_LENGTH
  let out = ''
  let from = 0
  for (let at = s.indexOf(secret); at !== -1; at = s.indexOf(secret, at + 1)) {
    if (at < from) continue
    if (!anywhere && !(isBoundary(s, at - 1) && isBoundary(s, at + secret.length))) continue
    out += s.slice(from, at) + REDACTED
    from = at + secret.length
  }
  return from === 0 ? s : out + s.slice(from)
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
