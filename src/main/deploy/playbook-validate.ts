import { STEP_TIMEOUT_RANGE, type PlaybookEditError } from '../../shared/deploy'
import { REDACTED } from '../security/redact'

/**
 * Static validation of a hand-edited playbook (Task 10). Nothing here runs ansible or a shell: the text is
 * scanned as strict JSON and checked against allow-lists and against the playbook the generator produced.
 * What the generator owns (the plays' hosts and vars, every lock task, every delegated task, every task that
 * reads a secret) must come back byte-identical; what the user adds is limited to a few harmless modules and
 * a closed Jinja subset that cannot reach a secret (S3, S7, S9).
 */

export type EditError = PlaybookEditError
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
  protectedTask: 'This task is generated (host lock, flow gate, stage marker, delegated or secret-reading) and must be exactly as generated',
  protectedMoved: (n: string): string => `The generated task "${n}" must stay in its generated place, outside any block or rescue you added`,
  lockOrder: (n: string): string => `The generated task "${n}" is out of order: locks come first and unlock last, as generated`,
  lockRemoved: (n: string): string => `The generated task "${n}" was removed or changed; lock tasks must stay exactly as generated`,
  generatedRemoved: (n: string): string => `The generated task "${n}" was removed or changed; gates and stage markers must stay exactly as generated`,
  generatedOrder: (n: string): string => `The generated task "${n}" is out of order: gates and stage markers keep their generated order and place`,
  timeout: `A timeout must be a whole number of seconds from 1 to ${STEP_TIMEOUT_RANGE[1]}`,
  shellTimeout: `An added shell or command task needs a timeout of 1 to ${STEP_TIMEOUT_RANGE[1]} seconds`,
  retryBudget: `retries × delay can wait at most ${STEP_TIMEOUT_RANGE[1]} seconds in all`,
  longWait: `A wait (sleep, or wait_for delay, sleep and timeout together) can last at most ${STEP_TIMEOUT_RANGE[1]} seconds`,
  jinjaStatement: 'Jinja statements and comments ({% %}, {# #}) are not allowed',
  jinjaExpr: 'Only {{ name.path | filter }} is allowed, with the filters quote, b64decode, default, from_json, bool and int; to use literal braces, move the script into a step',
  jinjaUnterminated: 'A {{ is not closed',
  secretRef: 'Secrets, hostvars and the become password can be read only by generated tasks',
  generatedRef: 'Names the generator sets (its vars, facts and registered results, such as d, od and r) can be read only by generated tasks',
  lookup: 'lookup() and query() are not allowed',
  condition: 'A condition must be true, false, a generated condition, or <register>.rc == <number>',
  reserved: (k: string): string => `"${k}" is a name the generator owns and cannot be set or registered`,
  tags: 'Tags are short words of letters, digits and _ . = : -; od_step=lock and od_step=unlock are generated only',
  tagType: 'tags must be a list of strings',
  flag: (k: string): string => `${k} must be true or false`,
  intField: (k: string): string => `${k} must be a whole number`,
  blockShape: 'block, rescue and always must be lists of tasks and cannot be combined with a module',
  vars: 'Task vars must be simple names and cannot use a generated name',
  masked: `A task with a hidden value (${REDACTED}) must stay exactly as shown, in its place; a hidden value cannot be typed, moved or copied`,
  rescueChanged: (n: string): string => `The rescue and always tasks of "${n}" are generated and must stay exactly as generated, in their place`,
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
// od_* covers the facts the generator sets and reads (od_failed, od_stage, od_prepared, od_prep_failed, od_bj_N).
const RESERVED = /^(?:ansible_.*|s|d|od|od_.*|rollback_failed|hostvars|vars|environment|inventory_hostname|groups|lookup|query|cacheable|omit)$/
/** Names an added task may never read: the secrets, the host facts and vars, and the become password. */
const SECRET_ROOT = /^(?:s|hostvars|ansible_.*|vars|environment)$/
/** A literal `sleep N` in a script; seconds unless suffixed. */
const SLEEP = /\bsleep\s+(infinity|\d+(?:\.\d+)?)([smhd]?)\b/g
const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }

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
const PLAY_KEYS = new Set(['name', 'hosts', 'gather_facts', 'strategy', 'any_errors_fatal', 'vars', 'tasks'])
const PLAY_OWNED = ['name', 'hosts', 'gather_facts', 'strategy', 'any_errors_fatal', 'vars'] as const

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

