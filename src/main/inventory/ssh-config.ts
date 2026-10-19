import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { isSafeSshToken, MAX_IMPORT_ALIASES, MAX_SSH_CONFIG_BYTES, type SshConfigEntry, type SshForward } from '../../shared/inventory'

export interface IncludeFile {
  path: string
  /** Canonical path, used for loop detection when the reader has one. */
  realPath?: string
  text: string
}
export interface IncludeResult {
  files: IncludeFile[]
  warnings: string[]
  /** The reader stopped because the budget it was given ran out. */
  exhausted?: boolean
}
/** What is left of the aggregate include budget; the reader stops before reading past it. */
export interface IncludeBudget {
  files: number
  bytes: number
}
export interface ParseOptions {
  /** Expands `~` and `%d`. */
  home: string
  /** Relative Include paths resolve here; IdentityFile must stay inside. */
  sshDir: string
  /** Supplied by main as a sshDir-confined reader (see readSshIncludes). */
  include?: (pattern: string, budget: IncludeBudget) => IncludeResult
  /** Real path of the top-level file; seeds loop detection. */
  rootPath?: string
}

const MAX_INCLUDE_DEPTH = 4
const MAX_INCLUDE_MATCHES = 100
const MAX_INCLUDE_FILES = 256
const MAX_INCLUDE_TOTAL_BYTES = 4 * MAX_SSH_CONFIG_BYTES
const MAX_HOST_PATTERNS = 10000
const MAX_WILDCARD_BLOCKS = 200
const MAX_WILDCARD_PATTERNS = 500
const MAX_WILDCARD_PATTERN_LENGTH = 256
/** globMatch steps for the whole parse; past it, wildcard blocks stop applying. */
const MAX_GLOB_STEPS = 50_000_000
const MAX_INCLUDE_DIRECTIVES = 1000
const MAX_WARNINGS = 200
/** Per host. */
const MAX_FORWARDS = 64
/** Per block. */
const MAX_IDENTITY_FILES = 32
/** Folder entries the Include reader looks at per parse, matched or not. */
const MAX_INCLUDE_ENTRIES = 10_000
const TOO_LARGE = 'ssh config is larger than 1 MiB'

const KEYS = new Set(['hostname', 'port', 'user', 'identityfile', 'proxyjump'])

/**
 * A Host block folded as it is read: the first non-empty value per key (ssh's first-wins rule)
 * and its first forwards. Applying a block then costs the same however long its body is.
 */
interface Block {
  /** null = lines before any Host, which match everything. */
  patterns: string[] | null
  values: Map<string, { value: string; line: number }>
  forwards: SshForward[]
  /** The block had more forwards than one host keeps. */
  moreForwards: boolean
  /** Every IdentityFile in order (ssh tries them all), as written. */
  identityFiles: string[]
}

const newBlock = (patterns: string[] | null): Block => ({ patterns, values: new Map(), forwards: [], moreForwards: false, identityFiles: [] })

function addDirective(block: Block, key: string, args: string[], line: number): void {
  if (key === 'localforward' || key === 'remoteforward' || key === 'dynamicforward') {
    if (!args.length) return
    const type = key === 'localforward' ? 'L' : key === 'remoteforward' ? 'R' : 'D'
    if (block.forwards.length < MAX_FORWARDS) block.forwards.push({ type, spec: args.join(' ') })
    else block.moreForwards = true
    return
  }
  const value = args.join(' ')
  if (key === 'identityfile' && value && block.identityFiles.length < MAX_IDENTITY_FILES) block.identityFiles.push(value)
  if (KEYS.has(key) && value && !block.values.has(key)) block.values.set(key, { value, line })
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

/** Shared step allowance; a match that runs out returns false and leaves `steps` negative. */
interface GlobBudget {
  steps: number
}

/** Iterative `*`/`?` matcher: backtracks only to the last `*`, so O(n*m) worst case. */
export function globMatch(pattern: string, text: string, budget?: GlobBudget): boolean {
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
    if (budget && budget.steps-- <= 0) return false
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

/** A block whose match ran out of budget doesn't apply, even if a positive pattern already matched. */
function matchesPatterns(patterns: string[], alias: string, budget: GlobBudget): boolean {
  let positive = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), alias, budget)) return false
    } else if (globMatch(p, alias, budget)) positive = true
  }
  return positive && budget.steps >= 0
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return home + value.slice(1)
  return value.replace(/%d/g, home)
}

