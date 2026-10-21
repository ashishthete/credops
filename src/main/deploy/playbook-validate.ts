import { STEP_TIMEOUT_RANGE } from '../../shared/deploy'

/**
 * Static validation of a hand-edited playbook (Task 10). Nothing here runs ansible or a shell: the text is
 * scanned as strict JSON and checked against allow-lists and against the playbook the generator produced.
 * What the generator owns (the plays' hosts and vars, every lock task, every delegated task, every task that
 * reads a secret) must come back byte-identical; what the user adds is limited to a few harmless modules and
 * a closed Jinja subset that cannot reach a secret (S3, S7, S9).
 */

export interface EditError {
  line: number
  message: string
}
export type EditResult = { ok: true; canonical: string } | { ok: false; errors: EditError[] }

/** Plain-language messages, shown by the editor as they are. */
export const EDIT_RULE = {
  parse: (why: string): string => `The playbook is not valid JSON: ${why}`,
  tooLarge: 'The playbook is larger than 256 KB',
  bom: 'The playbook starts with a byte order mark; remove it',
  duplicateKey: (k: string): string => `The key "${k}" appears twice in the same object`,
  numberToken: 'NaN and Infinity are not valid JSON',
  topLevel: 'A playbook is a list of plays',
  playCount: 'Plays cannot be added or removed; add tasks inside the existing plays',
  playKey: (k: string): string => `"${k}" is not allowed on a play`,
  playOwned: (k: string): string => `Play "${k}" is generated and cannot be changed`,
  taskObject: 'A task must be an object',
  taskKey: (k: string): string => `"${k}" is not allowed in an edited task`,
  module: (k: string): string => `The module "${k}" is not allowed; use shell, command, set_fact, fail, debug, wait_for or uri`,
  oneModule: 'A task needs exactly one module (shell, command, set_fact, fail, debug, wait_for or uri), or a block',
  moduleParam: (m: string, k: string): string => `"${k}" is not allowed for ${m}`,
  moduleShape: (m: string): string => `${m} has the wrong shape`,
  protectedTask: 'This task is generated (host lock, delegated or secret-reading) and must be exactly as generated',
  lockRemoved: (n: string): string => `The generated task "${n}" was removed or changed; lock tasks must stay exactly as generated`,
  timeout: `A timeout must be a whole number of seconds from 1 to ${STEP_TIMEOUT_RANGE[1]}`,
  jinjaStatement: 'Jinja statements and comments ({% %}, {# #}) are not allowed',
  jinjaExpr: 'Only {{ name.path | filter }} is allowed, with the filters quote, b64decode, default, from_json, bool and int',
  jinjaUnterminated: 'A {{ is not closed',
  secretRef: 'Secrets, hostvars and the become password can be read only by generated tasks',
  lookup: 'lookup() and query() are not allowed',
  condition: 'A condition must be true, false, a generated condition, or <register>.rc == <number>',
  reserved: (k: string): string => `"${k}" is a name the generator owns and cannot be set or registered`,
  tags: 'Tags are short words of letters, digits and _ . = : -; od_step=lock and od_step=unlock are generated only',
  tagType: 'tags must be a list of strings',
  flag: (k: string): string => `${k} must be true or false`,
  intField: (k: string): string => `${k} must be a whole number`,
  blockShape: 'block, rescue and always must be lists of tasks and cannot be combined with a module',
  vars: 'Task vars must be simple names and cannot use a generated name',
  tooMany: 'The playbook has too many tasks',
  tooDeep: 'The playbook is nested too deeply',
  tooManyErrors: 'More problems were found; fix these first',
} as const

const MAX_BYTES = 256 * 1024
const MAX_TASKS = 2000
const MAX_DEPTH = 8
const MAX_ERRORS = 50
const MAX_TIMEOUT = STEP_TIMEOUT_RANGE[1]

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------- scanner

class ScanError extends Error {
  constructor(
    readonly at: number,
    message: string,
  ) {
    super(message)
  }
}

interface Scanned {
  value: unknown
  /** Offset of each value and key, by path (`/0/tasks/1/name`). */
  at: Map<string, number>
}