const isUnlock = (t: Obj): boolean => Array.isArray(t.tags) && t.tags.includes('od_step=unlock')
const named = (re: RegExp) => (t: Obj): boolean => typeof t.name === 'string' && re.test(t.name)
const isFlowGate = named(/^flow gate \d+$/)
const isFlowDone = named(/^flow play \d+ done$/)
/** Gates and markers that keep a flow, a prepare and a skip safe: never removable, editable or movable. */
const isMarker = named(/^(?:flow gate \d+|flow play \d+ done|origin check .+|build cleanup .+|od prepared|od gate)$/)
const isPinned = (t: Obj): boolean => isLockTask(t) || isMarker(t)
const isSecretStdin = (t: Obj): boolean => {
  for (const k of Object.keys(t)) {
    const m = moduleOf(k)
    const v = t[k]
    if ((m === 'shell' || m === 'command') && isObj(v) && typeof v.stdin === 'string' && v.stdin.includes('{{ s.')) return true
  }
  return false
}
/** Tasks the generator owns by place: locks, gates, markers, delegated tasks and every task that reads a secret. */
const isProtected = (t: Obj): boolean => isPinned(t) || 'delegate_to' in t || 'connection' in t || isSecretStdin(t)
const LISTS = ['block', 'rescue', 'always'] as const
const isBlockTask = (t: Obj): boolean => LISTS.some((k) => k in t)

/**
 * Where a task sits: `p<play>` for a play's own task list, then `>list:<block>#<n>` for each enclosing block,
 * where <block> is the block's own keys (its lists reduced to whether they are there) and n counts the earlier
 * blocks with the same keys in that list. A protected task, and a generated block, is valid only in a place
 * where it was generated: any change to an enclosing block (a when, an ignore_errors, an added rescue) or a
 * wrapper the user added moves it.
 */
type Place = string
const blockId = (b: Obj): string => stable({ ...b, block: 'block' in b, rescue: 'rescue' in b, always: 'always' in b })
const inner = (place: Place, id: string, n: number, list: string): Place => `${place}>${list}:${id}#${n}`

function placesOf(tasks: unknown, place: Place, out: Map<string, Set<Place>>, lists: Map<Place, string[]>, sections?: Map<Place, string>): void {
  if (!Array.isArray(tasks)) return
  lists.set(place, tasks.map(stable))
  const seen = new Map<string, number>()
  for (const t of tasks) {
    if (!isObj(t)) continue
    const block = isBlockTask(t)
    if (isProtected(t) || block) {
      const k = stable(t)
      out.set(k, (out.get(k) ?? new Set()).add(place))
    }
    if (!block) continue
    const id = blockId(t)
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    for (const l of LISTS) {
      const at = inner(place, id, n, l)
      if (l !== 'block' && Array.isArray(t[l])) sections?.set(at, String(t.name).slice(0, 60))
      placesOf(t[l], at, out, lists, sections)
    }
  }
}

/** A masking marker: `‹redacted›`, an unreadable hook or lock data, or base64 text that decodes to one. */
const MARKER = /‹(?:redacted|hook, \d+ bytes|lock data, \d+ bytes)›/
const B64 = /^[A-Za-z0-9+/]{8,}={0,2}$/
function hasMarker(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') {
    if (MARKER.test(v)) return true
    return v.length % 4 === 0 && B64.test(v) && Buffer.from(v, 'base64').toString('utf8').includes(REDACTED)
  }
  if (depth > 12) return false
  if (Array.isArray(v)) return v.some((x) => hasMarker(x, depth + 1))
  if (isObj(v)) return Object.entries(v).some(([k, x]) => hasMarker(k) || hasMarker(x, depth + 1))
  return false
}

