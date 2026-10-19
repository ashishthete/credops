import { randomUUID } from 'node:crypto'
import { MAX_TAG, MAX_TAGS, TAG } from '../../shared/inventory'
import {
  MAX_SCRIPT,
  MAX_SNIPPET_DESCRIPTION,
  MAX_SNIPPETS,
  type SnippetInput,
  type SnippetMeta,
} from '../../shared/ops'
import { DEFAULT_VAULT_ID, MAX_LABEL } from '../../shared/vault'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { checkText } from '../util/checks'
import type { VaultService } from '../vault/vault-service'
import { checkValue, parseTemplate, renderTemplate } from './quote'

interface SnippetRow {
  id: string
  label: string
  script_sealed: string
  description: string
  tags: string
  variables: string
  defaults_sealed: string | null
  destructive: number
  created_at: string
  updated_at: string
}

/** A row's sealed columns, opened. `defaults` holds only names that have one. */
interface Opened {
  scriptSealed: string
  defaultsSealed: string | null
  script: string
  defaults: Record<string, string>
}

/** The fields a snippet is made of, validated, with variables derived from the script. */
interface Fields {
  label: string
  script: string
  description: string
  tags: string[]
  variables: string[]
  defaults: Record<string, string>
  destructive: boolean
}

const scriptAad = (id: string): string => `snippet:${id}:script`
const defaultsAad = (id: string): string => `snippet:${id}:defaults`

const LABEL_USED = 'Snippet label is already used'

/** Trimmed, lower-cased, unique and sorted; the message never carries the value. */
function checkTags(raw: string[]): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_TAGS) throw new Error(`a snippet can have at most ${MAX_TAGS} tags`)
  const out = new Set<string>()
  for (const t of raw) {
    const tag = typeof t === 'string' ? t.trim().toLowerCase() : ''
    if (tag.length === 0 || tag.length > MAX_TAG || !TAG.test(tag)) throw new Error('a snippet tag is invalid')
    out.add(tag)
  }
  return [...out].sort()
}

/** Not trimmed: a script is sent as written. Whitespace alone is not a script. */
function checkScript(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_SCRIPT) {
    throw new Error(`snippet script must be 1-${MAX_SCRIPT} characters`)
  }
  return raw
}

function checkDescription(raw: string): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length > MAX_SNIPPET_DESCRIPTION) {
    throw new Error(`snippet description must be at most ${MAX_SNIPPET_DESCRIPTION} characters`)
  }
  return s
}

/** A defaults object with no prototype, so any name is an own key and nothing is inherited. */
const noProto = (): Record<string, string> => Object.create(null) as Record<string, string>

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

const sameDefaults = (a: Record<string, string>, b: Record<string, string>): boolean =>
  sameList(Object.keys(a).sort(), Object.keys(b).sort()) && Object.keys(a).every((k) => a[k] === b[k])

export interface SnippetStoreDeps {
  db: Db
  audit: AuditLog
  vault: VaultService
  now?: () => Date
  ids?: () => string
}

/**
 * Saved snippets. The script and the variable defaults are sealed with the Default vault (AAD
 * `snippet:<id>:script` and `snippet:<id>:defaults`); label, description, tags, variable names and
 * destructive are plaintext metadata. Every call needs an unlocked vault. Opened text is cached per
 * unlock and dropped on lock; it is not registered for redaction. Audit is appended after COMMIT and
 * carries the label, variable names and tags, never the script or a default.
 */
export class SnippetStore {
  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: VaultService
  private readonly now: () => Date
  private readonly ids: () => string
  /** Opened rows by id, valid while their sealed text still matches the row. */
  private readonly cache = new Map<string, Opened>()

  constructor(deps: SnippetStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
    this.vault.onLock(() => this.cache.clear())
  }

  list(): SnippetMeta[] {
    this.vault.assertUnlocked()
    const rows = this.db.prepare('SELECT * FROM snippets ORDER BY label COLLATE NOCASE, id').all() as unknown as SnippetRow[]
    return rows.map((r) => this.meta(r))
  }

  get(id: string): SnippetMeta {
    this.vault.assertUnlocked()
    return this.meta(this.row(id))
  }