const ESC: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** Strict JSON: no BOM, no NaN or Infinity, no duplicate keys, no trailing text. Records offsets for line numbers. */
function scan(text: string): Scanned {
  const at = new Map<string, number>()
  let i = 0
  const ws = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  }
  const str = (): string => {
    const start = i
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) throw new ScanError(start, 'unterminated string')
      const c = text[i]
      if (c === '"') {
        i++
        return out
      }
      if (c < ' ') throw new ScanError(i, 'control character in string')
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ScanError(i, 'bad \\u escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
        } else if (e !== undefined && e in ESC) {
          out += ESC[e]
          i += 2
        } else throw new ScanError(i, 'bad escape')
      } else {
        out += c
        i++
      }
    }
  }
  const val = (path: string, depth: number): unknown => {
    if (depth > 64) throw new ScanError(i, 'nested too deeply')
    ws()
    at.set(path, i)
    const c = text[i]
    if (c === '{') {
      i++
      const o: Obj = Object.create(null) as Obj
      ws()
      if (text[i] === '}') {
        i++
        return {}
      }
      for (;;) {
        ws()
        if (text[i] !== '"') throw new ScanError(i, 'expected a key')
        const kAt = i
        const k = str()
        if (Object.prototype.hasOwnProperty.call(o, k)) throw new ScanError(kAt, EDIT_RULE.duplicateKey(k.slice(0, 40)))
        at.set(`${path}/${k}`, kAt)
        ws()
        if (text[i] !== ':') throw new ScanError(i, 'expected ":"')
        i++
        o[k] = val(`${path}/${k}`, depth + 1)
        at.set(`${path}/${k}`, kAt)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return { ...o }
        }
        throw new ScanError(i, 'expected "," or "}"')
      }
    }
    if (c === '[') {
      i++
      const a: unknown[] = []
      ws()
      if (text[i] === ']') {
        i++
        return a
      }
      for (;;) {
        a.push(val(`${path}/${a.length}`, depth + 1))
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return a
        }
        throw new ScanError(i, 'expected "," or "]"')
      }
    }
    if (c === '"') return str()
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))
    if (m) {
      i += m[0].length
      return JSON.parse(m[0]) as unknown
    }
    if (/^-?(?:NaN|Infinity)/.test(text.slice(i, i + 10))) throw new ScanError(i, EDIT_RULE.numberToken)
    throw new ScanError(i, 'unexpected character')
  }
  const value = val('', 0)
  ws()
  if (i < text.length) throw new ScanError(i, 'unexpected text after the playbook')
  return { value, at }
}

// ---------------------------------------------------------------- helpers

/** Key-sorted JSON, so two tasks compare equal whatever order their keys came in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

const PATH = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[\\d{1,4}\\])*'
const LIT = `(?:true|false|-?\\d{1,9}|'[^'\\\\{}|()]*'|"[^"\\\\{}|()]*")`
const FILTER = `(?:quote|b64decode|from_json|bool|int|default(?:\\(\\s*${LIT}(?:\\s*,\\s*(?:true|false))?\\s*\\))?)`
const EXPR = new RegExp(`^(${PATH})(?:\\s*\\|\\s*${FILTER})*$`)
const COND = /^[A-Za-z_][A-Za-z0-9_]{0,31}\.(?:rc|status) (?:==|!=) \d{1,4}$/
const REGISTER = /^[a-z][a-z0-9_]{0,31}$/
const TAG = /^[A-Za-z0-9_.=:-]{1,64}$/
const VARNAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const RESERVED = /^(?:ansible_.*|s|d|od|od_failed|rollback_failed|hostvars|vars|environment|inventory_hostname|groups|lookup|query)$/

const MODULES = ['shell', 'command', 'set_fact', 'fail', 'debug', 'wait_for', 'uri'] as const
type Mod = (typeof MODULES)[number]
const moduleOf = (k: string): Mod | null => {
  const bare = k.startsWith('ansible.builtin.') ? k.slice('ansible.builtin.'.length) : k
  return (MODULES as readonly string[]).includes(bare) ? (bare as Mod) : null
}

const PARAMS: Record<Mod, readonly string[] | null> = {
  shell: ['cmd', 'executable', 'chdir', 'stdin', 'stdin_add_newline'],
  command: ['cmd', 'argv', 'chdir', 'stdin', 'stdin_add_newline'],
  set_fact: null,
  fail: ['msg'],
  debug: ['msg'],
  wait_for: ['host', 'port', 'path', 'state', 'timeout', 'delay', 'sleep', 'connect_timeout', 'search_regex', 'msg'],
  uri: ['url', 'method', 'status_code', 'timeout', 'headers', 'body', 'body_format', 'return_content', 'validate_certs'],
}

const TASK_KEYS = new Set([
  'name', 'timeout', 'tags', 'when', 'failed_when', 'changed_when', 'become', 'no_log', 'register', 'retries', 'delay', 'until',
  'ignore_errors', 'vars', 'block', 'rescue', 'always', 'delegate_to', 'connection',
])
const PLAY_KEYS = new Set(['name', 'hosts', 'gather_facts', 'strategy', 'vars', 'tasks'])
const PLAY_OWNED = ['name', 'hosts', 'gather_facts', 'strategy', 'vars'] as const

const lineOf = (text: string, at: number): number => {
  let n = 1
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Every task of the generated playbook, nested ones included, keyed by stable text. */
function collect(tasks: unknown, out: Obj[]): void {
  if (!Array.isArray(tasks)) return
  for (const t of tasks) {
    if (!isObj(t)) continue
    out.push(t)
    for (const k of ['block', 'rescue', 'always']) collect(t[k], out)
  }
}