/**
 * Pairs each generated task that masking changed with its masked form, by place: `place\nstable(masked)` to the
 * raw tasks there, in generated order. Places follow the masked text, which is what the person edited.
 */
function pairMasked(raw: unknown, masked: unknown, place: Place, out: Map<string, Obj[]>): void {
  if (!Array.isArray(raw) || !Array.isArray(masked)) return
  const seen = new Map<string, number>()
  raw.forEach((r, i) => {
    const m = masked[i]
    if (!isObj(r) || !isObj(m)) return
    if (stable(r) !== stable(m)) {
      const k = `${place}\n${stable(m)}`
      out.set(k, [...(out.get(k) ?? []), r])
    }
    if (!isBlockTask(m)) return
    const id = blockId(m)
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    // A block's own keys (its vars, its when) come back raw even when its lists were edited.
    if (stable(ownOf(r)) !== stable(ownOf(m))) out.set(`${place}\nown:${id}#${n}`, [ownOf(r)])
    for (const l of LISTS) pairMasked(r[l], m[l], inner(place, id, n, l), out)
  })
}

const ownOf = (t: Obj): Obj => Object.fromEntries(Object.entries(t).filter(([k]) => !(LISTS as readonly string[]).includes(k)))

// ---------------------------------------------------------------- validator

class Checker {
  readonly errors: EditError[] = []
  private tasks = 0
  private readonly genTasks = new Set<string>()
  private readonly genVars = new Set<string>()
  private readonly genConds = new Set<string>()
  /** Every variable name the generated playbook sets: play and task vars, set_fact keys and registers. */
  private readonly genNames = new Set<string>()
  private readonly genPlaces = new Map<string, Set<Place>>()
  /** Each generated task list, by place, as stable texts in generated order. */
  private readonly genLists = new Map<Place, string[]>()
  /** The generated rescue and always lists, by place, with the name of their block. */
  private readonly genSections = new Map<Place, string>()
  /** Each edited task list, by place, with its path. */
  private readonly editLists = new Map<Place, { keys: string[]; path: string }>()

  constructor(
    private readonly text: string,
    private readonly at: Map<string, number>,
    private readonly gen: Obj[],
  ) {
    const all: Obj[] = []
    for (const p of gen) collect(p.tasks, all)
    gen.forEach((p, i) => placesOf(p.tasks, `p${i}`, this.genPlaces, this.genLists, this.genSections))
    for (const t of all) {
      this.genTasks.add(stable(t))
      if (isObj(t.vars)) this.genVars.add(stable(t.vars))
      for (const k of ['when', 'failed_when', 'changed_when', 'until']) if (typeof t[k] === 'string') this.genConds.add(t[k] as string)
      if (isObj(t.vars)) for (const k of Object.keys(t.vars)) this.genNames.add(k)
      if (typeof t.register === 'string') this.genNames.add(t.register)
      for (const [k, x] of Object.entries(t)) if (moduleOf(k) === 'set_fact' && isObj(x)) for (const n of Object.keys(x)) this.genNames.add(n)
    }
    for (const p of gen) if (isObj(p.vars)) for (const k of Object.keys(p.vars)) this.genNames.add(k)
  }

  /** A name an added task may not set, register or pass as a var. */
  private owned(k: string): boolean {
    return RESERVED.test(k) || this.genNames.has(k)
  }

