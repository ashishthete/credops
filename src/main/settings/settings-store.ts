import {
  AI_MODEL,
  DEFAULT_SETTINGS,
  EMAIL,
  MAX_EMAIL,
  SETTINGS,
  type IntegrationSettings,
  type IntegrationSettingsPatch,
  type IntegrationStatus,
} from '../../shared/settings'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkSecretRef, liveSecretRef, type SecretLookup } from './secret-ref'

export interface SettingsStoreDeps {
  db: Db
  audit: AuditLog
  vault: VaultService
  secrets: SecretLookup
  now?: () => Date
  /** For `status().macosSupported`; defaults to process.platform. */
  platform?: NodeJS.Platform
}

const FIELDS = Object.keys(SETTINGS) as (keyof IntegrationSettings)[]

/**
 * App-wide integration settings (AI model and key, SendGrid, GitHub, macOS alerts). Values are secret
 * *ids*, never secret values. Reads work while locked; writes need the vault unlocked and are audited
 * with the changed field names only, after COMMIT.
 */
export class SettingsStore {
  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: VaultService
  private readonly secrets: SecretLookup
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform
  private readonly listeners = new Set<(s: IntegrationSettings) => void>()

  constructor(deps: SettingsStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.secrets = deps.secrets
    this.now = deps.now ?? (() => new Date())
    this.platform = deps.platform ?? process.platform
  }

  /** The settings, with defaults for unset keys and dangling secret ids read as null. */
  get(): IntegrationSettings {
    const s = this.stored()
    return {
      ...s,
      aiApiKeySecretId: liveSecretRef(this.secrets, s.aiApiKeySecretId),
      sendgridApiKeySecretId: liveSecretRef(this.secrets, s.sendgridApiKeySecretId),
      githubTokenSecretId: liveSecretRef(this.secrets, s.githubTokenSecretId),
    }
  }

  status(): IntegrationStatus {
    const s = this.get()
    return {
      ai: { configured: s.aiApiKeySecretId !== null, model: s.aiModel },
      sendgrid: s.sendgridApiKeySecretId !== null && s.sendgridFrom !== null,
      github: s.githubTokenSecretId !== null,
      macosSupported: this.platform === 'darwin',
    }
  }

  /** Calls `fn` with the new settings after every update that changed something. Returns an unsubscribe. */
  onChange(fn: (s: IntegrationSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  update(patch: IntegrationSettingsPatch): IntegrationSettings {
    this.vault.assertUnlocked()
    const before = this.get()
    const next = this.validate({ ...before, ...definedOnly(patch) })
    const fields = FIELDS.filter((k) => patch[k] !== undefined && next[k] !== before[k])
    if (fields.length === 0) return before
    const ts = this.now().toISOString()
    inTransaction(this.db, () => {
      const put = this.db.prepare(
        'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      for (const k of fields) put.run(SETTINGS[k], JSON.stringify(next[k]), ts)
    })
    this.audit.append({ action: 'settings.update', outcome: 'success', targetType: 'settings', details: { fields } })
    const after = this.get()
    for (const fn of this.listeners) fn(after)
    return after
  }

  private stored(): IntegrationSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const byKey = new Map(rows.map((r) => [r.key, r.value]))
    const out = { ...DEFAULT_SETTINGS } as Record<keyof IntegrationSettings, unknown>
    for (const k of FIELDS) {
      const raw = byKey.get(SETTINGS[k])
      if (raw === undefined) continue
      try {
        const value: unknown = JSON.parse(raw)
        const d = DEFAULT_SETTINGS[k]
        if (d === null ? value === null || typeof value === 'string' : typeof value === typeof d) out[k] = value
      } catch {
        // A corrupt row reads as its default.
      }
    }
    return out as unknown as IntegrationSettings
  }

  /** Checks every rule on fully merged settings. Messages name the rule, never the value. */
  private validate(s: IntegrationSettings): IntegrationSettings {
    if (typeof s.aiModel !== 'string' || !AI_MODEL.test(s.aiModel)) throw new Error('model must look like claude-…')
    let from: string | null = null
    if (s.sendgridFrom !== null) {
      from = typeof s.sendgridFrom === 'string' ? s.sendgridFrom.trim() : ''
      if (from.length === 0 || from.length > MAX_EMAIL || !EMAIL.test(from)) throw new Error('from address must be an email address')
    }
    if (typeof s.macos !== 'boolean' || typeof s.macosUnscoped !== 'boolean') throw new Error('macOS alerts must be on or off')
    return {
      aiModel: s.aiModel,
      aiApiKeySecretId: checkSecretRef(this.secrets, s.aiApiKeySecretId, 'api_key'),
      sendgridApiKeySecretId: checkSecretRef(this.secrets, s.sendgridApiKeySecretId, 'api_key'),
      sendgridFrom: from,
      githubTokenSecretId: checkSecretRef(this.secrets, s.githubTokenSecretId, 'token'),
      macos: s.macos,
      macosUnscoped: s.macosUnscoped,
    }
  }
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>
}