/** A generated lock, unlock or lock-check task: never removable or editable. */
function isLockTask(t: Obj): boolean {
  const tags = Array.isArray(t.tags) ? t.tags : []
  return tags.includes('od_step=lock') || tags.includes('od_step=unlock') || (typeof t.name === 'string' && t.name.startsWith('preflight lock '))
}

// ---------------------------------------------------------------- validator

class Checker {
  readonly errors: EditError[] = []
  private tasks = 0
  private readonly genTasks = new Set<string>()
  private readonly genVars = new Set<string>()
  private readonly genConds = new Set<string>()

  constructor(
    private readonly text: string,
    private readonly at: Map<string, number>,
    private readonly gen: Obj[],
  ) {
    const all: Obj[] = []
    for (const p of gen) collect(p.tasks, all)
    for (const t of all) {
      this.genTasks.add(stable(t))
      if (isObj(t.vars)) this.genVars.add(stable(t.vars))
      for (const k of ['when', 'failed_when', 'until']) if (typeof t[k] === 'string') this.genConds.add(t[k] as string)
    }
  }

  err(path: string, message: string): void {
    if (this.errors.length === MAX_ERRORS) this.errors.push({ line: 1, message: EDIT_RULE.tooManyErrors })
    if (this.errors.length > MAX_ERRORS) return
    let p = path
    while (!this.at.has(p) && p.length > 0) p = p.slice(0, p.lastIndexOf('/'))
    this.errors.push({ line: lineOf(this.text, this.at.get(p) ?? 0), message })
  }

  plays(v: unknown): void {
    if (!Array.isArray(v) || !v.every(isObj)) return this.err('', EDIT_RULE.topLevel)
    if (v.length !== this.gen.length) return this.err('', EDIT_RULE.playCount)
    v.forEach((play, i) => {
      const base = `/${i}`
      for (const k of Object.keys(play)) if (!PLAY_KEYS.has(k)) this.err(`${base}/${k}`, EDIT_RULE.playKey(k.slice(0, 40)))
      for (const k of PLAY_OWNED) if (stable(play[k]) !== stable(this.gen[i][k])) this.err(`${base}/${k}`, EDIT_RULE.playOwned(k))
      if (!Array.isArray(play.tasks)) return this.err(`${base}/tasks`, EDIT_RULE.topLevel)
      this.list(play.tasks, `${base}/tasks`, 0)
      const have = new Map<string, number>()
      const flat: Obj[] = []
      collect(play.tasks, flat)
      for (const t of flat) have.set(stable(t), (have.get(stable(t)) ?? 0) + 1)
      const want: Obj[] = []
      collect(this.gen[i].tasks, want)
      for (const t of want.filter(isLockTask)) {
        const key = stable(t)
        const n = have.get(key) ?? 0
        if (n === 0) this.err(`${base}/tasks`, EDIT_RULE.lockRemoved(String(t.name).slice(0, 60)))
        else have.set(key, n - 1)
      }
    })
  }

