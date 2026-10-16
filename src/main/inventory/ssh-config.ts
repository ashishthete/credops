import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { MAX_IMPORT_ALIASES, MAX_SSH_CONFIG_BYTES, type SshConfigEntry, type SshForward } from '../../shared/inventory'

export interface IncludeFile {
  path: string
  /** Canonical path, used for loop detection when the reader has one. */
  realPath?: string
  text: string
}
export interface IncludeResult {
  files: IncludeFile[]
  warnings: string[]
}
export interface ParseOptions {
  /** Expands `~` and `%d`. */
  home: string
  /** Relative Include paths resolve here; IdentityFile must stay inside. */
  sshDir: string
  /** Supplied by main as a sshDir-confined reader (see readSshIncludes). */
  include?: (pattern: string) => IncludeResult
  /** Real path of the top-level file; seeds loop detection. */
  rootPath?: string
}

const MAX_INCLUDE_DEPTH = 4
const MAX_INCLUDE_MATCHES = 100
const MAX_INCLUDE_FILES = 256
const MAX_INCLUDE_TOTAL_BYTES = 4 * MAX_SSH_CONFIG_BYTES
const MAX_HOST_PATTERNS = 10000
const MAX_WILDCARD_BLOCKS = 200
const TOO_LARGE = 'ssh config is larger than 1 MiB'

interface Directive {
  key: string
  args: string[]
  line: number
}
interface Block {
  /** null = lines before any Host, which match everything. */
  patterns: string[] | null
  directives: Directive[]
}

function tooLarge(text: string): boolean {
  return text.length > MAX_SSH_CONFIG_BYTES || Buffer.byteLength(text) > MAX_SSH_CONFIG_BYTES
}

function splitArgs(rest: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"?|(\S+)/g
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    if (m[1] === undefined && m[2].startsWith('#')) break
    args.push(m[1] ?? m[2])
  }
  return args
}

/** Iterative `*`/`?` matcher: backtracks only to the last `*`, so O(n*m) worst case. */
export function globMatch(pattern: string, text: string): boolean {
  // Cheap rejects: the tail after the last `*` must fit and agree with the end of text.
  const lastStar = pattern.lastIndexOf('*')
  const tail = pattern.length - lastStar - 1
  if (lastStar >= 0 ? text.length < pattern.length - 1 : text.length !== pattern.length) return false
  for (let i = 1; i <= tail; i++) {
    const c = pattern[pattern.length - i]
    if (c !== '?' && c !== text[text.length - i]) return false
  }
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t]) && pattern[p] !== '*') {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else return false
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

function matchesPatterns(patterns: string[], alias: string): boolean {
  let positive = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), alias)) return false
    } else if (globMatch(p, alias)) positive = true
  }
  return positive
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return home + value.slice(1)
  return value.replace(/%d/g, home)
}

