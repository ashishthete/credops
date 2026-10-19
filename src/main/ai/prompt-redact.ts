import { isIP } from 'node:net'
import { userInfo } from 'node:os'
import type { RedactionKind } from '../../shared/ai'
import { REDACTED, SENSITIVE_KEY, maskKnownSecrets } from '../security/redact'

/** What one redaction pass knows about the user's world. Live values: build it per call with `promptContext`. */
export interface PromptRedactionContext {
  knownSecrets: readonly string[]
  usernames: readonly string[]
  hostAddresses: readonly string[]
  /** Treat the whole input as an env file or compose environment block: every value goes. */
  envBlocks?: boolean
}

export type RedactionCounts = Partial<Record<RedactionKind, number>>

const USER = '‹user›'
const EMAIL_PH = '‹email›'

// --- Patterns. Each has a unit case in tests/main/prompt-redact.test.ts. ---
/** Any PEM block: private keys and certificates. An unterminated block goes through the end of the input. */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g
/** A placeholder shape someone else wrote: escaped so it cannot alias one this pass mints. */
const RAW_NUMBERED = /‹(ip|host|raw)-(\d{1,6})›/g
const MARKER = /‹raw-(\d{1,6})›/g
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:‹›]*:[^\s/@‹›]*@/gi
const QUERY_PARAM = /([?&])([^=&#\s‹›]{1,100})=([^&#\s]*)/g
const SIGNATURE_PARAM = /^(sig|signature|code)$/i
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+(?!‹)[A-Za-z0-9._~+/=-]{4,}/gi
const TOKENS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, // Anthropic / OpenAI style
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g, // long hex runs
]
/** A 32+ char base64 run; only mixed-case-with-a-digit runs that are not paths count, so file paths and words survive. */
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g
const USER_AT_HOST = /(?<![A-Za-z0-9._%+-])[A-Za-z_][A-Za-z0-9_.-]{0,31}@(?=\[|‹(?:ip|host)-|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z])/g
const HOME_PATH = /(\/(?:Users|home)\/)(?!‹)([^/\s'"‹›:]+)/g
const IPV4 = /(?<![\w.‹])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w‹]|\.\d)/g
const IPV6_CANDIDATE = /(?<![\w:.‹])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:‹])/g
const COMPOSE_ENV_START = /^(\s*)environment:\s*$/
const ENV_ASSIGN = /(^|[\s,;(])(-\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,100})=("[^"]*"|'[^']*'|[^\s,;)]*)/g
const YAML_PAIR = /^(\s*-?\s*)("?)([A-Za-z_][A-Za-z0-9_.-]{0,100})\2:([ \t]+)(\S.*)$/
const JSON_PAIR = /"([A-Za-z_][A-Za-z0-9_.-]{0,100})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g
const ONE_PLACEHOLDER = /^(?:"|')?‹[a-z]+(?:-\d+)?›(?:"|')?$/

/** A char that makes a neighbouring match part of a larger word; placeholders' brackets count, so they are never re-matched. */
const WORDISH = /[\p{L}\p{N}_‹›]/u
const isLoopbackV4 = (ip: string): boolean => ip.startsWith('127.') || ip === '0.0.0.0'

/** One pass's state: the placeholder maps (shared across parts) and the counts. */
class Pass {
  readonly counts: RedactionCounts = {}
  private readonly ips = new Map<string, string>()
  private readonly hosts = new Map<string, string>()
  readonly raws: string[] = []
  minted = false

  constructor(private readonly ctx: PromptRedactionContext) {}

  private count(kind: RedactionKind, n = 1): void {
    if (n > 0) this.counts[kind] = (this.counts[kind] ?? 0) + n
  }

  private placeholder(map: Map<string, string>, kind: 'ip' | 'host', key: string): string {
    let ph = map.get(key)
    if (!ph) {
      ph = `‹${kind}-${map.size + 1}›`
      map.set(key, ph)
    }
    this.minted = true
    return ph
  }

  private sub(text: string, re: RegExp, kind: RedactionKind, fn: (...m: string[]) => string): string {
    return text.replace(re, (...m: unknown[]) => {
      const out = fn(...(m.filter((x) => typeof x === 'string' || x === undefined) as string[]))
      if (out !== m[0]) this.count(kind)
      return out
    })
  }

  run(input: string): string {
    // 0. Raw placeholders become markers until the end, so no stage can match or alias them.
    let t = input.replace(RAW_NUMBERED, (m) => `‹raw-${this.raws.push(m) - 1}›`)
    // 1. PEM blocks.
    t = this.sub(t, PEM_BLOCK, 'key', () => REDACTED)
    // 2. Known secrets.
    const known = maskKnownSecrets(t, this.ctx.knownSecrets)
    this.count('secret', known.count)
    t = known.text
    // 3. URL credentials and query params.
    t = this.sub(t, URL_CREDENTIALS, 'url', (_m, scheme) => `${scheme}${REDACTED}@`)
    t = this.sub(t, QUERY_PARAM, 'url', (m, sep, name, value) =>
      (SENSITIVE_KEY.test(name!) || SIGNATURE_PARAM.test(name!)) && value !== '' && value !== REDACTED ? `${sep}${name}=${REDACTED}` : m!,
    )
    // 4. Auth headers and tokens.
    t = this.sub(t, AUTH_SCHEME, 'token', (_m, scheme) => `${scheme} ${REDACTED}`)
    for (const re of TOKENS) t = this.sub(t, re, 'token', () => REDACTED)
    t = this.sub(t, BASE64_RUN, 'token', (m) => (looksLikeKeyMaterial(m!) ? REDACTED : m!))
    // 5. Env assignments.
    t = this.envAssignments(t)
    // 6. Emails.
    t = this.sub(t, EMAIL, 'email', () => EMAIL_PH)
    // 7. user@host.
    t = this.sub(t, USER_AT_HOST, 'user', () => `${USER}@`)
    // 8. Inventory host addresses, longest first so `db.example` does not split `db.example.com`.
    const addresses = [...new Set(this.ctx.hostAddresses.map((a) => a.trim()).filter((a) => a.length >= 2))].sort((a, b) => b.length - a.length)
    for (const a of addresses) t = this.replaceWord(t, a, 'host', true, () => this.placeholder(this.hosts, 'host', a.toLowerCase()))
    // 9. IP literals; loopback, 0.0.0.0 and :: stay.
    t = this.sub(t, IPV6_CANDIDATE, 'ip', (m) => {
      const ip = m!
      if (isIP(ip) !== 6 || ip === '::' || ip === '::1') return ip
      return this.placeholder(this.ips, 'ip', ip.toLowerCase())
    })
    t = this.sub(t, IPV4, 'ip', (m) => (isLoopbackV4(m!) ? m! : this.placeholder(this.ips, 'ip', m!)))
    // 10. Usernames in home paths, then known usernames as whole words.
    t = this.sub(t, HOME_PATH, 'user', (_m, prefix) => `${prefix}${USER}`)
    const names = [...new Set(this.ctx.usernames.filter((u) => u.length >= 2))].sort((a, b) => b.length - a.length)
    for (const u of names) t = this.replaceWord(t, u, 'user', false, () => USER)
    return t
  }

  /** Replaces whole-word occurrences of a literal; host addresses may be followed by `:port` or `.` at a sentence end. */
  private replaceWord(t: string, word: string, kind: RedactionKind, caseless: boolean, to: () => string): string {
    const hay = caseless ? t.toLowerCase() : t
    const needle = caseless ? word.toLowerCase() : word
    let out = ''
    let from = 0
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      if (at < from) continue
      const before = t[at - 1]
      const after = t[at + needle.length]
      const afterNext = t[at + needle.length + 1]
      if (before !== undefined && (WORDISH.test(before) || before === '.' || before === '-')) continue
      if (after !== undefined && (WORDISH.test(after) || after === '-' || (after === '.' && afterNext !== undefined && WORDISH.test(afterNext)))) continue
      out += t.slice(from, at) + to()
      from = at + needle.length
      this.count(kind)
    }
    return from === 0 ? t : out + t.slice(from)
  }

  /** `NAME=value`, `NAME: value` and `"name": "value"`; every value inside an env file or compose `environment:` block. */
  private envAssignments(t: string): string {
    const lines = t.split('\n')
    let blockIndent: number | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const indent = line.length - line.trimStart().length
      if (blockIndent !== null && line.trim() !== '' && indent <= blockIndent) blockIndent = null
      const start = COMPOSE_ENV_START.exec(line)
      if (start) {
        blockIndent = start[1]!.length
        continue
      }
      const all = this.ctx.envBlocks === true || blockIndent !== null
      const take = (name: string, value: string): boolean => value !== '' && !ONE_PLACEHOLDER.test(value) && (all || SENSITIVE_KEY.test(name))
      let next = line.replace(ENV_ASSIGN, (m, lead: string, dash: string | undefined, name: string, value: string) => {
        if (!take(name, value)) return m
        this.count('env')
        return `${lead}${dash ?? ''}${name}=${REDACTED}`
      })
      const pair = next === line ? YAML_PAIR.exec(line) : null
      if (pair && take(pair[3]!, pair[5]!)) {
        this.count('env')
        next = `${pair[1]}${pair[2]}${pair[3]}${pair[2]}:${pair[4]}${REDACTED}`
      }
      next = next.replace(JSON_PAIR, (m, name: string, colon: string, value: string) => {
        if (!take(name, value)) return m
        this.count('env')
        return `"${name}"${colon}"${REDACTED}"`
      })
      lines[i] = next
    }
    return lines.join('\n')
  }

  /** Puts raw placeholders back: escaped when this pass minted numbered ones (so they cannot alias), as written otherwise. */
  finish(t: string): string {
    return t.replace(MARKER, (_m, i: string) => {
      const raw = this.raws[Number(i)]!
      return this.minted ? raw.replace('‹', '<').replace('›', '>') : raw
    })
  }
}

