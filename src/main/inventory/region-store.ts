import { randomUUID } from 'node:crypto'
import {
  MAX_NAME,
  MAX_PROVIDER,
  REGIONS_REPORT_KEY,
  REGION_CODE,
  UNSAFE_SSH_CHAR,
  type RegionInput,
  type RegionMeta,
  type RegionPatch,
  type RegionsUpgradeReport,
} from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkName, regionMeta, regionMetas } from './rows'

const DISMISSED_KEY = 'migration.regions.dismissed'

/** Regions hosts belong to. One list for the whole app. Every write is audited without values. */
export class RegionStore {
  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
  ) {}

  /** Works while locked. */
  list(): RegionMeta[] {
    return regionMetas(this.db)
  }

  create(input: RegionInput): RegionMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    const meta = regionMeta(this.db, id)
    this.audit.append({ action: 'region.create', outcome: 'success', targetType: 'region', targetId: id, targetLabel: meta.code })
    return meta
  }

  /** create() without the transaction, the unlock check or the audit: for a caller's own transaction (config import). */
  insertInTx(input: RegionInput, id: string = randomUUID()): string {
    const code = this.uniqueCode(checkCode(input.code))
    const provider = checkProvider(input.provider ?? '')
    const displayName = checkName(input.displayName, 'region name', MAX_NAME)
    const ts = new Date().toISOString()
    this.db
      .prepare('INSERT INTO regions(id, code, provider, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, code, provider, displayName, ts, ts)
    return id
  }

  update(id: string, patch: RegionPatch): RegionMeta {
    this.vault.assertUnlocked()
    const next = inTransaction(this.db, () => this.updateInTx(id, patch))
    if (next === null) return regionMeta(this.db, id)
    this.audit.append({
      action: 'region.update',
      outcome: 'success',
      targetType: 'region',
      targetId: id,
      targetLabel: next.code,
      details: { fields: next.fields },
    })
    return regionMeta(this.db, id)
  }

  /** update() without the transaction, the unlock check or the audit; null when nothing changed. */
  updateInTx(id: string, patch: RegionPatch): { code: string; fields: string[] } | null {
    const before = regionMeta(this.db, id)
    const code = patch.code === undefined ? before.code : this.uniqueCode(checkCode(patch.code), id)
    const provider = patch.provider === undefined ? before.provider : checkProvider(patch.provider)
    const displayName = patch.displayName === undefined ? before.displayName : checkName(patch.displayName, 'region name', MAX_NAME)
    const fields = [
      code !== before.code && 'code',
      provider !== before.provider && 'provider',
      displayName !== before.displayName && 'displayName',
    ].filter((f): f is string => typeof f === 'string')
    if (fields.length === 0) return null
    this.db
      .prepare('UPDATE regions SET code = ?, provider = ?, display_name = ?, updated_at = ? WHERE id = ?')
      .run(code, provider, displayName, new Date().toISOString(), id)
    return { code, fields }
  }

  /** Refused while any host is in the region. */
  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = regionMeta(this.db, id)
    inTransaction(this.db, () => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM hosts WHERE region_id = ?').get(id) as { n: number }).n
      if (n > 0) throw new Error(`${before.code} still has ${n === 1 ? 'a host' : `${n} hosts`}: move ${n === 1 ? 'it' : 'them'} to another region first`)
      this.db.prepare('DELETE FROM regions WHERE id = ?').run(id)
    })
    this.audit.append({ action: 'region.delete', outcome: 'success', targetType: 'region', targetId: id, targetLabel: before.code })
  }

  /** What migration 12 moved, until the user dismisses it; null when it had nothing to report. Works while locked. */
  upgradeReport(): RegionsUpgradeReport | null {
    if (this.setting(DISMISSED_KEY) !== undefined) return null
    const raw = this.setting(REGIONS_REPORT_KEY)
    return raw === undefined ? null : (JSON.parse(raw) as RegionsUpgradeReport)
  }

  /** Works while locked: it only hides the banner, the report itself stays. */
  dismissUpgradeReport(): void {
    this.putSetting(DISMISSED_KEY, new Date().toISOString())
  }

  private setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  private putSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, new Date().toISOString())
  }

  private uniqueCode(code: string, selfId = ''): string {
    // The column is COLLATE NOCASE, so = compares case-insensitively.
    if (this.db.prepare('SELECT 1 FROM regions WHERE code = ? AND id <> ?').get(code, selfId)) {
      throw new Error('a region with that code already exists')
    }
    return code
  }
}

/** Trimmed and lowercased, then held to REGION_CODE. The message never carries the value. */
export function checkCode(raw: string): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!REGION_CODE.test(s)) throw new Error('region code must be 1-63 lowercase letters, digits or hyphens, not starting with a hyphen')
  return s
}

function checkProvider(raw: string): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length > MAX_PROVIDER || UNSAFE_SSH_CHAR.test(s)) throw new Error(`provider must be at most ${MAX_PROVIDER} plain characters`)
  return s
}
