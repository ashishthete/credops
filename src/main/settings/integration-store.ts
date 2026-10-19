import {
  DEFAULT_NOTIFY_EVENTS,
  EMAIL,
  GITHUB_REPO,
  GITHUB_WORKFLOW,
  MAX_EMAIL,
  MAX_GIT_REF,
  MAX_RECIPIENTS,
  NOTIFY_EVENTS,
  PROD_LIKE,
  type EnvironmentIntegrations,
  type EnvironmentIntegrationsPatch,
  type NotifyEventKey,
  type QaWorkflow,
} from '../../shared/settings'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkSecretRef, type SecretLookup } from './secret-ref'

interface Row {
  environment_id: string
  notify_events: string
  teams_webhook_secret_id: string | null
  email_to: string
  email_cc: string
  qa_on_deploy: number
  qa_repo: string | null
  qa_workflow: string | null
  qa_ref: string | null
  qa_wait: number
  updated_at: string
}

type Fields = Omit<EnvironmentIntegrations, 'environmentId' | 'updatedAt'>
const FIELDS = ['notifyEvents', 'teamsWebhookSecretId', 'emailTo', 'emailCc', 'qaOnDeploy', 'qa', 'qaWait'] as const satisfies readonly (keyof Fields)[]

const parseList = (raw: string): unknown[] => {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const strings = (raw: string): string[] => parseList(raw).filter((x): x is string => typeof x === 'string')

export interface IntegrationStoreDeps {
  db: Db
  audit: AuditLog
  vault: VaultService
  secrets: SecretLookup
  now?: () => Date
}

/**
 * Per-environment notification and QA settings. Webhooks are secret ids; recipients are stored but
 * audited as counts only. Writes need the vault unlocked and are audited after COMMIT.
 */
export class IntegrationStore {
  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: VaultService
  private readonly secrets: SecretLookup
  private readonly now: () => Date

  constructor(deps: IntegrationStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.secrets = deps.secrets
    this.now = deps.now ?? (() => new Date())
  }

  /** The environment's integrations, or the defaults when none were saved. Works while locked. */
  get(environmentId: string): EnvironmentIntegrations {
    this.envName(environmentId)
    const row = this.db.prepare('SELECT * FROM environment_integrations WHERE environment_id = ?').get(environmentId) as Row | undefined
    if (!row) {
      return {
        environmentId,
        notifyEvents: [...DEFAULT_NOTIFY_EVENTS],
        teamsWebhookSecretId: null,
        emailTo: [],
        emailCc: [],
        qaOnDeploy: false,
        qa: null,
        qaWait: false,
        updatedAt: null,
      }
    }
    const known = new Set<string>(NOTIFY_EVENTS)
    return {
      environmentId,
      notifyEvents: strings(row.notify_events).filter((k): k is NotifyEventKey => known.has(k)),
      teamsWebhookSecretId: row.teams_webhook_secret_id,
      emailTo: strings(row.email_to),
      emailCc: strings(row.email_cc),
      qaOnDeploy: row.qa_on_deploy === 1,
      qa: row.qa_repo !== null && row.qa_workflow !== null ? { repo: row.qa_repo, workflow: row.qa_workflow, ref: row.qa_ref ?? 'main' } : null,
      qaWait: row.qa_wait === 1,
      updatedAt: row.updated_at,
    }
  }

  /** For main (the dispatcher and QA): the same as `get`. */
  forEnvironment(environmentId: string): EnvironmentIntegrations {
    return this.get(environmentId)
  }

  /** `undefined` keeps a field; `qa: null` clears the workflow. */
  update(environmentId: string, patch: EnvironmentIntegrationsPatch): EnvironmentIntegrations {
    this.vault.assertUnlocked()
    const name = this.envName(environmentId)
    const before = this.get(environmentId)
    const merged: Fields = {
      notifyEvents: patch.notifyEvents ?? before.notifyEvents,
      teamsWebhookSecretId: patch.teamsWebhookSecretId === undefined ? before.teamsWebhookSecretId : patch.teamsWebhookSecretId,
      emailTo: patch.emailTo ?? before.emailTo,
      emailCc: patch.emailCc ?? before.emailCc,
      qaOnDeploy: patch.qaOnDeploy ?? before.qaOnDeploy,
      qa: patch.qa === undefined ? before.qa : patch.qa,
      qaWait: patch.qaWait ?? before.qaWait,
    }
    // A first workflow on a non-production environment runs on deploy unless the patch says otherwise.
    if (patch.qaOnDeploy === undefined && before.qa === null && merged.qa !== null) merged.qaOnDeploy = !PROD_LIKE.test(name)
    const f = this.validate(merged)
    const same = (k: keyof Fields): boolean => JSON.stringify(f[k]) === JSON.stringify(before[k])
    const fields = FIELDS.filter((k) => !same(k))
    if (fields.length === 0 && before.updatedAt !== null) return before
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO environment_integrations(environment_id, notify_events, teams_webhook_secret_id, email_to, email_cc,
             qa_on_deploy, qa_repo, qa_workflow, qa_ref, qa_wait, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(environment_id) DO UPDATE SET notify_events = excluded.notify_events,
             teams_webhook_secret_id = excluded.teams_webhook_secret_id, email_to = excluded.email_to, email_cc = excluded.email_cc,
             qa_on_deploy = excluded.qa_on_deploy, qa_repo = excluded.qa_repo, qa_workflow = excluded.qa_workflow,
             qa_ref = excluded.qa_ref, qa_wait = excluded.qa_wait, updated_at = excluded.updated_at`,
        )
        .run(
          environmentId,
          JSON.stringify(f.notifyEvents),
          f.teamsWebhookSecretId,
          JSON.stringify(f.emailTo),
          JSON.stringify(f.emailCc),
          f.qaOnDeploy ? 1 : 0,
          f.qa?.repo ?? null,
          f.qa?.workflow ?? null,
          f.qa?.ref ?? null,
          f.qaWait ? 1 : 0,
          this.now().toISOString(),
        )
    })
    if (fields.length > 0) {
      this.audit.append({
        action: 'integration.update',
        outcome: 'success',
        targetType: 'environment',
        targetId: environmentId,
        targetLabel: name,
        details: { fields, emailTo: f.emailTo.length, emailCc: f.emailCc.length },
      })
    }
    return this.get(environmentId)
  }

  private envName(id: string): string {
    const row = this.db.prepare('SELECT name FROM environments WHERE id = ?').get(id) as { name: string } | undefined
    if (!row) throw new Error('environment not found')
    return row.name
  }

  /** Checks every rule on merged fields. Messages name the rule, never the value. */
  private validate(f: Fields): Fields {
    if (!Array.isArray(f.notifyEvents)) throw new Error('unknown notify event')
    const picked = new Set<string>()
    for (const k of f.notifyEvents) {
      if (!(NOTIFY_EVENTS as readonly string[]).includes(k)) throw new Error('unknown notify event')
      picked.add(k)
    }
    const qa = f.qa === null ? null : checkQa(f.qa)
    if (typeof f.qaOnDeploy !== 'boolean' || typeof f.qaWait !== 'boolean') throw new Error('QA switches must be on or off')
    return {
      notifyEvents: NOTIFY_EVENTS.filter((k) => picked.has(k)),
      teamsWebhookSecretId: checkSecretRef(this.secrets, f.teamsWebhookSecretId, 'webhook'),
      emailTo: checkRecipients(f.emailTo),
      emailCc: checkRecipients(f.emailCc),
      qaOnDeploy: f.qaOnDeploy,
      qa,
      qaWait: f.qaWait,
    }
  }
}

function checkRecipients(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('email address is not valid')
  if (list.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const a = typeof raw === 'string' ? raw.trim() : ''
    if (a.length === 0 || a.length > MAX_EMAIL || !EMAIL.test(a)) throw new Error('email address is not valid')
    if (seen.has(a.toLowerCase())) continue
    seen.add(a.toLowerCase())
    out.push(a)
  }
  return out
}

function checkQa(qa: QaWorkflow): QaWorkflow {
  const repo = typeof qa.repo === 'string' ? qa.repo.trim() : ''
  if (!GITHUB_REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new Error('repo must be owner/name')
  const workflow = typeof qa.workflow === 'string' ? qa.workflow.trim() : ''
  if (!GITHUB_WORKFLOW.test(workflow)) throw new Error('workflow must be a file name like qa.yml or a numeric id')
  const ref = typeof qa.ref === 'string' ? qa.ref.trim() : ''
  if (ref.length === 0) throw new Error('ref is required')
  // eslint-disable-next-line no-control-regex
  if (ref.length > MAX_GIT_REF || /[\s\u0000-\u001f\u007f~^:?*[\\]|\.\.|@\{/.test(ref) || ref.startsWith('-')) {
    throw new Error('ref must be a branch, tag or commit')
  }
  return { repo, workflow, ref }
}