  private list(v: unknown, path: string, depth: number): void {
    if (!Array.isArray(v)) return this.err(path, EDIT_RULE.blockShape)
    if (depth > MAX_DEPTH) return this.err(path, EDIT_RULE.tooDeep)
    v.forEach((t, i) => this.task(t, `${path}/${i}`, depth))
  }

  private task(t: unknown, path: string, depth: number): void {
    if (++this.tasks > MAX_TASKS) {
      if (this.tasks === MAX_TASKS + 1) this.err(path, EDIT_RULE.tooMany)
      return
    }
    if (!isObj(t)) return this.err(path, EDIT_RULE.taskObject)
    // Byte-identical to a generated task (key order aside): nothing further to check.
    if (this.genTasks.has(stable(t))) return

    if ('delegate_to' in t || 'connection' in t || isLockTask(t)) this.err(path, EDIT_RULE.protectedTask)
    const mods: string[] = []
    for (const k of Object.keys(t)) {
      const kp = `${path}/${k}`
      if (moduleOf(k) !== null) mods.push(k)
      else if (!TASK_KEYS.has(k)) this.err(kp, EDIT_RULE.taskKey(k.slice(0, 40)))
    }
    const isBlock = 'block' in t || 'rescue' in t || 'always' in t
    if (isBlock) {
      if (mods.length > 0 || !Array.isArray(t.block)) this.err(path, EDIT_RULE.blockShape)
      for (const k of ['block', 'rescue', 'always']) if (k in t) this.list(t[k], `${path}/${k}`, depth + 1)
    } else if (mods.length !== 1) this.err(path, EDIT_RULE.oneModule)
    for (const m of mods) this.module(moduleOf(m) as Mod, t[m], `${path}/${m}`)

    if ('name' in t) this.strings(t.name, `${path}/name`)
    if ('timeout' in t) this.timeout(t.timeout, `${path}/timeout`)
    for (const k of ['become', 'no_log', 'ignore_errors'] as const) if (k in t && typeof t[k] !== 'boolean') this.err(`${path}/${k}`, EDIT_RULE.flag(k))
    for (const k of ['when', 'failed_when', 'changed_when', 'until'] as const) if (k in t) this.cond(t[k], `${path}/${k}`)
    for (const k of ['retries', 'delay'] as const) {
      const n = t[k]
      if (k in t && !(Number.isInteger(n) && (n as number) >= 0 && (n as number) <= (k === 'retries' ? 1000 : MAX_TIMEOUT))) this.err(`${path}/${k}`, EDIT_RULE.intField(k))
    }
    if ('register' in t) {
      const r = t.register
      if (typeof r !== 'string' || !REGISTER.test(r)) this.err(`${path}/register`, EDIT_RULE.reserved(String(r).slice(0, 40)))
      else if (RESERVED.test(r)) this.err(`${path}/register`, EDIT_RULE.reserved(r))
    }
    if ('tags' in t) this.tagList(t.tags, `${path}/tags`)
    if ('vars' in t && !this.genVars.has(stable(t.vars))) this.taskVars(t.vars, `${path}/vars`)
  }

  private tagList(v: unknown, path: string): void {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return this.err(path, EDIT_RULE.tagType)
    for (const x of v as string[]) if (!TAG.test(x) || x === 'od_step=lock' || x === 'od_step=unlock') this.err(path, EDIT_RULE.tags)
  }

  private taskVars(v: unknown, path: string): void {
    if (!isObj(v)) return this.err(path, EDIT_RULE.vars)
    for (const [k, x] of Object.entries(v)) {
      if (!VARNAME.test(k) || RESERVED.test(k)) this.err(`${path}/${k}`, EDIT_RULE.reserved(k.slice(0, 40)))
      this.strings(x, `${path}/${k}`)
    }
  }

