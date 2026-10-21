import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
import {
  BUILTINS,
  MAX_PARAMS,
  MAX_RUNBOOK_DESCRIPTION,
  MAX_RUNBOOK_NAME,
  MAX_UNTIL_HOURS,
  type OperationRequest,
  type RunbookSaveInput,
} from '../../shared/runbooks'
import type { Channel, IpcContract } from '../../shared/ipc'
import {
  HOST_ADDRESS,
  HOST_ROLES,
  MAX_ADDRESS,
  MAX_ENV_VARS,
  MAX_KEEPALIVE_SEC,
  MAX_DESCRIPTION,
  MAX_IMPORT_ALIASES,
  MAX_LINKS,
  MAX_NAME,
  MAX_NOTES,
  MAX_TAG,
  MAX_TAGS,
  MAX_URL,
  parseEnvDomain,
  OS_ICONS,
  PRODUCT_ICONS,
  REPO_URL,
  REPO_URL_CREDENTIALS_MSG,
  hasRepoCredentials,
  isParsableRepoUrl,
  TAG,
  type EnvironmentInput,
  type EnvironmentPatch,
  type HostInput,
  type HostPatch,
  type ProductInput,
  type ProductPatch,
  type SshImportRequest,
} from '../../shared/inventory'
import {
  CONTAINER_ACTIONS,
  CONTAINER_REF,
  LOG_TAIL_MAX,
  MAX_COMMAND,
  MAX_CONCURRENCY,
  MAX_SNIPPET_DESCRIPTION,
  MAX_RUN_TARGETS,
  MAX_RUN_TIMEOUT_SEC,
  MAX_SCRIPT,
  MAX_VARIABLE_VALUE,
  MAX_VARIABLES,
  VARIABLE_NAME,
  type RunRequest,
  type SnippetInput,
} from '../../shared/ops'
import {
  MAX_DEPLOYMENTS,
  MAX_ENV_TEMPLATE,
  MAX_EVENTS_PAGE,
  HEALTH_STATUS_RANGE,
  HEALTH_TIMEOUT_RANGE,
  MAX_COMPOSE_FILE_INPUT,
  MAX_COMPOSE_NAME,
  MAX_GIT_REF_INPUT,
  MAX_HOOK,
  MAX_POSITION,
  MAX_RELEASE_NOTES,
  MAX_REPO_PATH,
  MAX_URL as MAX_HEALTH_URL,
  STEP_TIMEOUT_RANGE,
  MAX_URLS,
  PLAYBOOK_SHA256,
  VERSION,
  type DeploymentInput,
  type DeploymentPatch,
  type BreakLockConfirm,
  type EnvDeploySettingsPatch,
  type DeployBatch,
  type HealthUrl,
  type PreflightRequest,
  type ReleaseConfirm,
  type ReleaseListFilter,
  MAX_COMMITS,
} from '../../shared/deploy'
import { FREEZE_MAX_HOURS, GROUP_NAME, MAX_FREEZE_REASON, HUB_AUDIT_ACTIONS, HUB_INTEGRATION_KINDS, MAX_BULK_MEMBERS, MAX_GROUP_DESCRIPTION } from '../../shared/hub'
import { BIND_ADDRESS, MAX_BIND_ADDRESS, type TunnelInput, type TunnelPatch } from '../../shared/tunnels'
import { MAX_COLS, MAX_ROWS, MAX_WRITE_CHARS, type OpenLocalRequest, type OpenSshRequest, type PromptAnswer } from '../../shared/ssh'
import {
  AUTO_LOCK_CHOICES,
  IDENTITY_AUTHS,
  MAX_KEY_COMMENT,
  MAX_KEY_PATH,
  MAX_LABEL,
  MAX_MASTER_PASSWORD,
  MAX_PASSPHRASE,
  MAX_SECRET_NAME,
  MAX_SECRET_VALUE,
  MAX_USERNAME,
  MAX_VAULT_NAME,
  QUICK_UNLOCK_MODES,
  SECRET_KINDS,
  VAULT_COLOR,
  type IdentityInput,
  type IdentityPatch,
  type KeyGenerateInput,
  type KeyImportInput,
  type KeyLinkInput,
  type SecretInput,
  type SecretPatch,
  type VaultInput,
} from '../../shared/vault'
import {
  MAX_EMAIL,
  MAX_GIT_REF,
  MAX_RECIPIENTS,
  MAX_NOTIFY_LOG,
  NOTIFY_EVENTS,
  NOTIFY_SOURCES,
  QA_WAIT_RANGE,
  type EnvironmentIntegrationsPatch,
  type NotifyLogFilter,
  type NotifyTestTarget,
  type IntegrationSettingsPatch,
} from '../../shared/settings'
import { MAX_SERVICES, type CopyServicesRequest, type ServiceInput, type ServicePatch } from '../../shared/services'
import { MAX_PRIVATE_KEY_BYTES } from '../vault/openssh'
import { MAX_COMMANDS, MAX_NOTES_SUBJECT, type ExplainSubject, type ReleaseNotesRequest } from '../../shared/ai'
import {
  ENV_NAME,
  MAX_FLOW_STAGES,
  MAX_STEPS_PER_CHECKOUT,
  MAX_STEP_SCRIPT,
  MAX_WHEN_PATHS,
  STEP_ANCHORS,
  WHEN_PATH,
} from '../../shared/steps'
import { InvalidArgs, args, v, type ArgsValidator, type Check } from './validate'

const OUTCOMES = ['success', 'failure', 'denied', 'info'] as const

export const asFilter: Check<AuditFilter> = v.object({
  actions: v.optional(v.array(v.oneOf(AUDIT_ACTIONS), AUDIT_ACTIONS.length)),
  outcome: v.optional(v.oneOf(OUTCOMES)),
  actor: v.optional(v.str({ max: 200 })),
  targetType: v.optional(v.str({ max: 200 })),
  from: v.optional(v.str({ max: 40 })),
  to: v.optional(v.str({ max: 40 })),
  text: v.optional(v.str({ max: 200 })),
  limit: v.optional(v.int({ min: 1, max: 1000 })),
  beforeId: v.optional(v.int({ min: 1 })),
}) as Check<AuditFilter>