/** Reads the config and its includes into Host blocks, in file order, plus every concrete alias. */
function readBlocks(text: string, opts: ParseOptions): { blocks: Block[]; aliases: Set<string>; warnings: string[] } {
  const warnings: string[] = []
  const blocks: Block[] = [newBlock(null)]
  const visited = new Set<string>(opts.rootPath ? [resolve(opts.rootPath)] : [])
  let inMatch = false
  let skipBlock = false
  let wildcardBlocks = 0
  let wildcardPatterns = 0
  let wildcardCapWarned = false
  let longWarned = false
  let storedPatterns = 0
  let patternsWarned = false
  let includeFiles = 0
  let includeBytes = 0
  let budgetSpent = false
  let includeDirectives = 0
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
      let args = splitArgs(m[2])
      if (key === 'host') {
        inMatch = false
        // Matching costs grow with pattern length; a dropped negation would widen the block, so it goes too.
        const long = args.filter((pat) => !isConcrete(pat) && pat.length > MAX_WILDCARD_PATTERN_LENGTH)
        if (long.length > 0 && !longWarned) {
          longWarned = true
          warnings.push(`Host patterns longer than ${MAX_WILDCARD_PATTERN_LENGTH} characters are ignored`)
        }
        if (long.some((pat) => pat.startsWith('!'))) {
          skipBlock = true
          continue
        }
        if (long.length > 0) args = args.filter((pat) => !long.includes(pat))
        const wildCount = args.filter((pat) => !isConcrete(pat)).length
        if (wildCount > 0 && wildcardPatterns + wildCount > MAX_WILDCARD_PATTERNS) {
          if (!wildcardCapWarned) warnings.push(`More than ${MAX_WILDCARD_PATTERNS} wildcard Host patterns, the rest are ignored`)
          wildcardCapWarned = true
          skipBlock = true
          continue
        }
        if (wildCount > 0 && ++wildcardBlocks > MAX_WILDCARD_BLOCKS) {
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
          wildcardPatterns += wildCount
          skipBlock = false
          blocks.push(newBlock(kept))
        }
      } else if (key === 'match') {
        inMatch = true
        warnings.push(`Match blocks are not imported (line ${lineNo})`)
      } else if (inMatch || skipBlock) {
        continue
      } else if (key === 'include') {
        for (const arg of args) include(arg, depth)
      } else {
        addDirective(blocks[blocks.length - 1], key, args, lineNo)
      }
    }
  }

  const spendBudget = (): void => {
    if (!budgetSpent) warnings.push('Include budget exhausted, remaining includes skipped')
    budgetSpent = true
  }

  const include = (arg: string, depth: number): void => {
    if (++includeDirectives > MAX_INCLUDE_DIRECTIVES) {
      if (includeDirectives === MAX_INCLUDE_DIRECTIVES + 1) {
        warnings.push(`More than ${MAX_INCLUDE_DIRECTIVES} Include directives, the rest are ignored`)
      }
      return
    }
    if (budgetSpent) return
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
      result = opts.include(expandHome(arg, opts.home), {
        files: MAX_INCLUDE_FILES - includeFiles,
        bytes: MAX_INCLUDE_TOTAL_BYTES - includeBytes,
      })
    } catch {
      warnings.push(`Include could not be read: ${arg}`)
      return
    }
    warnings.push(...result.warnings)
    for (const file of result.files) {
      if (budgetSpent) return
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
        spendBudget()
        return
      }
      visited.add(key)
      includeFiles++
      includeBytes += size
      walk(file.text, depth + 1)
      visited.delete(key) // only files on the current include stack count as a loop
    }
    if (result.exhausted) spendBudget()
  }

  walk(text, 0)
  return { blocks, aliases, warnings }
}

export function parseSshConfig(text: string, opts: ParseOptions): { entries: SshConfigEntry[]; warnings: string[] } {
  if (tooLarge(text)) return { entries: [], warnings: [TOO_LARGE] }
  const { blocks, aliases, warnings } = readBlocks(text, opts)
  const entries: SshConfigEntry[] = []
  const shared = new Set<string>()
  const candidates = indexBlocks(blocks)
  const budget: GlobBudget = { steps: MAX_GLOB_STEPS }
  for (const alias of aliases) entries.push(buildEntry(alias, candidates(alias), opts, shared, budget))
  if (budget.steps < 0) warnings.push('Wildcard Host matching took too long; some hosts are missing settings from wildcard blocks')
  warnings.push(...shared)
  return { entries, warnings: capWarnings(warnings) }
}