export function parseSshConfig(text: string, opts: ParseOptions): { entries: SshConfigEntry[]; warnings: string[] } {
  const warnings: string[] = []
  if (tooLarge(text)) return { entries: [], warnings: [TOO_LARGE] }

  const blocks: Block[] = [{ patterns: null, directives: [] }]
  const visited = new Set<string>(opts.rootPath ? [resolve(opts.rootPath)] : [])
  let inMatch = false
  let skipBlock = false
  let wildcardBlocks = 0
  let storedPatterns = 0
  let patternsWarned = false
  let includeFiles = 0
  let includeBytes = 0
  let budgetWarned = false
  const aliases = new Set<string>()
  let aliasCapWarned = false

  const walk = (src: string, depth: number): void => {
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1
      const line = lines[i].trim()
      if (!line || line.startsWith('#')) continue
      const m = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)?(.*)$/.exec(line)
      if (!m) continue
      const key = m[1].toLowerCase()
      const args = splitArgs(m[2])
      if (key === 'host') {
        inMatch = false
        if (args.some((pat) => !isConcrete(pat)) && ++wildcardBlocks > MAX_WILDCARD_BLOCKS) {
          if (wildcardBlocks === MAX_WILDCARD_BLOCKS + 1) {
            warnings.push(`More than ${MAX_WILDCARD_BLOCKS} wildcard Host blocks, the rest are ignored`)
          }
          skipBlock = true
          continue
        }
        const kept: string[] = []
        for (const pat of args) {
          if (!isConcrete(pat)) kept.push(pat)
          else if (aliases.has(pat)) kept.push(pat)
          else if (aliases.size < MAX_IMPORT_ALIASES) {
            aliases.add(pat)
            kept.push(pat)
          } else if (!aliasCapWarned) {
            aliasCapWarned = true
            warnings.push(`More than ${MAX_IMPORT_ALIASES} hosts, the rest are not imported`)
          }
        }
        if (storedPatterns + kept.length > MAX_HOST_PATTERNS) {
          if (!patternsWarned) warnings.push('Too many Host patterns, the rest are ignored')
          patternsWarned = true
          skipBlock = true
        } else {
          storedPatterns += kept.length
          skipBlock = false
          blocks.push({ patterns: kept, directives: [] })
        }
      } else if (key === 'match') {
        inMatch = true
        warnings.push(`Match blocks are not imported (line ${lineNo})`)
      } else if (inMatch || skipBlock) {
        continue
      } else if (key === 'include') {
        for (const arg of args) include(arg, depth)
      } else {
        blocks[blocks.length - 1].directives.push({ key, args, line: lineNo })
      }
    }
  }

  const include = (arg: string, depth: number): void => {
    if (!opts.include) {
      warnings.push(`Include not followed: ${arg}`)
      return
    }
    if (depth >= MAX_INCLUDE_DEPTH) {
      warnings.push(`Include nested too deeply, not followed: ${arg}`)
      return
    }
    let result: IncludeResult
    try {
      result = opts.include(expandHome(arg, opts.home))
    } catch {
      warnings.push(`Include could not be read: ${arg}`)
      return
    }
    warnings.push(...result.warnings)
    for (const file of result.files) {
      const key = file.realPath ?? resolve(file.path)
      if (visited.has(key)) {
        warnings.push(`Include loop skipped: ${file.path}`)
        continue
      }
      const size = Buffer.byteLength(file.text)
      if (size > MAX_SSH_CONFIG_BYTES) {
        warnings.push(`Include skipped, larger than 1 MiB: ${file.path}`)
        continue
      }
      if (includeFiles >= MAX_INCLUDE_FILES || includeBytes + size > MAX_INCLUDE_TOTAL_BYTES) {
        if (!budgetWarned) warnings.push('Include budget exhausted, remaining includes skipped')
        budgetWarned = true
        continue
      }
      visited.add(key)
      includeFiles++
      includeBytes += size
      walk(file.text, depth + 1)
      visited.delete(key) // only files on the current include stack count as a loop
    }
  }

  walk(text, 0)

  const entries: SshConfigEntry[] = []
  const shared = new Set<string>()
  // Literal-only blocks are indexed by alias so matching stays linear in the config size.
  const byAlias = new Map<string, number[]>()
  const wild: number[] = []
  blocks.forEach((b, i) => {
    if (!b.patterns || b.patterns.some((p) => !isConcrete(p))) wild.push(i)
    else for (const p of new Set(b.patterns)) (byAlias.get(p) ?? byAlias.set(p, []).get(p)!).push(i)
  })
  for (const alias of aliases) {
    const idx = [...(byAlias.get(alias) ?? []), ...wild].sort((x, y) => x - y)
    entries.push(buildEntry(alias, idx.map((i) => blocks[i]), opts, shared))
  }
  warnings.push(...shared)
  return { entries, warnings }
}

function isConcrete(pattern: string): boolean {
  return !/[*?!]/.test(pattern)
}