// Length rules (minimum, strength) are the service's: its messages are the ones the user sees.
const asPassword = v.str({ min: 1, max: MAX_MASTER_PASSWORD })
const vaultName = v.str({ min: 1, max: MAX_VAULT_NAME, trim: true })
const vaultColor = v.str({ pattern: VAULT_COLOR })

export const asVaultInput: Check<VaultInput> = v.object({ name: vaultName, color: vaultColor })
export const asVaultPatch: Check<Partial<VaultInput>> = v.object({
  name: v.optional(vaultName),
  color: v.optional(vaultColor),
})

const secretName = v.str({ min: 1, max: MAX_SECRET_NAME, trim: true })
const secretKind = v.oneOf(SECRET_KINDS)
// Not trimmed: whitespace can be part of a value.
const secretValue = v.str({ min: 1, max: MAX_SECRET_VALUE })

export const asSecretInput: Check<SecretInput> = v.object({
  vaultId: v.uuid(),
  name: secretName,
  kind: secretKind,
  value: secretValue,
})
export const asSecretPatch: Check<SecretPatch> = v.object({
  name: v.optional(secretName),
  kind: v.optional(secretKind),
  value: v.optional(secretValue),
})

const label = v.str({ min: 1, max: MAX_LABEL, trim: true })
// Not trimmed: whitespace can be part of a passphrase, password or key file.
const passphrase = v.optional(v.str({ min: 1, max: MAX_PASSPHRASE }))

export const asKeyLinkInput: Check<KeyLinkInput> = v.object({
  vaultId: v.uuid(),
  label,
  path: v.str({ min: 1, max: MAX_KEY_PATH }),
  passphrase,
})
export const asKeyImportInput: Check<KeyImportInput> = v.object({
  vaultId: v.uuid(),
  label,
  privateKey: v.str({ min: 1, max: MAX_PRIVATE_KEY_BYTES }),
  passphrase,
})
export const asKeyImportFileInput: Check<Omit<KeyImportInput, 'privateKey'>> = v.object({
  vaultId: v.uuid(),
  label,
  passphrase,
})
export const asKeyGenerateInput: Check<KeyGenerateInput> = v.object({
  vaultId: v.uuid(),
  label,
  comment: v.optional(v.str({ max: MAX_KEY_COMMENT })),
})
export const asKeyPatch: Check<{ label?: string }> = v.object({ label: v.optional(label) })

const username = v.str({ min: 1, max: MAX_USERNAME, trim: true })
const identityAuth = v.oneOf(IDENTITY_AUTHS)
const password = v.optional(v.str({ min: 1, max: MAX_SECRET_VALUE }))

export const asIdentityInput: Check<IdentityInput> = v.object({
  vaultId: v.uuid(),
  label,
  username,
  auth: identityAuth,
  sshKeyId: v.optional(v.uuid()),
  password,
})
export const asIdentityPatch: Check<IdentityPatch> = v.object({
  label: v.optional(label),
  username: v.optional(username),
  auth: v.optional(identityAuth),
  sshKeyId: v.optional(v.uuid()),
  password,
})

const hostLabel = v.str({ min: 1, max: MAX_LABEL, trim: true })
const hostAddress = v.str({ min: 1, max: MAX_ADDRESS, pattern: HOST_ADDRESS, trim: true })
const hostPort = v.nullable(v.int({ min: 1, max: 65535 }))
const nullableId = v.nullable(v.uuid())
const hostTags = v.array(v.str({ min: 1, max: MAX_TAG, pattern: TAG, trim: true }), MAX_TAGS)
const osIcon = v.oneOf(OS_ICONS)
const hostNotes = v.str({ max: MAX_NOTES })
const keepaliveSec = v.nullable(v.int({ min: 0, max: MAX_KEEPALIVE_SEC }))
// A plain record of strings; the store re-checks names, value length and characters.
const envVars: Check<Record<string, string>> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidArgs(path, 'must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_ENV_VARS) throw new InvalidArgs(path, `must have at most ${MAX_ENV_VARS} entries`)
  for (const [, item] of entries) if (typeof item !== 'string') throw new InvalidArgs(`${path}[]`, 'must be a string')
  return value as Record<string, string>
}
const membership = v.object({ environmentId: v.uuid(), role: v.oneOf(HOST_ROLES) })

export const asHostInput: Check<HostInput> = v.object({
  label: hostLabel,
  address: hostAddress,
  port: v.optional(hostPort),
  identityId: v.optional(nullableId),
  jumpHostId: v.optional(nullableId),
  tags: v.optional(hostTags),
  osIcon: v.optional(osIcon),
  notes: v.optional(hostNotes),
  keepaliveSec: v.optional(keepaliveSec),
  envVars: v.optional(envVars),
  vaultIds: v.optional(v.array(v.uuid(), MAX_LINKS)),
  environments: v.optional(v.array(membership, MAX_LINKS)),
}) as Check<HostInput>
// Links (vaults, memberships) change through their own channels.
export const asHostPatch: Check<HostPatch> = v.object({
  label: v.optional(hostLabel),
  address: v.optional(hostAddress),
  port: v.optional(hostPort),
  identityId: v.optional(nullableId),
  jumpHostId: v.optional(nullableId),
  tags: v.optional(hostTags),
  osIcon: v.optional(osIcon),
  notes: v.optional(hostNotes),
  keepaliveSec: v.optional(keepaliveSec),
  envVars: v.optional(envVars),
}) as Check<HostPatch>

