export const REDACTED = '‹redacted›'

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|webhook/i
// An unterminated block is redacted through the end of the string.
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const MIN_SECRET_LENGTH = 4

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function buildSecretMatcher(knownSecrets: readonly string[]): RegExp | null {
  const usable = [...new Set(knownSecrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  return usable.length ? new RegExp(usable.map(escapeRegExp).join('|'), 'g') : null
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
  const matcher = buildSecretMatcher(knownSecrets)
  const ancestors = new Set<object>()

  const maskString = (s: string): string => {
    const noPem = s.replace(PEM_BLOCK, REDACTED)
    return matcher ? noPem.replace(matcher, REDACTED) : noPem
  }

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskString(v)
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
