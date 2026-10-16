import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { MAX_SSH_CONFIG_BYTES, type SshConfigEntry, type SshForward } from '../../shared/inventory'

export interface IncludeFile {
  path: string
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
  /** Path of the top-level file; seeds loop detection. */
  rootPath?: string
}

const MAX_INCLUDE_DEPTH = 4
const MAX_INCLUDE_MATCHES = 100
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
  for (let m = re.exec(rest); m; m = re.exec(rest)) args.push(m[1] ?? m[2])
  return args
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

function matchesPatterns(patterns: string[], alias: string): boolean {
  let positive = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(alias)) return false
    } else if (globToRegExp(p).test(alias)) positive = true
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
        blocks.push({ patterns: args, directives: [] })
      } else if (key === 'match') {
        inMatch = true
        warnings.push(`Match blocks are not imported (line ${lineNo})`)
      } else if (inMatch) {
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
      const key = resolve(file.path)
      if (visited.has(key)) {
        warnings.push(`Include loop skipped: ${file.path}`)
        continue
      }
      visited.add(key)
      if (tooLarge(file.text)) {
        warnings.push(`Include skipped, larger than 1 MiB: ${file.path}`)
        continue
      }
      const prevMatch = inMatch
      walk(file.text, depth + 1)
      inMatch = prevMatch && inMatch
    }
  }

  walk(text, 0)

  const entries: SshConfigEntry[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    for (const alias of block.patterns ?? []) {
      if (/[*?!]/.test(alias) || seen.has(alias)) continue
      seen.add(alias)
      entries.push(buildEntry(alias, blocks, opts))
    }
  }
  return { entries, warnings }
}

function buildEntry(alias: string, blocks: Block[], opts: ParseOptions): SshConfigEntry {
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
        else entry.warnings.push(`Invalid Port "${value}" (line ${line})`)
      } else {
        const expanded = expandHome(value, opts.home)
        const full = isAbsolute(expanded) ? resolve(expanded) : null
        if (full && full.startsWith(sshDir + sep)) entry.identityFile = full
        else entry.warnings.push(`IdentityFile outside ${opts.sshDir} ignored: ${value} (line ${line})`)
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
      const names = /[*?]/.test(base)
        ? readdirSync(dir).filter((n) => globToRegExp(base).test(n)).sort()
        : [base]
      if (names.length > MAX_INCLUDE_MATCHES) {
        warnings.push(`Include matches too many files, using the first ${MAX_INCLUDE_MATCHES}: ${pattern}`)
        names.length = MAX_INCLUDE_MATCHES
      }
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
          files.push({ path, text: readFileSync(real, 'utf8') })
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