/** A repo URL with a username or password is refused before any store sees it; the message never carries the value. */
const noRepoCredentials = (check: Check<string>): Check<string> => (value, path) => {
  const s = check(value, path)
  if (s.trim() !== '' && REPO_URL.test(s.trim()) && !isParsableRepoUrl(s.trim())) throw new InvalidArgs(path, 'has an invalid format')
  if (hasRepoCredentials(s.trim())) throw new InvalidArgs(path, REPO_URL_CREDENTIALS_MSG)
  return s
}
// Deploy config. Shapes and ranges only: the store owns the content rules (paths, refs, memberships).
const deployName = v.str({ min: 1, max: MAX_NAME, trim: true })
const deployPath = v.str({ min: 1, max: MAX_REPO_PATH })
const range = ([min, max]: readonly [number, number]) => v.int({ min, max })
const healthUrl = v.object({ url: v.str({ min: 1, max: MAX_HEALTH_URL }), from: v.oneOf(['host', 'mac'] as const) })
// Steps and flows. Shapes and bounds only: the stores own the content rules (names, env deny list, secret scope).
const MAX_EDITED_PLAYBOOK = 256 * 1024
const stepWhen = v.tagged('kind', {
  always: v.object({ kind: v.oneOf(['always'] as const) }),
  changed: v.object({ kind: v.oneOf(['changed'] as const) }),
  paths: v.object({ kind: v.oneOf(['paths'] as const), paths: v.array(v.str({ min: 1, max: 200, pattern: WHEN_PATH }), MAX_WHEN_PATHS) }),
})
const stepBodyFields = {
  id: v.str({ min: 1, max: 32 }),
  name: v.str({ min: 1, max: MAX_NAME }),
  run: v.oneOf(['shell', 'compose-exec'] as const),
  service: v.nullable(v.str({ min: 1, max: MAX_COMPOSE_NAME })),
  script: v.str({ min: 1, max: MAX_STEP_SCRIPT }),
  cwd: v.nullable(deployPath),
  sudo: v.oneOf(['docker', 'yes', 'no'] as const),
  timeoutSec: range(STEP_TIMEOUT_RANGE),
  onFailure: v.oneOf(['stop', 'continue'] as const),
  when: stepWhen,
  secrets: v.array(v.object({ envName: v.str({ pattern: ENV_NAME }), secretId: v.uuid() }), 10),
}
const stepBody = v.object(stepBodyFields)
const stepCheck = v.object({ ...stepBodyFields, anchor: v.oneOf(STEP_ANCHORS), alsoOnRollback: v.bool() })
const releaseFlow = v.object({
  onFailure: v.oneOf(['stop-all', 'continue-other-hosts'] as const),
  stages: v.array(
    v.tagged('kind', {
      services: v.object({ kind: v.oneOf(['services'] as const), serviceIds: v.array(v.uuid(), MAX_SERVICES) }),
      step: v.object({ kind: v.oneOf(['step'] as const), serviceId: v.uuid(), step: stepBody }),
    }),
    MAX_FLOW_STAGES,
  ),
})
const deployFields = {
  repoUrl: v.nullable(noRepoCredentials(v.str({ max: MAX_URL }))),
  composeProject: v.nullable(v.str({ max: MAX_COMPOSE_NAME })),
  repoPath: deployPath,
  defaultBranch: v.str({ min: 1, max: MAX_GIT_REF_INPUT }),
  deployTag: v.str({ min: 1, max: MAX_GIT_REF_INPUT }),
  composeFile: v.str({ max: MAX_COMPOSE_FILE_INPUT }),
  position: v.int({ min: 0, max: MAX_POSITION }),
  urls: v.array(healthUrl, MAX_URLS),
  healthStatus: range(HEALTH_STATUS_RANGE),
  healthTimeoutSec: range(HEALTH_TIMEOUT_RANGE),
  dbBackup: v.bool(),
  backupDir: v.nullable(deployPath),
  preHook: v.nullable(v.str({ max: MAX_HOOK })),
  postHook: v.nullable(v.str({ max: MAX_HOOK })),
  buildTimeoutSec: range(STEP_TIMEOUT_RANGE),
  composeTimeoutSec: range(STEP_TIMEOUT_RANGE),
  useSudo: v.oneOf(['auto', 'yes', 'no'] as const),
  becomeSecretId: nullableId,
  managedEnv: v.bool(),
  envTemplate: v.nullable(v.str({ max: MAX_ENV_TEMPLATE })),
  vaultIds: v.array(v.uuid(), MAX_LINKS),
  steps: v.array(stepCheck, MAX_STEPS_PER_CHECKOUT),
}
const deployOptional = Object.fromEntries(Object.entries(deployFields).map(([k, c]) => [k, v.optional(c as Check<unknown>)]))

export const asDeploymentInput: Check<DeploymentInput> = v.object({
  name: deployName,
  environmentId: v.uuid(),
  hostId: v.uuid(),
  ...deployOptional,
  repoPath: deployPath,
  defaultBranch: deployFields.defaultBranch,
  deployTag: deployFields.deployTag,
}) as Check<DeploymentInput>
// The environment and host are fixed at creation: they are not keys here, so a move fails validation.
export const asDeploymentPatch: Check<DeploymentPatch> = v.object({
  name: v.optional(deployName),
  ...deployOptional,
}) as Check<DeploymentPatch>
export const asEnvDeploySettingsPatch: Check<EnvDeploySettingsPatch> = v.object({
  versioned: v.optional(v.bool()),
  autoRollback: v.optional(v.bool()),
  currentVersion: v.optional(v.nullable(v.str({ max: 64, pattern: VERSION }))),
  parallelPrepare: v.optional(v.bool()),
  prepareCap: v.optional(v.int({ min: 1, max: 8 })),
  flow: v.optional(v.nullable(releaseFlow)),
}) as Check<EnvDeploySettingsPatch>
export const asDeployBatch: Check<DeployBatch> = v.object({
  settings: v.optional(asEnvDeploySettingsPatch),
  deployments: v.array(v.object({ id: v.uuid(), patch: asDeploymentPatch }), MAX_DEPLOYMENTS),
}) as Check<DeployBatch>
export const asPreflightRequest: Check<PreflightRequest> = v.object({
  environmentId: v.uuid(),
  serviceIds: v.array(v.uuid(), MAX_SERVICES),
  checkoutIds: v.optional(v.array(v.uuid(), MAX_DEPLOYMENTS)),
  bump: v.oneOf(['major', 'minor', 'patch', 'none'] as const),
  options: v.object({ backup: v.bool(), notify: v.bool(), qa: v.bool() }),
  releaseNotes: v.optional(v.str({ max: MAX_RELEASE_NOTES })),
}) as Check<PreflightRequest>
export const asReleaseConfirm: Check<ReleaseConfirm> = v.object({
  typedName: v.optional(v.str({ max: MAX_NAME })),
  redeploy: v.optional(v.bool()),
  playbookSha256: v.optional(v.str({ pattern: PLAYBOOK_SHA256 })),
  editedPlaybook: v.optional(v.str({ max: MAX_EDITED_PLAYBOOK })),
  forceServiceIds: v.optional(v.array(v.uuid(), MAX_SERVICES, { min: 1 })),
}) as Check<ReleaseConfirm>
export const asBreakLockConfirm: Check<BreakLockConfirm> = v.object({ typedLabel: v.str({ max: MAX_NAME }) }) as Check<BreakLockConfirm>
export const asReleaseListFilter: Check<ReleaseListFilter> = v.object({
  environmentId: v.optional(v.uuid()),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  before: v.optional(v.uuid()),
  operations: v.optional(v.oneOf(['only', 'exclude'] as const)),
}) as Check<ReleaseListFilter>

