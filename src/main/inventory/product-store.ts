import { randomUUID } from 'node:crypto'
import {
  MAX_DESCRIPTION,
  MAX_NAME,
  MAX_URL,
  PRODUCT_ICONS,
  REPO_URL,
  type ProductIcon,
  type ProductInput,
  type ProductMeta,
  type ProductPatch,
} from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkColor, checkName, productMeta } from './rows'

/** Products group environments. Every write is audited without values. */
export class ProductStore {
  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
  ) {}

  /** Works while locked. */
  list(): ProductMeta[] {
    const rows = this.db.prepare('SELECT id FROM products ORDER BY name COLLATE NOCASE, id').all() as { id: string }[]
    return rows.map((r) => productMeta(this.db, r.id))
  }

  create(input: ProductInput): ProductMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    const meta = productMeta(this.db, id)
    this.audit.append({
      action: 'product.create',
      outcome: 'success',
      targetType: 'product',
      targetId: id,
      targetLabel: meta.name,
    })
    return meta
  }

  /** create() without the transaction, the unlock check or the audit: for a caller's own transaction (config import). */
  insertInTx(input: ProductInput, id: string = randomUUID()): string {
    const name = this.uniqueName(checkName(input.name, 'product name', MAX_NAME))
    const color = checkColor(input.color, 'product')
    const icon = this.checkIcon(input.icon)
    const description = this.checkDescription(input.description ?? '')
    const repoUrl = this.checkRepoUrl(input.repoUrl ?? null)
    const ts = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO products(id, name, color, icon, description, repo_url, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, name, color, icon, description, repoUrl, ts, ts)
    return id
  }

  /** `undefined` keeps a field; `null` clears repoUrl. */
  update(id: string, patch: ProductPatch): ProductMeta {
    this.vault.assertUnlocked()
    const next = inTransaction(this.db, () => this.updateInTx(id, patch))
    if (next === null) return productMeta(this.db, id)
    this.audit.append({
      action: 'product.update',
      outcome: 'success',
      targetType: 'product',
      targetId: id,
      targetLabel: next.name,
      details: { fields: next.fields },
    })
    return productMeta(this.db, id)
  }

  /** update() without the transaction, the unlock check or the audit; null when nothing changed. */
  updateInTx(id: string, patch: ProductPatch): { name: string; fields: string[] } | null {
    const before = productMeta(this.db, id)
    const name = patch.name === undefined ? before.name : this.uniqueName(checkName(patch.name, 'product name', MAX_NAME), id)
    const color = patch.color === undefined ? before.color : checkColor(patch.color, 'product')
    const icon = patch.icon === undefined ? before.icon : this.checkIcon(patch.icon)
    const description = patch.description === undefined ? before.description : this.checkDescription(patch.description)
    const repoUrl = patch.repoUrl === undefined ? before.repoUrl : this.checkRepoUrl(patch.repoUrl)
    const fields = [
      name !== before.name && 'name',
      color !== before.color && 'color',
      icon !== before.icon && 'icon',
      description !== before.description && 'description',
      repoUrl !== before.repoUrl && 'repoUrl',
    ].filter((f): f is string => typeof f === 'string')
    if (fields.length === 0) return null
    this.db
      .prepare('UPDATE products SET name = ?, color = ?, icon = ?, description = ?, repo_url = ?, updated_at = ? WHERE id = ?')
      .run(name, color, icon, description, repoUrl, new Date().toISOString(), id)
    return { name, fields }
  }

  /** Removes the product and its links only; its environments stay (unassigned if this was their last product). */
  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = productMeta(this.db, id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM products WHERE id = ?').run(id))
    this.audit.append({
      action: 'product.delete',
      outcome: 'success',
      targetType: 'product',
      targetId: id,
      targetLabel: before.name,
      details: { environments: before.environmentIds.length },
    })
  }

  private uniqueName(name: string, selfId = ''): string {
    // The column is COLLATE NOCASE, so = compares case-insensitively.
    if (this.db.prepare('SELECT 1 FROM products WHERE name = ? AND id <> ?').get(name, selfId)) {
      throw new Error('a product with that name already exists')
    }
    return name
  }

  private checkIcon(icon: string): ProductIcon {
    if (!(PRODUCT_ICONS as readonly string[]).includes(icon)) throw new Error('product icon is not allowed')
    return icon as ProductIcon
  }

  private checkDescription(raw: string): string {
    if (typeof raw !== 'string' || raw.length > MAX_DESCRIPTION) {
      throw new Error(`description must be at most ${MAX_DESCRIPTION} characters`)
    }
    return raw
  }

  private checkRepoUrl(raw: string | null): string | null {
    if (raw === null) return null
    if (typeof raw !== 'string' || raw.length > MAX_URL || !REPO_URL.test(raw)) throw new Error('repository URL is invalid')
    return raw
  }
}