/**
 * The blocks that may apply to a name, in file order: literal-only blocks naming it, plus every
 * wildcard and top-level block (still to be matched). Indexed so matching stays linear in the config size.
 */
function indexBlocks(blocks: Block[]): (name: string) => Block[] {
  const byAlias = new Map<string, number[]>()
  const wild: number[] = []
  blocks.forEach((b, i) => {
    if (!b.patterns || b.patterns.some((p) => !isConcrete(p))) wild.push(i)
    else for (const p of new Set(b.patterns)) (byAlias.get(p) ?? byAlias.set(p, []).get(p)!).push(i)
  })
  return (name) => [...(byAlias.get(name) ?? []), ...wild].sort((x, y) => x - y).map((i) => blocks[i])
}

function capWarnings(warnings: string[]): string[] {
  const unique = [...new Set(warnings)]
  if (unique.length <= MAX_WARNINGS) return unique
  return [...unique.slice(0, MAX_WARNINGS), `…and ${unique.length - MAX_WARNINGS} more warnings`]
}

function isConcrete(pattern: string): boolean {
  return !/[*?!]/.test(pattern)
}

function buildEntry(
  alias: string,
  blocks: Block[],
  opts: ParseOptions,
  shared: Set<string>,
  budget: GlobBudget,
): SshConfigEntry {
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
  let moreForwards = false

  for (const block of blocks) {
    // Problems in shared blocks (Host *, wildcards) are reported once, not per host.
    const shareable = !block.patterns || block.patterns.some((p) => !isConcrete(p))
    // Literal-only blocks were picked by alias, so only wildcard blocks need (and spend) matching.
    if (block.patterns && shareable && !matchesPatterns(block.patterns, alias, budget)) continue
    const warn = (msg: string): void => {
      if (shareable) shared.add(msg)
      else entry.warnings.push(msg)
    }
    for (const f of block.forwards) {
      if (entry.forwards.length < MAX_FORWARDS) entry.forwards.push(f)
      else moreForwards = true
    }
    if (block.moreForwards) moreForwards = true
    for (const [key, { value, line }] of block.values) {
      if (got.has(key)) continue
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
  if (moreForwards) shared.add(`More than ${MAX_FORWARDS} port forwards for a host; the rest are ignored`)
  return entry
}

export interface SshConfigTarget {
  label: string
  address: string
}
export interface SshConfigMatch {
  /** A plain username, or null when no matching block sets one. */
  user: string | null
  /** Absolute paths, `~` expanded, in the order ssh tries them. Not checked: the reader decides. */
  identityFiles: string[]
  /** IdentityFile values left out, as written, because they hold a token other than %d. */
  skipped?: string[]
}

/**
 * The ~/.ssh/config settings for a host OpsDeck knows by label and address: the blocks for a Host
 * alias equal to the label, else for an alias whose HostName is the address, else for the address
 * itself; failing all three, `Host *` and top-level lines for the label. Null when nothing applies.
 */
export function matchSshConfig(text: string, opts: ParseOptions, target: SshConfigTarget): SshConfigMatch | null {
  if (tooLarge(text)) return null
  const read = readBlocks(text, opts)
  // ssh lowercases both the host it was given and the patterns it matches against.
  const blocks = read.blocks.map((b) => (b.patterns ? { ...b, patterns: b.patterns.map((p) => p.toLowerCase()) } : b))
  const aliases = new Set([...read.aliases].map((a) => a.toLowerCase()))
  const candidates = indexBlocks(blocks)
  const budget: GlobBudget = { steps: MAX_GLOB_STEPS }
  /** Blocks that apply to `name`, and whether one names it more closely than `Host *`. */
  const applying = (name: string): { blocks: Block[]; specific: boolean } => {
    const out = candidates(name).filter((b) => !b.patterns || matchesPatterns(b.patterns, name, budget))
    return { blocks: out, specific: out.some((b) => b.patterns?.some((p) => !p.startsWith('!') && p !== '*')) }
  }
  const first = (bs: Block[], key: string): string | undefined => bs.find((b) => b.values.has(key))?.values.get(key)?.value
  const label = target.label.toLowerCase()
  const address = target.address.toLowerCase()

  const byLabel = applying(label)
  let chosen = byLabel.specific ? byLabel.blocks : null
  for (const alias of chosen ? [] : aliases) {
    if (alias === label) continue
    const a = applying(alias)
    const hostName = first(a.blocks, 'hostname')?.replace(/%([h%])/g, (_, c: string) => (c === 'h' ? alias : '%')) ?? alias
    if (hostName.toLowerCase() === address) {
      chosen = a.blocks
      break
    }
  }
  if (!chosen && address !== label) {
    const byAddress = applying(address)
    if (byAddress.specific) chosen = byAddress.blocks
  }
  const used = chosen ?? byLabel.blocks
  if (!used.some((b) => b.patterns !== null || b.values.size > 0 || b.identityFiles.length > 0)) return null

  const user = first(used, 'user')?.trim() ?? null
  const identityFiles = new Set<string>()
  const skipped: string[] = []
  for (const raw of used.flatMap((b) => b.identityFiles)) {
    if (identityFiles.size >= MAX_IDENTITY_FILES) break
    if (raw.toLowerCase() === 'none') continue
    // Checked before ~ is expanded, so a % in the home directory itself is fine.
    if (raw.replace(/%d/g, '').includes('%')) {
      if (skipped.length < MAX_IDENTITY_FILES) skipped.push(raw)
      continue
    }
    const expanded = expandHome(raw, opts.home)
    if (isAbsolute(expanded)) identityFiles.add(resolve(expanded))
  }
  return { user: user !== null && isSafeSshToken(user) ? user : null, identityFiles: [...identityFiles], ...(skipped.length ? { skipped } : {}) }
}

/**
 * Reads ~/.ssh/config read-only at each call and matches it. A missing, unreadable or oversized
 * file gives null, so callers fall back silently.
 */
export function readSshConfigMatch(paths: { configPath: string; home: string; sshDir: string }): (target: SshConfigTarget) => SshConfigMatch | null {
  return (target) => {
    try {
      const real = realpathSync(paths.configPath)
      const st = statSync(real)
      if (!st.isFile() || st.size > MAX_SSH_CONFIG_BYTES) return null
      const text = readFileSync(real, 'utf8')
      return matchSshConfig(text, { home: paths.home, sshDir: paths.sshDir, include: readSshIncludes(paths.sshDir), rootPath: real }, target)
    } catch {
      return null
    }
  }
}

/** Include reader confined to `sshDir`: globs only in the basename, symlinks must not escape. */
export function readSshIncludes(sshDir: string): (pattern: string, budget?: IncludeBudget) => IncludeResult {
  // One reader per parse: folder listings are read once, and every entry looked at counts.
  const listings = new Map<string, string[]>()
  let examined = 0
  return (pattern, budget = { files: Infinity, bytes: Infinity }) => {
    const files: IncludeFile[] = []
    const warnings: string[] = []
    let bytes = 0
    try {
      const full = isAbsolute(pattern) ? resolve(pattern) : resolve(sshDir, pattern)
      const dir = dirname(full)
      const base = basename(full)
      if (/[*?]/.test(dir)) {
        warnings.push(`Include ${pattern}: wildcards in folder names aren't supported`)
        return { files, warnings }
      }
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
      let names = [base]
      const globbed = /[*?]/.test(base)
      if (globbed) {
        let listing = listings.get(dir)
        if (!listing) listings.set(dir, (listing = readdirSync(dir).sort()))
        names = listing.filter((n) => globMatch(base, n))
      }
      for (const name of names) {
        if (++examined > MAX_INCLUDE_ENTRIES) {
          warnings.push(`Include looked at more than ${MAX_INCLUDE_ENTRIES} folder entries; the rest are skipped`)
          return { files, warnings, exhausted: true }
        }
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
            // A wildcard sweeps up folders as a matter of course; only a named one is worth a warning.
            if (!globbed) warnings.push(`Include skipped, not a regular file: ${path}`)
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
          if (files.length >= budget.files || bytes + st.size > budget.bytes) return { files, warnings, exhausted: true }
          bytes += st.size
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