// Runbooks. The shape only: the store owns the content rules (targets in the environment, a step's secrets, once-only
// built-ins, a param's pattern), so a well-shaped but wrong runbook fails there with VALIDATION.
const MAX_PARAM_VALUE = 1000
const runbookItem = v.tagged('type', {
  step: v.object({ type: v.oneOf(['step'] as const), step: stepBody }),
  builtin: v.object({
    type: v.oneOf(['builtin'] as const),
    builtin: v.oneOf(BUILTINS),
    tail: v.optional(v.int({ min: 1, max: LOG_TAIL_MAX })),
    untilHours: v.optional(v.int({ min: 1, max: MAX_UNTIL_HOURS })),
  }),
})
const runbookParam = v.object({
  name: v.str({ pattern: VARIABLE_NAME }),
  label: v.str({ min: 1, max: 64 }),
  type: v.oneOf(['text', 'choice'] as const),
  pattern: v.oneOf(['identifier', 'number', 'path', 'free'] as const),
  choices: v.array(v.str({ min: 1, max: 100 }), 50),
})
export const asRunbookSaveInput: Check<RunbookSaveInput> = v.object({
  id: v.optional(v.uuid()),
  environmentId: v.uuid(),
  name: v.str({ min: 1, max: MAX_RUNBOOK_NAME }),
  description: v.str({ max: MAX_RUNBOOK_DESCRIPTION }),
  targetServiceIds: v.array(v.uuid(), MAX_SERVICES, { min: 1 }),
  items: v.array(runbookItem, MAX_STEPS_PER_CHECKOUT, { min: 1 }),
  params: v.array(runbookParam, MAX_PARAMS),
  lock: v.bool(),
  notify: v.bool(),
}) as Check<RunbookSaveInput>
export const asOperationRequest: Check<OperationRequest> = v.object({
  environmentId: v.uuid(),
  runbookId: v.uuid(),
  serviceIds: v.array(v.uuid(), MAX_SERVICES, { min: 1 }),
  params: v.record(VARIABLE_NAME, v.str({ max: MAX_PARAM_VALUE }), { maxKeys: MAX_PARAMS }),
}) as Check<OperationRequest>

// Services. Each kind's shape has only its own keys, so a field of the other kind fails here; the store owns the
// content rules (compose service, address, membership of the checkout).
const serviceCommon = {
  environmentId: v.uuid(),
  name: deployName,
  description: v.optional(v.str({ max: MAX_DESCRIPTION })),
}
const servicePort = v.int({ min: 1, max: 65535 })
const appServiceFields = {
  deploymentId: nullableId,
  composeService: v.str({ min: 1, max: MAX_COMPOSE_NAME }),
  url: v.nullable(v.str({ max: MAX_URL })),
  urlCheckFrom: v.oneOf(['mac', 'host'] as const),
  skipUnchanged: v.bool(),
}
const dbServiceFields = {
  dbEngine: v.oneOf(['postgres', 'mysql', 'mongodb', 'redis', 'other'] as const),
  dbAddress: v.str({ min: 1, max: MAX_ADDRESS }),
  dbPort: servicePort,
  viaHostId: nullableId,
  localPort: v.nullable(servicePort),
}
export const asServiceInput: Check<ServiceInput> = v.tagged('kind', {
  service: v.object({
    kind: v.oneOf(['service'] as const),
    ...serviceCommon,
    deploymentId: nullableId,
    composeService: v.optional(appServiceFields.composeService),
    url: v.optional(appServiceFields.url),
    urlCheckFrom: v.optional(appServiceFields.urlCheckFrom),
    skipUnchanged: v.optional(appServiceFields.skipUnchanged),
  }),
  db: v.object({
    kind: v.oneOf(['db'] as const),
    ...serviceCommon,
    dbEngine: dbServiceFields.dbEngine,
    dbAddress: dbServiceFields.dbAddress,
    dbPort: v.optional(dbServiceFields.dbPort),
    viaHostId: v.optional(dbServiceFields.viaHostId),
    localPort: v.optional(dbServiceFields.localPort),
  }),
}) as Check<ServiceInput>
// The patch can't know the kind: both kinds' keys are allowed here and the store refuses the other kind's. The kind
// and environment are not keys, so changing them fails validation.
export const asServicePatch: Check<ServicePatch> = v.object({
  name: v.optional(deployName),
  description: serviceCommon.description,
  ...Object.fromEntries(Object.entries({ ...appServiceFields, ...dbServiceFields }).map(([k, c]) => [k, v.optional(c as Check<unknown>)])),
}) as Check<ServicePatch>

// Content rules (model pattern, secret kinds, email syntax, repo shape) are the stores': their messages name the rule.
const nullableSecretId = v.nullable(v.uuid())
export const asSettingsPatch: Check<IntegrationSettingsPatch> = v.object({
  aiModel: v.optional(v.str({ min: 1, max: 80 })),
  aiApiKeySecretId: v.optional(nullableSecretId),
  sendgridApiKeySecretId: v.optional(nullableSecretId),
  sendgridFrom: v.optional(v.nullable(v.str({ max: MAX_EMAIL }))),
  githubTokenSecretId: v.optional(nullableSecretId),
  macos: v.optional(v.bool()),
  macosUnscoped: v.optional(v.bool()),
}) as Check<IntegrationSettingsPatch>

