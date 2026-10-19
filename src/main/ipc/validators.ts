import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
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
  OS_ICONS,
  PRODUCT_ICONS,
  REPO_URL,
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
  MAX_HOOK,
  MAX_URL as MAX_HEALTH_URL,
  MAX_URLS,
  VERSION,
  type AppInput,
  type AppPatch,
  type DeploymentInput,
  type DeploymentPatch,
  type EnvDeploySettingsPatch,
  type HealthUrl,
} from '../../shared/deploy'
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
import { MAX_PRIVATE_KEY_BYTES } from '../vault/openssh'
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

// Deploy config. Shapes and ranges only: the store owns the content rules (paths, refs, memberships).
const deployName = v.str({ min: 1, max: MAX_NAME, trim: true })
const deployPath = v.str({ min: 1, max: 1024 })
const healthUrl = v.object({ url: v.str({ min: 1, max: MAX_HEALTH_URL }), from: v.oneOf(['host', 'mac'] as const) })
const deployFields = {
  appId: v.optional(nullableId),
  repoPath: deployPath,
  defaultBranch: v.str({ min: 1, max: 255 }),
  deployTag: v.str({ min: 1, max: 255 }),
  composeFile: v.str({ min: 1, max: 255 }),
  position: v.int({ min: 0, max: 1_000_000 }),
  urls: v.array(healthUrl, MAX_URLS),
  healthStatus: v.int({ min: 100, max: 599 }),
  healthTimeoutSec: v.int({ min: 5, max: 600 }),
  dbBackup: v.bool(),
  backupDir: v.nullable(deployPath),
  preHook: v.nullable(v.str({ max: MAX_HOOK })),
  postHook: v.nullable(v.str({ max: MAX_HOOK })),
  buildTimeoutSec: v.int({ min: 10, max: 3600 }),
  composeTimeoutSec: v.int({ min: 10, max: 3600 }),
  useSudo: v.oneOf(['auto', 'yes', 'no'] as const),
  becomeSecretId: nullableId,
  managedEnv: v.bool(),
  envTemplate: v.nullable(v.str({ max: MAX_ENV_TEMPLATE })),
  vaultIds: v.array(v.uuid(), MAX_LINKS),
}
const { appId: _appId, ...deployRest } = deployFields
void _appId
const deployOptional = Object.fromEntries(Object.entries(deployRest).map(([k, c]) => [k, v.optional(c as Check<unknown>)]))

export const asDeploymentInput: Check<DeploymentInput> = v.object({
  name: deployName,
  environmentId: v.uuid(),
  hostId: v.uuid(),
  appId: v.optional(nullableId),
  ...deployOptional,
  repoPath: deployPath,
  defaultBranch: deployFields.defaultBranch,
  deployTag: deployFields.deployTag,
}) as Check<DeploymentInput>
// The environment and host are fixed at creation: they are not keys here, so a move fails validation.
export const asDeploymentPatch: Check<DeploymentPatch> = v.object({
  name: v.optional(deployName),
  appId: v.optional(nullableId),
  ...deployOptional,
}) as Check<DeploymentPatch>
export const asEnvDeploySettingsPatch: Check<EnvDeploySettingsPatch> = v.object({
  versioned: v.optional(v.bool()),
  autoRollback: v.optional(v.bool()),
  currentVersion: v.optional(v.nullable(v.str({ max: 64, pattern: VERSION }))),
}) as Check<EnvDeploySettingsPatch>
const appName = v.str({ min: 1, max: MAX_NAME, trim: true })
const composeProject = v.nullable(v.str({ min: 1, max: 63 }))
const appDescription = v.str({ max: 1000 })
export const asAppInput: Check<AppInput> = v.object({
  environmentId: v.uuid(),
  hostId: v.uuid(),
  name: appName,
  composeProject: v.optional(composeProject),
  description: v.optional(appDescription),
}) as Check<AppInput>
export const asAppPatch: Check<AppPatch> = v.object({
  name: v.optional(appName),
  composeProject: v.optional(composeProject),
  description: v.optional(appDescription),
}) as Check<AppPatch>

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

export const asEnvironmentInput: Check<EnvironmentInput> = v.object({
  name: envName,
  color: envColor,
  protected: v.optional(v.bool()),
  defaultIdentityId: v.optional(nullableId),
  defaultPort: v.optional(envPort),
  defaultJumpHostId: v.optional(nullableId),
  productIds: v.optional(idList),
}) as Check<EnvironmentInput>

export const asEnvironmentPatch: Check<EnvironmentPatch> = v.object({
  name: v.optional(envName),
  color: v.optional(envColor),
  protected: v.optional(v.bool()),
  defaultIdentityId: v.optional(nullableId),
  defaultPort: v.optional(envPort),
  defaultJumpHostId: v.optional(nullableId),
}) as Check<EnvironmentPatch>

const productIcon = v.oneOf(PRODUCT_ICONS)
const repoUrl = v.optional(v.nullable(v.str({ max: MAX_URL, pattern: REPO_URL })))
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

export const asRunRequest: Check<RunRequest> = v.object({
  target: runTarget,
  command: runCommand,
  concurrency: v.optional(v.int({ min: 1, max: MAX_CONCURRENCY })),
  timeoutSec: v.optional(v.int({ min: 1, max: MAX_RUN_TIMEOUT_SEC })),
  confirm: confirmName,
}) as Check<RunRequest>

const logTail = v.int({ min: 0, max: LOG_TAIL_MAX })

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
  'app:list': args(v.optional(v.uuid())),
  'app:create': args(asAppInput),
  'app:update': args(v.uuid(), asAppPatch),
  'app:delete': args(v.uuid()),
  'deploy:list': args(v.optional(v.uuid())),
  'deploy:create': args(asDeploymentInput),
  'deploy:update': args(v.uuid(), asDeploymentPatch),
  'deploy:delete': args(v.uuid()),
  'deploy:reorder': args(v.uuid(), v.array(v.uuid(), MAX_DEPLOYMENTS)),
  'deploy:settings': args(v.uuid()),
  'deploy:updateSettings': args(v.uuid(), asEnvDeploySettingsPatch),
  'deploy:tooling': args(),
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
}