  create(input: SnippetInput): SnippetMeta {
    this.vault.assertUnlocked()
    const { id, opened } = inTransaction(this.db, () => {
      const f = this.validate(input, noProto())
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM snippets').get() as { n: number }).n
      if (count >= MAX_SNIPPETS) throw new Error(`too many snippets (${MAX_SNIPPETS})`)
      this.uniqueLabel(f.label)
      const id = this.ids()
      const ts = this.now().toISOString()
      const sealed = this.seal(id, f)
      this.db
        .prepare(
          `INSERT INTO snippets(id, label, script_sealed, description, tags, variables, defaults_sealed, destructive,
            created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          f.label,
          sealed.scriptSealed,
          f.description,
          JSON.stringify(f.tags),
          JSON.stringify(f.variables),
          sealed.defaultsSealed,
          f.destructive ? 1 : 0,
          ts,
          ts,
        )
      return { id, opened: sealed }
    })
    // Cached only once committed, so a failed write leaves no plaintext behind.
    this.cache.set(id, opened)
    const s = this.get(id)
    this.audit.append({
      action: 'snippet.create',
      outcome: 'success',
      targetType: 'snippet',
      targetId: id,
      targetLabel: s.label,
      details: details(s),
    })
    return s
  }

  /**
   * Replaces the snippet with `input`. Variables are re-derived from the script; omitted defaults keep
   * the stored default of each name the script still uses, and given defaults replace them.
   */
  update(id: string, input: SnippetInput): SnippetMeta {
    this.vault.assertUnlocked()
    const before = this.get(id)
    const changed = inTransaction(this.db, () => {
      const beforeDefaults = noProto()
      for (const v of before.variables) if (v.default !== null) beforeDefaults[v.name] = v.default
      const f = this.validate(input, beforeDefaults)
      const fields = [
        f.label !== before.label && 'label',
        f.script !== before.script && 'script',
        f.description !== before.description && 'description',
        !sameList(f.tags, before.tags) && 'tags',
        !sameDefaults(f.defaults, beforeDefaults) && 'defaults',
        f.destructive !== before.destructive && 'destructive',
      ].filter((x): x is string => typeof x === 'string')
      if (fields.length === 0) return null
      if (f.label !== before.label) this.uniqueLabel(f.label, id)
      const sealed = this.seal(id, f)
      this.db
        .prepare(
          `UPDATE snippets SET label = ?, script_sealed = ?, description = ?, tags = ?, variables = ?, defaults_sealed = ?,
            destructive = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          f.label,
          sealed.scriptSealed,
          f.description,
          JSON.stringify(f.tags),
          JSON.stringify(f.variables),
          sealed.defaultsSealed,
          f.destructive ? 1 : 0,
          this.now().toISOString(),
          id,
        )
      return { fields, opened: sealed }
    })
    if (changed !== null) this.cache.set(id, changed.opened)
    const after = this.get(id)
    if (changed === null) return after
    this.audit.append({
      action: 'snippet.update',
      outcome: 'success',
      targetType: 'snippet',
      targetId: id,
      targetLabel: after.label,
      details: { fields: changed.fields, ...details(after) },
    })
    return after
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.get(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id))
    this.cache.delete(id)
    this.audit.append({
      action: 'snippet.delete',
      outcome: 'success',
      targetType: 'snippet',
      targetId: id,
      targetLabel: before.label,
      details: details(before),
    })
  }

  /** The script with each value quoted as one word; a missing value falls back to its default. Not audited. */
  render(id: string, values: Record<string, string>): string {
    this.vault.assertUnlocked()
    const opened = this.open(this.row(id))
    return renderTemplate(parseTemplate(opened.script), values, opened.defaults)
  }

  /** Validates `input`; defaults are `input.defaults` when given, else `kept`, filtered to the script's variables. */
  private validate(input: SnippetInput, kept: Record<string, string | null>): Fields {
    const label = checkText(input.label, 'snippet label', MAX_LABEL)
    const script = checkScript(input.script)
    const description = checkDescription(input.description ?? '')
    const tags = checkTags(input.tags ?? [])
    const variables = parseTemplate(script).variables
    const given = input.defaults ?? kept
    const defaults = noProto()
    for (const name of variables) {
      const value = Object.hasOwn(given, name) ? given[name] : null
      if (typeof value === 'string') defaults[name] = checkValue(name, value)
    }
    return { label, script, description, tags, variables, defaults, destructive: input.destructive === true }
  }

  /** Seals a validated snippet for `id`; the caller caches the result after COMMIT. No defaults seal to NULL, never to `{}`. */
  private seal(id: string, f: Fields): Opened {
    const scriptSealed = this.vault.seal(DEFAULT_VAULT_ID, scriptAad(id), f.script)
    const defaultsSealed =
      Object.keys(f.defaults).length === 0
        ? null
        : this.vault.seal(DEFAULT_VAULT_ID, defaultsAad(id), JSON.stringify(f.defaults))
    return { scriptSealed, defaultsSealed, script: f.script, defaults: f.defaults }
  }

  private open(r: SnippetRow): Opened {
    const hit = this.cache.get(r.id)
    if (hit && hit.scriptSealed === r.script_sealed && hit.defaultsSealed === r.defaults_sealed) return hit
    const script = this.vault.open(DEFAULT_VAULT_ID, scriptAad(r.id), r.script_sealed)
    const defaults =
      r.defaults_sealed === null
        ? noProto()
        : Object.assign(
            noProto(),
            JSON.parse(this.vault.open(DEFAULT_VAULT_ID, defaultsAad(r.id), r.defaults_sealed)) as Record<string, string>,
          )
    const opened: Opened = { scriptSealed: r.script_sealed, defaultsSealed: r.defaults_sealed, script, defaults }
    this.cache.set(r.id, opened)
    return opened
  }

  private meta(r: SnippetRow): SnippetMeta {
    const { script, defaults } = this.open(r)
    return {
      id: r.id,
      label: r.label,
      script,
      description: r.description,
      tags: JSON.parse(r.tags) as string[],
      variables: (JSON.parse(r.variables) as string[]).map((name) => ({
        name,
        default: Object.hasOwn(defaults, name) ? defaults[name] : null,
      })),
      destructive: r.destructive === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private row(id: string): SnippetRow {
    const row = this.db.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as SnippetRow | undefined
    if (!row) throw new Error('snippet not found')
    return row
  }

  private uniqueLabel(label: string, selfId = ''): void {
    // The index is COLLATE NOCASE; compare the same way.
    if (this.db.prepare('SELECT 1 FROM snippets WHERE label = ? COLLATE NOCASE AND id <> ?').get(label, selfId)) {
      throw new Error(LABEL_USED)
    }
  }
}

/** What the audit keeps of a snippet: variable names and tags, never the script or a default. */
function details(s: SnippetMeta): { variables: string[]; tags: string[] } {
  return { variables: s.variables.map((v) => v.name), tags: s.tags }
}