const recipients = v.array(v.str({ min: 1, max: MAX_EMAIL }), MAX_RECIPIENTS)
export const asIntegrationPatch: Check<EnvironmentIntegrationsPatch> = v.object({
  notifyEvents: v.optional(v.array(v.oneOf(NOTIFY_EVENTS), NOTIFY_EVENTS.length)),
  teamsWebhookSecretId: v.optional(nullableSecretId),
  emailTo: v.optional(recipients),
  emailCc: v.optional(recipients),
  qaOnDeploy: v.optional(v.bool()),
  qa: v.optional(
    v.nullable(v.object({ repo: v.str({ min: 1, max: 201 }), workflow: v.str({ min: 1, max: 210 }), ref: v.str({ max: MAX_GIT_REF + 10 }), waitMinutes: v.optional(range(QA_WAIT_RANGE)) })),
  ),
  qaWait: v.optional(v.bool()),
}) as Check<EnvironmentIntegrationsPatch>

export const asNotifyTestTarget: Check<NotifyTestTarget> = v.tagged('channel', {
  teams: v.object({ channel: v.oneOf(['teams'] as const), environmentId: v.uuid() }),
  email: v.object({ channel: v.oneOf(['email'] as const), environmentId: v.uuid() }),
  macos: v.object({ channel: v.oneOf(['macos'] as const) }),
}) as Check<NotifyTestTarget>

export const asNotifyLogFilter: Check<NotifyLogFilter> = v.object({
  sourceType: v.optional(v.oneOf(NOTIFY_SOURCES)),
  sourceId: v.optional(v.str({ min: 1, max: 64 })),
  environmentId: v.optional(v.uuid()),
  limit: v.optional(v.int({ min: 1, max: MAX_NOTIFY_LOG })),
}) as Check<NotifyLogFilter>

export const asReleaseNotesRequest: Check<ReleaseNotesRequest> = v.object({
  environmentId: v.uuid(),
  productName: v.nullable(v.str({ max: 200 })),
  deployments: v.array(v.object({ id: v.uuid(), name: v.str({ min: 1, max: 200 }) }), 200),
  version: v.nullable(v.str({ max: 200 })),
  commits: v.array(
    v.object({
      sha: v.str({ max: 64 }),
      subject: v.str({ max: MAX_NOTES_SUBJECT }),
      author: v.str({ max: 400 }),
      date: v.str({ max: 64 }),
      deploymentId: v.uuid(),
    }),
    MAX_COMMITS,
  ),
}) as Check<ReleaseNotesRequest>

export const asExplainSubject: Check<ExplainSubject> = v.tagged('kind', {
  release: v.object({ kind: v.oneOf(['release'] as const), releaseId: v.uuid(), stepId: v.str({ min: 1, max: 200 }) }),
  session: v.object({ kind: v.oneOf(['session'] as const), sessionId: v.uuid() }),
  tunnel: v.object({ kind: v.oneOf(['tunnel'] as const), tunnelId: v.uuid() }),
}) as Check<ExplainSubject>

export const asCopyServicesRequest: Check<CopyServicesRequest> = v.object({
  sourceEnvironmentId: v.uuid(),
  targetEnvironmentId: v.uuid(),
  checkouts: v.array(
    v.object({
      deploymentId: v.uuid(),
      branch: deployFields.defaultBranch,
      repoPath: deployPath,
      hostId: v.uuid(),
      deployTag: deployFields.deployTag,
    }),
    MAX_DEPLOYMENTS,
  ),
  dbs: v.array(
    v.object({ serviceId: v.uuid(), dbAddress: dbServiceFields.dbAddress, dbPort: servicePort, viaHostId: nullableId }),
    MAX_SERVICES,
  ),
}) as Check<CopyServicesRequest>

const tunnelBindAddress = v.str({ min: 1, max: MAX_BIND_ADDRESS, pattern: BIND_ADDRESS, trim: true })
const tunnelBindPort = v.int({ min: 0, max: 65535 })
const tunnelTargetPort = v.int({ min: 1, max: 65535 })

// The store re-checks the cross-field rules (target present exactly for L and R).
export const asTunnelInput: Check<TunnelInput> = v.object({
  label: hostLabel,
  hostId: v.uuid(),
  environmentId: v.optional(v.uuid()),
  type: v.oneOf(['L', 'R', 'D'] as const),
  bindAddress: v.optional(tunnelBindAddress),
  bindPort: tunnelBindPort,
  targetHost: v.optional(hostAddress),
  targetPort: v.optional(tunnelTargetPort),
  autoStart: v.optional(v.bool()),
  autoReconnect: v.optional(v.bool()),
}) as Check<TunnelInput>
export const asTunnelPatch: Check<TunnelPatch> = v.object({
  label: v.optional(hostLabel),
  hostId: v.optional(v.uuid()),
  environmentId: v.optional(nullableId),
  type: v.optional(v.oneOf(['L', 'R', 'D'] as const)),
  bindAddress: v.optional(tunnelBindAddress),
  bindPort: v.optional(tunnelBindPort),
  targetHost: v.optional(v.nullable(hostAddress)),
  targetPort: v.optional(v.nullable(tunnelTargetPort)),
  autoStart: v.optional(v.bool()),
  autoReconnect: v.optional(v.bool()),
}) as Check<TunnelPatch>

const envName = v.str({ min: 1, max: MAX_NAME, trim: true })
const envColor = v.str({ pattern: VAULT_COLOR })
const envPort = v.nullable(v.int({ min: 1, max: 65535 }))
const idList = v.array(v.uuid(), MAX_LINKS)
/** Names the path and the rule, never the value. A blank string clears the field, as in the store. */
const envDomain: Check<string | null> = v.nullable((value, path) => {
  if (typeof value !== 'string') throw new InvalidArgs(path, 'must be a string')
  if (value.length > MAX_URL || (value.trim() !== '' && !parseEnvDomain(value).ok)) {
    throw new InvalidArgs(path, 'must be a domain or http(s) URL')
  }
  return value
})

export const asEnvironmentInput: Check<EnvironmentInput> = v.object({
  name: envName,
  color: envColor,
  protected: v.optional(v.bool()),
  defaultIdentityId: v.optional(nullableId),
  defaultPort: v.optional(envPort),
  defaultJumpHostId: v.optional(nullableId),
  domain: v.optional(envDomain),
  productIds: v.optional(idList),
}) as Check<EnvironmentInput>

export const asEnvironmentPatch: Check<EnvironmentPatch> = v.object({
  name: v.optional(envName),
  color: v.optional(envColor),
  protected: v.optional(v.bool()),
  defaultIdentityId: v.optional(nullableId),
  defaultPort: v.optional(envPort),
  defaultJumpHostId: v.optional(nullableId),
  domain: v.optional(envDomain),
}) as Check<EnvironmentPatch>