  private timeout(v: unknown, path: string): void {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TIMEOUT) this.err(path, EDIT_RULE.timeout)
  }

  private cond(v: unknown, path: string): void {
    if (typeof v === 'boolean') return
    if (typeof v === 'string' && (this.genConds.has(v) || COND.test(v))) return
    this.err(path, EDIT_RULE.condition)
  }

  private module(m: Mod, v: unknown, path: string): void {
    if (typeof v === 'string' && (m === 'shell' || m === 'command')) return this.strings(v, path)
    if (!isObj(v)) return this.err(path, EDIT_RULE.moduleShape(m))
    const allowed = PARAMS[m]
    for (const [k, x] of Object.entries(v)) {
      const kp = `${path}/${k}`
      if (m === 'set_fact') {
        if (!VARNAME.test(k) || RESERVED.test(k)) this.err(kp, EDIT_RULE.reserved(k.slice(0, 40)))
      } else if (!allowed?.includes(k)) this.err(kp, EDIT_RULE.moduleParam(m, k.slice(0, 40)))
      if (k === 'timeout' || k === 'connect_timeout') this.timeout(x, kp)
      if (k === 'executable' && x !== '/bin/bash') this.err(kp, EDIT_RULE.moduleParam(m, k))
      this.strings(x, kp)
    }
  }

  /** Every string below `v` must pass the Jinja rules. */
  private strings(v: unknown, path: string, depth = 0): void {
    if (typeof v === 'string') return this.jinja(v, path)
    if (depth > 6) return this.err(path, EDIT_RULE.tooDeep)
    if (Array.isArray(v)) v.forEach((x, i) => this.strings(x, `${path}/${i}`, depth + 1))
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) this.strings(x, `${path}/${k}`, depth + 1)
  }

  private jinja(s: string, path: string): void {
    let rest = s
    let plain = ''
    for (;;) {
      const open = rest.indexOf('{{')
      if (open < 0) {
        plain += rest
        break
      }
      plain += rest.slice(0, open)
      const close = rest.indexOf('}}', open + 2)
      if (close < 0) return this.err(path, EDIT_RULE.jinjaUnterminated)
      const inner = rest.slice(open + 2, close).trim()
      const m = EXPR.exec(inner)
      if (!m) {
        this.err(path, /\blookup\s*\(|\bquery\s*\(/.test(inner) ? EDIT_RULE.lookup : EDIT_RULE.jinjaExpr)
      } else {
        const segs = m[1].split(/\.|\[|\]/).filter(Boolean)
        if (segs[0] === 's' || segs[0] === 'hostvars' || /^ansible_/.test(segs[0]) || segs[0] === 'vars' || segs[0] === 'environment') this.err(path, EDIT_RULE.secretRef)
        else if (segs.some((x) => x.startsWith('_'))) this.err(path, EDIT_RULE.jinjaExpr)
      }
      rest = rest.slice(close + 2)
    }
    if (/\{[%#]/.test(plain)) this.err(path, EDIT_RULE.jinjaStatement)
    if (/\blookup\s*\(|\bquery\s*\(/.test(plain)) this.err(path, EDIT_RULE.lookup)
    if (/\b(?:hostvars|ansible_become_password|OPSDECK_SECRETS)\b/.test(plain)) this.err(path, EDIT_RULE.secretRef)
  }
}

/**
 * Validates `text` against the rules above; `generated` is the playbook the generator makes for the same
 * release (the edit is always a change to it). The canonical text is what is stored, hashed and run.
 */
export function validateEditedPlaybook(text: string, generated: string): EditResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, errors: [{ line: 1, message: EDIT_RULE.tooLarge }] }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, errors: [{ line: 1, message: EDIT_RULE.bom }] }
  let scanned: Scanned
  try {
    scanned = scan(text)
  } catch (e) {
    if (e instanceof ScanError) return { ok: false, errors: [{ line: lineOf(text, e.at), message: e.message.startsWith('The ') || e.message.startsWith('NaN') ? e.message : EDIT_RULE.parse(e.message) }] }
    throw e
  }
  const gen = JSON.parse(generated) as Obj[]
  const c = new Checker(text, scanned.at, gen)
  c.plays(scanned.value)
  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  return { ok: true, canonical: JSON.stringify(scanned.value, null, 2) }
}
