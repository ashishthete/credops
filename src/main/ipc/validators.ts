import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
import type { Channel, IpcContract } from '../../shared/ipc'
import {
  HOST_ADDRESS,
  HOST_ROLES,
  MAX_ADDRESS,
  MAX_DESCRIPTION,
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
} from '../../shared/inventory'
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
import { args, v, type ArgsValidator, type Check } from './validate'

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
}) as Check<HostPatch>

/** Every channel must have an entry; each later task adds its own. */
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
}