const productIcon = v.oneOf(PRODUCT_ICONS)
const repoUrl = v.optional(v.nullable(noRepoCredentials(v.str({ max: MAX_URL, pattern: REPO_URL }))))
const description = v.str({ max: MAX_DESCRIPTION })

export const asProductInput: Check<ProductInput> = v.object({
  name: envName,
  color: envColor,
  icon: productIcon,
  description: v.optional(description),
  repoUrl,
}) as Check<ProductInput>

export const asProductPatch: Check<ProductPatch> = v.object({
  name: v.optional(envName),
  color: v.optional(envColor),
  icon: v.optional(productIcon),
  description: v.optional(description),
  repoUrl,
}) as Check<ProductPatch>

// Aliases only: the importer re-reads the config itself, so no config text crosses IPC.
export const asSshImportRequest: Check<SshImportRequest> = v.object({
  vaultId: v.uuid(),
  aliases: v.array(v.str({ min: 1, max: MAX_LABEL }), MAX_IMPORT_ALIASES),
  environmentId: v.optional(v.uuid()),
  role: v.optional(v.oneOf(HOST_ROLES)),
  forwards: v.optional(v.bool()),
}) as Check<SshImportRequest>

const cols = v.int({ min: 1, max: MAX_COLS })
const rows = v.int({ min: 1, max: MAX_ROWS })

// Defence in depth: the ref is also shell-quoted as one word wherever it is sent.
const containerRef = v.str({ pattern: CONTAINER_REF })

export const asOpenSshRequest: Check<OpenSshRequest> = v.object({
  hostId: v.uuid(),
  environmentId: v.optional(v.uuid()),
  cols,
  rows,
  container: v.optional(containerRef),
}) as Check<OpenSshRequest>

export const asOpenLocalRequest: Check<OpenLocalRequest> = v.object({ cols, rows }) as Check<OpenLocalRequest>

// More than any real keyboard-interactive round asks.
const MAX_KEYBOARD_PROMPTS = 32
// Typed by the user: not trimmed, and empty is allowed. null cancels.
const typed = v.str({ max: MAX_SECRET_VALUE })
const ANSWERS: Record<PromptAnswer['kind'], Check<PromptAnswer>> = {
  'host-key': v.object({ kind: v.oneOf(['host-key'] as const), trust: v.bool() }) as Check<PromptAnswer>,
  password: v.object({ kind: v.oneOf(['password'] as const), password: v.nullable(typed) }) as Check<PromptAnswer>,
  keyboard: v.object({
    kind: v.oneOf(['keyboard'] as const),
    responses: v.nullable(v.array(typed, MAX_KEYBOARD_PROMPTS)),
  }) as Check<PromptAnswer>,
}
export const asPromptAnswer: Check<PromptAnswer> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidArgs(path, 'must be an object')
  const kind = (value as { kind?: unknown }).kind
  const check = typeof kind === 'string' && Object.hasOwn(ANSWERS, kind) ? ANSWERS[kind as PromptAnswer['kind']] : null
  if (!check) throw new InvalidArgs(`${path}.kind`, 'is not an allowed value')
  return check(value, path)
}

// No NUL in anything that reaches a remote shell or a comparison.
const NO_NUL = /^[^\0]*$/
// Values are not trimmed: whitespace can be part of a value. The store re-checks control characters.
const variableValue = v.str({ max: MAX_VARIABLE_VALUE, pattern: NO_NUL })
const variableValues = v.record(VARIABLE_NAME, variableValue, { maxKeys: MAX_VARIABLES })

// Scripts are not trimmed: they are sent as written. The store derives variables and re-checks tags.
export const asSnippetInput: Check<SnippetInput> = v.object({
  label: hostLabel,
  script: v.str({ min: 1, max: MAX_SCRIPT }),
  description: v.optional(v.str({ max: MAX_SNIPPET_DESCRIPTION })),
  tags: v.optional(hostTags),
  defaults: v.optional(v.record(VARIABLE_NAME, v.nullable(variableValue), { maxKeys: MAX_VARIABLES })),
  destructive: v.optional(v.bool()),
}) as Check<SnippetInput>

const runTarget = v.tagged('kind', {
  hosts: v.object({
    kind: v.oneOf(['hosts'] as const),
    hostIds: v.array(v.uuid(), MAX_RUN_TARGETS, { min: 1 }),
    environmentId: v.optional(v.uuid()),
  }),
  environment: v.object({
    kind: v.oneOf(['environment'] as const),
    environmentId: v.uuid(),
    role: v.optional(v.oneOf(HOST_ROLES)),
  }),
})
const runCommand = v.tagged('kind', {
  // Typed shell input, sent as-is: not trimmed.
  text: v.object({ kind: v.oneOf(['text'] as const), text: v.str({ min: 1, max: MAX_COMMAND, pattern: NO_NUL }) }),
  snippet: v.object({ kind: v.oneOf(['snippet'] as const), snippetId: v.uuid(), values: variableValues }),
})
// The typed environment name; compared exactly, so not trimmed.
const confirmName = v.optional(v.str({ max: MAX_NAME, pattern: NO_NUL }))
const importToken = v.str({ pattern: /^[0-9a-f]{32}$/ })
/** One per protected environment a preview can list. */
const MAX_TYPED_NAMES = 1000

export const asRunRequest: Check<RunRequest> = v.object({
  target: runTarget,
  command: runCommand,
  concurrency: v.optional(v.int({ min: 1, max: MAX_CONCURRENCY })),
  timeoutSec: v.optional(v.int({ min: 1, max: MAX_RUN_TIMEOUT_SEC })),
  confirm: confirmName,
}) as Check<RunRequest>

const logTail = v.int({ min: 0, max: LOG_TAIL_MAX })