  /**
   * Why a Jinja expression may not run in an added task: it names a secret or a generated variable anywhere
   * outside quoted text, however it is spelled (`d.x`, `d['x']`, `(d)`, `d | default`). Null when it names neither.
   */
  private readsGenerated(expr: string): string | null {
    const names = [...expr.replace(/'[^']*'|"[^"]*"/g, "''").matchAll(/(?<![.\w])[A-Za-z_]\w*/g)].map((m) => m[0])
    if (names.some((n) => SECRET_ROOT.test(n))) return EDIT_RULE.secretRef
    return names.some((n) => this.genNames.has(n)) ? EDIT_RULE.generatedRef : null
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
      this.list(play.tasks, `${base}/tasks`, 0, `p${i}`)
      this.pinned(play.tasks, this.gen[i].tasks as Obj[], `${base}/tasks`)
    })
    this.sections()
  }

  /** A generated rescue or always list (mark failed, fail, build cleanup) stays exactly as generated, in its place. */
  private sections(): void {
    for (const [place, name] of this.genSections) {
      const got = this.editLists.get(place)
      if (got && stable(got.keys) === stable(this.genLists.get(place))) continue
      this.err(got?.path ?? `/${place.slice(1, place.indexOf('>'))}/tasks`, EDIT_RULE.rescueChanged(name))
    }
  }

  /**
   * The edit with each masked generated task, unchanged and in its generated place, swapped back for the raw
   * task (and the masked play fields for the raw ones). Any other masking marker is refused.
   */
  unmask(v: unknown, masked: Obj[]): unknown {
    if (!Array.isArray(v) || v.length !== this.gen.length || !v.every(isObj) || masked.length !== this.gen.length) return v
    const swaps = new Map<string, Obj[]>()
    this.gen.forEach((p, i) => pairMasked(p.tasks, masked[i].tasks, `p${i}`, swaps))
    return v.map((play, i) => {
      const out: Obj = { ...play }
      for (const k of PLAY_OWNED) {
        if (k in play && stable(play[k]) === stable(masked[i][k])) out[k] = this.gen[i][k]
        else if (hasMarker(play[k])) this.err(`/${i}/${k}`, EDIT_RULE.masked)
      }
      out.tasks = this.unmaskList(play.tasks, `/${i}/tasks`, `p${i}`, swaps, 0)
      return out
    })
  }

  private unmaskList(v: unknown, path: string, place: Place, swaps: Map<string, Obj[]>, depth: number): unknown {
    if (!Array.isArray(v) || depth > MAX_DEPTH) return v
    const seen = new Map<string, number>()
    return v.map((t, i) => {
      if (!isObj(t)) return t
      const raw = swaps.get(`${place}\n${stable(t)}`)
      if (raw?.length) return raw.shift()
      if (!isBlockTask(t)) {
        if (hasMarker(t)) this.err(`${path}/${i}`, EDIT_RULE.masked)
        return t
      }
      const id = blockId(t)
      const n = seen.get(id) ?? 0
      seen.set(id, n + 1)
      const own = swaps.get(`${place}\nown:${id}#${n}`)?.[0]
      if (!own && hasMarker(ownOf(t))) this.err(`${path}/${i}`, EDIT_RULE.masked)
      const out: Obj = { ...t, ...own }
      for (const l of LISTS) if (l in t) out[l] = this.unmaskList(t[l], `${path}/${i}/${l}`, inner(place, id, n, l), swaps, depth + 1)
      return out
    })
  }

  /**
   * Locks and gates stay at the top of the play's own list in generated order, unlock and the stage marker at
   * its end; every lock, gate and marker stays, unchanged, in its generated order relative to the others.
   */
  private pinned(edited: unknown[], want: Obj[], path: string): void {
    const top = edited.filter(isObj)
    const flat: Obj[] = []
    collect(edited, flat)
    const all: Obj[] = []
    collect(want, all)
    const label = (t: Obj): string => String(t.name).slice(0, 60)
    const order = (t: Obj): string => (isLockTask(t) ? EDIT_RULE.lockOrder(label(t)) : EDIT_RULE.generatedOrder(label(t)))
    const have = new Map<string, number>()
    for (const t of flat) have.set(stable(t), (have.get(stable(t)) ?? 0) + 1)
    let missing = false
    for (const t of all.filter(isPinned)) {
      const key = stable(t)
      const n = have.get(key) ?? 0
      if (n === 0) {
        missing = true
        this.err(path, isLockTask(t) ? EDIT_RULE.lockRemoved(label(t)) : EDIT_RULE.generatedRemoved(label(t)))
      } else have.set(key, n - 1)
    }
    if (missing) return
    const head = (t: Obj): boolean => (isLockTask(t) && !isUnlock(t)) || isFlowGate(t)
    const tail = (t: Obj): boolean => isUnlock(t) || isFlowDone(t)
    const before = this.errors.length
    let h = 0
    while (h < want.length && head(want[h])) h++
    let e = want.length
    while (e > h && tail(want[e - 1])) e--
    want.slice(0, h).forEach((t, j) => {
      if (stable(top[j]) !== stable(t)) this.err(path, order(t))
    })
    want.slice(e).forEach((t, j) => {
      if (stable(top[top.length - (want.length - e) + j]) !== stable(t)) this.err(path, order(t))
    })
    for (const t of want.slice(h, e).filter(isLockTask)) {
      if (!top.some((x) => stable(x) === stable(t))) this.err(path, order(t))
    }
    if (this.errors.length > before) return
    const wanted = all.filter(isPinned)
    const keys = new Set(wanted.map(stable))
    const got = flat.filter((t) => keys.has(stable(t)))
    const k = wanted.findIndex((t, j) => stable(t) !== stable(got[j]))
    if (k >= 0) this.err(path, order(wanted[k]))
    else if (got.length > wanted.length) this.err(path, order(got[wanted.length]))
  }

  private list(v: unknown, path: string, depth: number, place: Place): void {
    if (!Array.isArray(v)) return this.err(path, EDIT_RULE.blockShape)
    if (depth > MAX_DEPTH) return this.err(path, EDIT_RULE.tooDeep)
    this.editLists.set(place, { keys: v.map(stable), path })
    const seen = new Map<string, number>()
    v.forEach((t, i) => {
      let n = 0
      if (isObj(t) && isBlockTask(t)) {
        const id = blockId(t)
        n = seen.get(id) ?? 0
        seen.set(id, n + 1)
      }
      this.task(t, `${path}/${i}`, depth, place, n)
    })
    this.siblings(v, path, place)
  }

  /** A gate or marker keeps its generated order against the generated tasks beside it (an origin check runs before the checkout). */
  private siblings(v: unknown[], path: string, place: Place): void {
    const want = this.genLists.get(place)
    if (!want) return
    const at = v.map((t) => (isObj(t) ? want.indexOf(stable(t)) : -1))
    v.forEach((t, i) => {
      if (!isObj(t) || !isMarker(t) || at[i] < 0) return
      const off = at.some((g, j) => g >= 0 && j !== i && j < i !== g < at[i])
      if (off) this.err(`${path}/${i}`, EDIT_RULE.generatedOrder(String(t.name).slice(0, 60)))
    })
  }

  private task(t: unknown, path: string, depth: number, place: Place, n: number): void {
    if (++this.tasks > MAX_TASKS) {
      if (this.tasks === MAX_TASKS + 1) this.err(path, EDIT_RULE.tooMany)
      return
    }
    if (!isObj(t)) return this.err(path, EDIT_RULE.taskObject)
    // Byte-identical to a generated task (key order aside): nothing further to check but where it sits.
    if (this.genTasks.has(stable(t))) {
      if ((isProtected(t) || isBlockTask(t)) && !this.genPlaces.get(stable(t))?.has(place)) this.err(path, EDIT_RULE.protectedMoved(String(t.name).slice(0, 60)))
      this.record(t, path, place, n)
      return
    }

    if ('delegate_to' in t || 'connection' in t || isPinned(t)) this.err(path, EDIT_RULE.protectedTask)
    const mods: string[] = []
    for (const k of Object.keys(t)) {
      const kp = `${path}/${k}`
      if (moduleOf(k) !== null) mods.push(k)
      else if (!TASK_KEYS.has(k)) this.err(kp, EDIT_RULE.taskKey(k.slice(0, 40)))
    }
    const isBlock = isBlockTask(t)
    if (isBlock) {
      if (mods.length > 0 || !Array.isArray(t.block)) this.err(path, EDIT_RULE.blockShape)
      const id = blockId(t)
      for (const k of LISTS) if (k in t) this.list(t[k], `${path}/${k}`, depth + 1, inner(place, id, n, k))
    } else if (mods.length !== 1) this.err(path, EDIT_RULE.oneModule)
    else {
      const m = moduleOf(mods[0])
      if ((m === 'shell' || m === 'command') && !('timeout' in t)) this.err(path, EDIT_RULE.shellTimeout)
    }
    for (const m of mods) this.module(moduleOf(m) as Mod, t[m], `${path}/${m}`)

    if ('name' in t) this.strings(t.name, `${path}/name`)
    if ('timeout' in t) this.timeout(t.timeout, `${path}/timeout`)
    for (const k of ['become', 'no_log', 'ignore_errors'] as const) if (k in t && typeof t[k] !== 'boolean') this.err(`${path}/${k}`, EDIT_RULE.flag(k))
    for (const k of ['when', 'failed_when', 'changed_when', 'until'] as const) if (k in t) this.cond(t[k], `${path}/${k}`)
    let bad = false
    for (const k of ['retries', 'delay'] as const) {
      const v = t[k]
      if (k in t && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= (k === 'retries' ? 1000 : MAX_TIMEOUT))) {
        bad = true
        this.err(`${path}/${k}`, EDIT_RULE.intField(k))
      }
    }
    // Ansible's defaults when only one is given: 3 retries, 5 seconds apart.
    const retries = typeof t.retries === 'number' ? t.retries : 3
    const delay = typeof t.delay === 'number' ? t.delay : 5
    if (!bad && ('retries' in t || 'delay' in t) && retries * delay > MAX_TIMEOUT) this.err(path, EDIT_RULE.retryBudget)
    if ('register' in t) {
      const r = t.register
      if (typeof r !== 'string' || !REGISTER.test(r)) this.err(`${path}/register`, EDIT_RULE.reserved(String(r).slice(0, 40)))
      else if (this.owned(r)) this.err(`${path}/register`, EDIT_RULE.reserved(r))
    }
    if ('tags' in t) this.tagList(t.tags, `${path}/tags`)
    if ('vars' in t && !this.genVars.has(stable(t.vars))) this.taskVars(t.vars, `${path}/vars`)
  }

  /** The lists of an unchanged generated block, as they sit in the edit. */
  private record(t: Obj, path: string, place: Place, n: number): void {
    if (!isBlockTask(t)) return
    const id = blockId(t)
    for (const l of LISTS) {
      const v = t[l]
      if (!Array.isArray(v)) continue
      const at = inner(place, id, n, l)
      this.editLists.set(at, { keys: v.map(stable), path: `${path}/${l}` })
      const seen = new Map<string, number>()
      v.forEach((x, i) => {
        if (!isObj(x) || !isBlockTask(x)) return
        const k = seen.get(blockId(x)) ?? 0
        seen.set(blockId(x), k + 1)
        this.record(x, `${path}/${l}/${i}`, at, k)
      })
    }
  }

  private tagList(v: unknown, path: string): void {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return this.err(path, EDIT_RULE.tagType)
    for (const x of v as string[]) if (!TAG.test(x) || x === 'od_step=lock' || x === 'od_step=unlock') this.err(path, EDIT_RULE.tags)
  }

  private taskVars(v: unknown, path: string): void {
    if (!isObj(v)) return this.err(path, EDIT_RULE.vars)
    for (const [k, x] of Object.entries(v)) {
      if (!VARNAME.test(k) || this.owned(k)) this.err(`${path}/${k}`, EDIT_RULE.reserved(k.slice(0, 40)))
      this.strings(x, `${path}/${k}`)
    }
  }

  private timeout(v: unknown, path: string): void {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TIMEOUT) this.err(path, EDIT_RULE.timeout)
  }

  private cond(v: unknown, path: string): void {
    if (typeof v === 'boolean') return
    if (typeof v === 'string' && this.genConds.has(v)) return
    if (typeof v === 'string' && COND.test(v)) {
      const why = this.readsGenerated(v)
      return why ? this.err(path, why) : undefined
    }
    this.err(path, EDIT_RULE.condition)
  }

  private module(m: Mod, v: unknown, path: string): void {
    if (typeof v === 'string' && (m === 'shell' || m === 'command')) {
      this.sleeps(v, path)
      return this.strings(v, path)
    }
    if (!isObj(v)) return this.err(path, EDIT_RULE.moduleShape(m))
    if (m === 'shell' || m === 'command') {
      if (typeof v.cmd === 'string') this.sleeps(v.cmd, `${path}/cmd`)
      if (Array.isArray(v.argv)) this.sleeps(v.argv.map(String).join(' '), `${path}/argv`)
    }
    if (m === 'wait_for') {
      const secs = (k: string, dflt: number): number => (typeof v[k] === 'number' ? (v[k] as number) : dflt)
      for (const k of ['delay', 'sleep']) {
        const x = v[k]
        if (k in v && !(typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_TIMEOUT)) this.err(`${path}/${k}`, EDIT_RULE.longWait)
      }
      // wait_for waits `delay`, then polls for up to `timeout` (300 by default).
      if (secs('delay', 0) + secs('timeout', 300) > MAX_TIMEOUT) this.err(path, EDIT_RULE.longWait)
    }
    const allowed = PARAMS[m]
    for (const [k, x] of Object.entries(v)) {
      const kp = `${path}/${k}`
      if (m === 'set_fact') {
        if (!VARNAME.test(k) || this.owned(k)) this.err(kp, EDIT_RULE.reserved(k.slice(0, 40)))
      } else if (!allowed?.includes(k)) this.err(kp, EDIT_RULE.moduleParam(m, k.slice(0, 40)))
      if (k === 'timeout' || k === 'connect_timeout') this.timeout(x, kp)
      if (k === 'executable' && x !== '/bin/bash') this.err(kp, EDIT_RULE.moduleParam(m, k))
      this.strings(x, kp)
    }
  }

  /** A literal `sleep` in a script may not outlast the step timeout cap. */
  private sleeps(script: string, path: string): void {
    for (const m of script.matchAll(SLEEP)) {
      const secs = m[1] === 'infinity' ? Infinity : Number(m[1]) * (UNIT[m[2]] ?? 1)
      if (secs > MAX_TIMEOUT) return this.err(path, EDIT_RULE.longWait)
    }
  }

  /** Every string below `v` must pass the Jinja rules. */
  private strings(v: unknown, path: string, depth = 0): void {
    if (typeof v === 'string') return this.jinja(v, path)
    if (depth > 6) return this.err(path, EDIT_RULE.tooDeep)
    if (Array.isArray(v)) v.forEach((x, i) => this.strings(x, `${path}/${i}`, depth + 1))
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        this.jinja(k, `${path}/${k}`)
        this.strings(x, `${path}/${k}`, depth + 1)
      }
    }
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
      // Before the shape check, so that `d['x']` or `(s)` says why as plainly as `d.x` does.
      const why = this.readsGenerated(inner)
      if (why) this.err(path, why)
      else if (!m) this.err(path, /\blookup\s*\(|\bquery\s*\(/.test(inner) ? EDIT_RULE.lookup : EDIT_RULE.jinjaExpr)
      else if (m[1].split(/\.|\[|\]/).some((x) => x.startsWith('_'))) this.err(path, EDIT_RULE.jinjaExpr)
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
 *
 * `masked` is `generated` as the person saw it (secrets masked): a masked task they left alone, where it was
 * generated, comes back as the raw generated task, so the canonical text holds the real values. Without it the
 * generated text is taken as shown.
 */
export function validateEditedPlaybook(text: string, generated: string, masked = generated): EditResult {
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
  const value = c.unmask(scanned.value, JSON.parse(masked) as Obj[])
  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  c.plays(value)
  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  return { ok: true, canonical: JSON.stringify(value, null, 2) }
}
