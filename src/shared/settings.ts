// Imported by the renderer: keep runtime code to plain constants (no node or electron imports).

/** Every event a notification channel can be subscribed to, in display order. */
export const NOTIFY_EVENTS = [
  'release.started',
  'release.succeeded',
  'release.failed',
  'release.rolled_back',
  'tunnel.failed',
  'qa.finished',
] as const
export type NotifyEventKey = (typeof NOTIFY_EVENTS)[number]

/** A new environment's events: every key except `release.started`. */
export const DEFAULT_NOTIFY_EVENTS: NotifyEventKey[] = NOTIFY_EVENTS.filter((k) => k !== 'release.started')

/** Environments where QA does not run on deploy unless turned on. */
export const PROD_LIKE = /^(prod|uat|uat_eu)$/i

export const AI_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/
export const DEFAULT_AI_MODEL = 'claude-opus-5-5'
export const MAX_RECIPIENTS = 20
export const MAX_EMAIL = 254
export const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/
export const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
export const GITHUB_WORKFLOW = /^(?:[A-Za-z0-9_.-]{1,200}\.ya?ml|[0-9]{1,20})$/
export const MAX_GIT_REF = 255

export interface IntegrationSettings {
  aiModel: string
  aiApiKeySecretId: string | null
  sendgridApiKeySecretId: string | null
  sendgridFrom: string | null
  githubTokenSecretId: string | null
  macos: boolean
  /** macOS alerts for tunnels with no environment. */
  macosUnscoped: boolean
}
export type IntegrationSettingsPatch = Partial<IntegrationSettings>

/** The settings table key for each field. */
export const SETTINGS = {
  aiModel: 'ai.model',
  aiApiKeySecretId: 'ai.apiKeySecretId',
  sendgridApiKeySecretId: 'sendgrid.apiKeySecretId',
  sendgridFrom: 'sendgrid.from',
  githubTokenSecretId: 'github.tokenSecretId',
  macos: 'notify.macos',
  macosUnscoped: 'notify.macosUnscoped',
} as const satisfies Record<keyof IntegrationSettings, string>

export const DEFAULT_SETTINGS: IntegrationSettings = {
  aiModel: DEFAULT_AI_MODEL,
  aiApiKeySecretId: null,
  sendgridApiKeySecretId: null,
  sendgridFrom: null,
  githubTokenSecretId: null,
  macos: true,
  macosUnscoped: true,
}

export interface QaWorkflow {
  /** `owner/name`. */
  repo: string
  /** A workflow file name (`qa.yml`) or a numeric id. */
  workflow: string
  ref: string
}

export const QA_STATES = ['dispatched', 'running', 'passed', 'failed', 'unknown'] as const
export type QaState = (typeof QA_STATES)[number]

/** One QA workflow dispatch, kept in memory and pushed as `qa:state`. */
export interface QaDispatch {
  id: string
  environmentId: string
  releaseId: string | null
  repo: string
  workflow: string
  ref: string
  /** ISO time the dispatch was accepted. */
  dispatchedAt: string
  state: QaState
  /** The workflow run's page, once found. */
  htmlUrl: string | null
}

export interface EnvironmentIntegrations {
  environmentId: string
  notifyEvents: NotifyEventKey[]
  teamsWebhookSecretId: string | null
  emailTo: string[]
  emailCc: string[]
  qaOnDeploy: boolean
  qa: QaWorkflow | null
  qaWait: boolean
  /** null until the environment's integrations are first saved. */
  updatedAt: string | null
}
export type EnvironmentIntegrationsPatch = Partial<Omit<EnvironmentIntegrations, 'environmentId' | 'updatedAt'>>

export interface IntegrationStatus {
  ai: { configured: boolean; model: string }
  /** A key and a from address are both set. */
  sendgrid: boolean
  github: boolean
  macosSupported: boolean
}

// ---- Notification log ----
export const NOTIFY_CHANNELS = ['teams', 'email', 'macos', 'qa'] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]
export const NOTIFY_STATUSES = ['pending', 'sent', 'skipped', 'failed'] as const
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number]
export const NOTIFY_SOURCES = ['release', 'tunnel', 'test'] as const
export type NotifySourceType = (typeof NOTIFY_SOURCES)[number]
export const MAX_NOTIFY_LOG = 200

/** One `notification_log` row. `detail` is redacted fixed text, never a URL. */
export interface NotificationRecord {
  id: string
  at: string
  sourceType: NotifySourceType
  sourceId: string
  event: string
  channel: NotifyChannel
  status: NotifyStatus
  detail: string | null
}

export interface NotifyLogFilter {
  sourceType?: NotifySourceType
  sourceId?: string
  limit?: number
}

export type NotifyTestTarget = { channel: 'teams' | 'email'; environmentId: string } | { channel: 'macos' }