// ---- Hub (Phase 10) ----
const HUB_ACTIONS = ['deploy.view', 'deploy.edit', 'release.start', 'release.rollback', 'release.cancel', 'lock.break', 'env.lock', 'admin'] as const
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** https, or http to a loopback host; no credentials. Errors name the path only, never the URL. */
const hubUrl: Check<string> = (value, path) => {
  const s = v.str({ min: 1, max: 2048, trim: true })(value, path)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new InvalidArgs(path, 'must be a URL')
  }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)))) {
    throw new InvalidArgs(path, 'must be an https URL (http only for localhost)')
  }
  if (u.username || u.password) throw new InvalidArgs(path, 'must not contain credentials')
  return s
}
const hubId = v.str({ min: 1, max: 100 })
const asHubAccessTarget = v.object({ environmentId: v.uuid(), deploymentIds: v.optional(v.array(v.uuid(), 200)) })
const asHubUserPatch = v.object({ role: v.optional(v.oneOf(['admin', 'maintainer'] as const)), disabled: v.optional(v.bool()) })
const asHubGroupInput = v.object({
  name: v.str({ pattern: GROUP_NAME }),
  description: v.optional(v.str({ max: MAX_GROUP_DESCRIPTION })),
})
const asHubGroupPatch = v.object({
  name: v.optional(v.str({ pattern: GROUP_NAME })),
  description: v.optional(v.str({ max: MAX_GROUP_DESCRIPTION })),
})
const asGrantScope = v.tagged('kind', {
  all: v.object({ kind: v.oneOf(['all'] as const) }),
  environment: v.object({ kind: v.oneOf(['environment'] as const), environmentId: v.uuid() }),
  deployment: v.object({ kind: v.oneOf(['deployment'] as const), environmentId: v.uuid(), deploymentId: v.uuid() }),
})
const asHubAuditFilter = v.object({
  actions: v.optional(v.array(v.oneOf(HUB_AUDIT_ACTIONS), HUB_AUDIT_ACTIONS.length)),
  actorOid: v.optional(hubId),
  outcome: v.optional(v.oneOf(['success', 'failure', 'denied', 'info'] as const)),
  from: v.optional(v.str({ max: 40 })),
  to: v.optional(v.str({ max: 40 })),
  beforeId: v.optional(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  limit: v.optional(v.int({ min: 1, max: 1000 })),
})

/** Every channel must have an entry; each later task adds its own. */
export const VALIDATORS: { [K in Channel]: ArgsValidator<IpcContract[K]['args']> } = {
  'app:info': args(),
  'audit:list': args(asFilter),
  'audit:verify': args(),
  'audit:exportCsv': args(asFilter),
  'vault:status': args(),
  'vault:setup': args(asPassword),
  'vault:unlock': args(asPassword),
  'vault:unlockQuick': args(),
  'vault:lock': args(),
  'vault:changePassword': args(asPassword, asPassword),
  'vault:list': args(),
  'vault:create': args(asVaultInput),
  'vault:update': args(v.uuid(), asVaultPatch),
  'vault:delete': args(v.uuid()),
  'vault:setQuickUnlock': args(v.oneOf(QUICK_UNLOCK_MODES)),
  'vault:setAutoLock': args(v.oneOf(AUTO_LOCK_CHOICES)),
  // The service checks the word itself, so its message is the one the user sees.
  'vault:reset': args(v.str({ max: 64 })),
  'secret:list': args(v.optional(v.uuid())),
  'secret:create': args(asSecretInput),
  'secret:update': args(v.uuid(), asSecretPatch),
  'secret:delete': args(v.uuid()),
  'secret:reveal': args(v.uuid()),
  'secret:copy': args(v.uuid()),
  'key:list': args(v.optional(v.uuid())),
  'key:scanLocal': args(),
  'key:link': args(asKeyLinkInput),
  'key:import': args(asKeyImportInput),
  'key:importFile': args(asKeyImportFileInput),
  'key:generate': args(asKeyGenerateInput),
  'key:update': args(v.uuid(), asKeyPatch),
  'key:delete': args(v.uuid()),
  'key:copyPublic': args(v.uuid()),
  'identity:list': args(v.optional(v.uuid())),
  'identity:create': args(asIdentityInput),
  'identity:update': args(v.uuid(), asIdentityPatch),
  'identity:delete': args(v.uuid()),
  'host:list': args(),
  'host:create': args(asHostInput),
  'host:update': args(v.uuid(), asHostPatch),
  'host:delete': args(v.uuid()),
  'host:setVaults': args(v.uuid(), v.array(v.uuid(), MAX_LINKS)),
  'host:resolve': args(v.uuid(), v.optional(v.uuid())),
  'env:list': args(),
  'env:create': args(asEnvironmentInput),
  'env:update': args(v.uuid(), asEnvironmentPatch),
  'env:delete': args(v.uuid()),
  'env:openDomain': args(v.uuid()),
  'env:setProducts': args(v.uuid(), idList),
  'env:putHost': args(v.uuid(), v.uuid(), v.oneOf(HOST_ROLES)),
  'env:removeHost': args(v.uuid(), v.uuid()),
  'product:list': args(),
  'product:create': args(asProductInput),
  'product:update': args(v.uuid(), asProductPatch),
  'product:delete': args(v.uuid()),
  'sshconfig:preview': args(),
  'sshconfig:import': args(asSshImportRequest),
  'ssh:open': args(asOpenSshRequest),
  'shell:open': args(asOpenLocalRequest),
  'session:reconnect': args(v.uuid()),
  'session:write': args(v.uuid(), v.str({ max: MAX_WRITE_CHARS })),
  'session:resize': args(v.uuid(), cols, rows),
  'session:close': args(v.uuid()),
  'session:list': args(),
  'session:attach': args(v.uuid()),
  'session:answer': args(v.uuid(), asPromptAnswer),
  'session:prompts': args(),
  'knownhost:list': args(),
  'knownhost:remove': args(v.uuid()),
  'tunnel:list': args(),
  'tunnel:create': args(asTunnelInput),
  'tunnel:update': args(v.uuid(), asTunnelPatch),
  'tunnel:delete': args(v.uuid()),
  'tunnel:start': args(v.uuid()),
  'tunnel:stop': args(v.uuid()),
  'tunnel:status': args(),
  'deploy:list': args(v.optional(v.uuid())),
  'deploy:create': args(asDeploymentInput),
  'deploy:update': args(v.uuid(), asDeploymentPatch),
  'deploy:delete': args(v.uuid()),
  'deploy:reorder': args(v.uuid(), v.array(v.uuid(), MAX_DEPLOYMENTS)),
  'deploy:settings': args(v.uuid()),
  'deploy:updateSettings': args(v.uuid(), asEnvDeploySettingsPatch),
  'deploy:applyBatch': args(v.uuid(), asDeployBatch),
  'deploy:tooling': args(),
  'service:list': args(v.optional(v.uuid())),
  'service:create': args(asServiceInput),
  'service:update': args(v.uuid(), asServicePatch),
  'service:delete': args(v.uuid(), v.object({ deleteTunnel: v.bool() })),
  'service:reorder': args(v.uuid(), v.array(v.uuid(), MAX_SERVICES)),
  'service:copy': args(asCopyServicesRequest),
  'settings:get': args(),
  'settings:update': args(asSettingsPatch),
  'settings:status': args(),
  'integration:get': args(v.uuid()),
  'integration:update': args(v.uuid(), asIntegrationPatch),
  'notify:test': args(asNotifyTestTarget),
  'notify:log': args(asNotifyLogFilter),
  'qa:dispatch': args(v.uuid()),
  'qa:list': args(),
  'ai:status': args(),
  'ai:cancel': args(v.uuid()),
  'ai:releaseNotes': args(v.uuid(), asReleaseNotesRequest),
  'ai:explain': args(v.uuid(), asExplainSubject),
  'ai:command': args(v.uuid(), v.int({ min: 0, max: MAX_COMMANDS - 1 }), v.oneOf(['copy', 'run'] as const)),
  'service:logs': args(v.uuid(), logTail),
  'service:open': args(v.uuid()),
  'service:tunnelOpen': args(v.uuid()),
  'service:tunnelClose': args(v.uuid()),
  'service:tunnelSync': args(v.uuid()),
  'release:preflight': args(asPreflightRequest),
  'release:preflightOperation': args(asOperationRequest),
  'deploy:previewPlaybook': args(v.uuid(), v.optional(v.array(v.uuid(), MAX_SERVICES, { min: 1 }))),
  'deploy:savePlaybook': args(v.uuid(), v.str({ pattern: PLAYBOOK_SHA256 })),
  'release:savePlaybook': args(v.uuid()),
  'release:start': args(v.uuid(), asReleaseConfirm),
  'release:cancel': args(v.uuid()),
  'release:rollback': args(v.uuid(), asReleaseConfirm),
  'release:break-lock': args(v.uuid(), v.uuid(), asBreakLockConfirm),
  'release:discard': args(v.uuid()),
  'release:set-notes': args(v.uuid(), v.str({ max: MAX_RELEASE_NOTES })),
  'release:retry-version': args(v.uuid()),
  'release:list': args(asReleaseListFilter),
  'release:get': args(v.uuid()),
  'release:events': args(v.uuid(), v.int({ min: 0, max: Number.MAX_SAFE_INTEGER }), v.optional(v.int({ min: 1, max: MAX_EVENTS_PAGE }))),
  'release:active': args(),
  'release:latest': args(),
  'runbook:list': args(v.uuid()),
  'runbook:save': args(asRunbookSaveInput),
  'runbook:delete': args(v.uuid()),
  'hub:status': args(),
  'hub:connect': args(hubUrl),
  'hub:signIn': args(),
  'hub:cancelSignIn': args(),
  'hub:signOut': args(),
  'hub:unlink': args(),
  'hub:me': args(),
  'hub:access': args(v.oneOf(HUB_ACTIONS), asHubAccessTarget),
  'hub:users': args(),
  'hub:updateUser': args(v.uuid(), asHubUserPatch),
  'hub:groups': args(),
  'hub:createGroup': args(asHubGroupInput),
  'hub:updateGroup': args(v.uuid(), asHubGroupPatch),
  'hub:deleteGroup': args(v.uuid()),
  'hub:addMembers': args(v.uuid(), v.array(v.uuid(), MAX_BULK_MEMBERS, { min: 1 })),
  'hub:removeMember': args(v.uuid(), v.uuid()),
  'hub:addGrant': args(v.uuid(), asGrantScope),
  'hub:removeGrant': args(v.uuid()),
  'hub:audit': args(asHubAuditFilter),
  'hub:verifyAudit': args(),
  'hub:catalog': args(),
  'hub:publish': args(v.uuid()),
  'hub:unpublish': args(v.uuid()),
  'hub:adminEnvironments': args(),
  'hub:secrets': args(v.nullable(v.uuid())),
  'hub:uploadSecrets': args(v.uuid(), v.optional(v.array(v.uuid(), 200, { min: 1 }))),
  'hub:setIntegrationSecret': args(v.nullable(v.uuid()), v.oneOf(HUB_INTEGRATION_KINDS), v.uuid()),
  'hub:deleteSecret': args(v.uuid(), v.nullable(v.uuid())),
  'hub:deployKey': args(v.uuid(), v.bool()),
  'hub:locks': args(),
  'hub:freeze': args(v.uuid(), v.str({ max: MAX_FREEZE_REASON }), v.nullable(v.int({ min: 1, max: FREEZE_MAX_HOURS }))),
  'hub:unfreeze': args(v.uuid(), v.nullable(v.str({ max: 200 }))),
  'snippets:list': args(),
  'snippets:create': args(asSnippetInput),
  'snippets:update': args(v.uuid(), asSnippetInput),
  'snippets:delete': args(v.uuid()),
  'snippets:render': args(v.uuid(), variableValues),
  'runs:start': args(asRunRequest),
  'runs:cancel': args(v.uuid()),
  'runs:list': args(),
  'runs:get': args(v.uuid()),
  'runs:dismiss': args(v.uuid()),
  'containers:list': args(v.uuid(), nullableId),
  'containers:action': args(v.uuid(), nullableId, containerRef, v.oneOf(CONTAINER_ACTIONS), confirmName),
  'containers:logs': args(v.uuid(), nullableId, containerRef, logTail),
  'containers:follow': args(v.uuid(), nullableId, containerRef, logTail),
  'containers:unfollow': args(v.uuid()),
  'config:export': args(),
  'config:importOpen': args(),
  'config:importApply': args(importToken, v.object({ typedNames: v.array(v.str({ max: MAX_NAME, pattern: NO_NUL }), MAX_TYPED_NAMES) })),
  'config:importDiscard': args(importToken),
}