function buildEntry(alias: string, blocks: Block[], opts: ParseOptions, shared: Set<string>): SshConfigEntry {
  const entry: SshConfigEntry = {
    alias,
    hostName: alias,
    port: null,
    user: null,
    identityFile: null,
    proxyJump: null,
    forwards: [],
    warnings: [],
  }
  const got = new Set<string>()
  const sshDir = resolve(opts.sshDir)

  for (const block of blocks) {
    if (block.patterns && !matchesPatterns(block.patterns, alias)) continue
    // Problems in shared blocks (Host *, wildcards) are reported once, not per host.
    const shareable = !block.patterns || block.patterns.some((p) => !isConcrete(p))
    const warn = (msg: string): void => {
      if (shareable) shared.add(msg)
      else entry.warnings.push(msg)
    }
    for (const { key, args, line } of block.directives) {
      if (key === 'localforward' || key === 'remoteforward') {
        if (args.length) {
          const f: SshForward = { type: key === 'localforward' ? 'L' : 'R', spec: args.join(' ') }
          entry.forwards.push(f)
        }
        continue
      }
      if (!['hostname', 'port', 'user', 'identityfile', 'proxyjump'].includes(key) || got.has(key)) continue
      const value = args.length ? args.join(' ') : ''
      if (!value) continue
      got.add(key)
      if (key === 'hostname') {
        entry.hostName = value.replace(/%([h%])/g, (_, c: string) => (c === 'h' ? alias : '%'))
      } else if (key === 'user') {
        entry.user = value
      } else if (key === 'proxyjump') {
        entry.proxyJump = value.toLowerCase() === 'none' ? null : value
      } else if (key === 'port') {
        const n = /^\d+$/.test(value) ? Number(value) : NaN
        if (n >= 1 && n <= 65535) entry.port = n
        else warn(`Invalid Port "${value}" (line ${line})`)
      } else {
        const expanded = expandHome(value, opts.home)
        const full = isAbsolute(expanded) ? resolve(expanded) : null
        if (full && full.startsWith(sshDir + sep)) entry.identityFile = full
        else warn(`IdentityFile outside ${opts.sshDir} ignored: ${value} (line ${line})`)
      }
    }
  }
  return entry
}

/** Include reader confined to `sshDir`: globs only in the basename, symlinks must not escape. */
export function readSshIncludes(sshDir: string): (pattern: string) => IncludeResult {
  return (pattern) => {
    const files: IncludeFile[] = []
    const warnings: string[] = []
    try {
      const full = isAbsolute(pattern) ? resolve(pattern) : resolve(sshDir, pattern)
      const dir = dirname(full)
      const base = basename(full)
      let realRoot: string
      let realDir: string
      try {
        realRoot = realpathSync(sshDir)
        realDir = realpathSync(dir)
      } catch {
        return { files, warnings }
      }
      const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep)
      if (!inside(realDir)) {
        warnings.push(`Include outside ${sshDir} skipped: ${pattern}`)
        return { files, warnings }
      }
      const names = /[*?]/.test(base) ? readdirSync(dir).filter((n) => globMatch(base, n)).sort() : [base]
      for (const name of names) {
        const path = resolve(dir, name)
        try {
          if (!lstatSync(path, { throwIfNoEntry: false })) continue
          const real = realpathSync(path)
          if (!inside(real)) {
            warnings.push(`Include outside ${sshDir} skipped: ${path}`)
            continue
          }
          const st = statSync(real)
          if (!st.isFile()) {
            warnings.push(`Include skipped, not a regular file: ${path}`)
            continue
          }
          if (st.size > MAX_SSH_CONFIG_BYTES) {
            warnings.push(`Include skipped, larger than 1 MiB: ${path}`)
            continue
          }
          if (files.length >= MAX_INCLUDE_MATCHES) {
            warnings.push(`Include matches too many files, using the first ${MAX_INCLUDE_MATCHES}: ${pattern}`)
            break
          }
          files.push({ path, realPath: real, text: readFileSync(real, 'utf8') })
        } catch {
          warnings.push(`Include could not be read: ${path}`)
        }
      }
    } catch {
      warnings.push(`Include could not be read: ${pattern}`)
    }
    return { files, warnings }
  }
}