function looksLikeKeyMaterial(run: string): boolean {
  const body = run.replace(/=+$/, '')
  if ((body.match(/\//g) ?? []).length > 2) return false
  return /[0-9]/.test(body) && /[a-z]/.test(body) && /[A-Z]/.test(body)
}

/** Redacts one string for Claude. Fixed stage order; placeholders are stable within the call and never re-matched. */
export function redactPrompt(text: string, ctx: PromptRedactionContext): { text: string; counts: RedactionCounts } {
  const pass = new Pass(ctx)
  const out = pass.finish(pass.run(text))
  return { text: out, counts: pass.counts }
}

/** Redacts several strings with one placeholder map, so `‹ip-1›` names the same address in every part. */
export function redactPromptParts<K extends string>(
  parts: Record<K, string>,
  ctx: PromptRedactionContext,
): { parts: Record<K, string>; counts: RedactionCounts } {
  const pass = new Pass(ctx)
  const mid = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, pass.run(v as string)])) as Record<K, string>
  const out = Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, pass.finish(v as string)])) as Record<K, string>
  return { parts: out, counts: pass.counts }
}

export function totalRedactions(counts: RedactionCounts): number {
  return Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0)
}

export interface PromptContextDeps {
  /** Every decrypted vault value; read on each call. */
  knownSecrets: () => readonly string[]
  identities: { list(): { username: string }[] }
  hosts: { list(): { address: string }[] }
  osUser?: () => string
}

/** The live redaction context: vault values, the OS user, identity usernames and host addresses, read now. */
export function promptContext(deps: PromptContextDeps): PromptRedactionContext {
  const osUser = (deps.osUser ?? (() => userInfo().username))()
  return {
    knownSecrets: [...deps.knownSecrets()],
    usernames: [...new Set([osUser, ...deps.identities.list().map((i) => i.username)].filter((u) => u.length > 0))],
    hostAddresses: [...new Set(deps.hosts.list().map((h) => h.address))],
  }
}
