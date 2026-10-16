import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
import type { Channel, IpcContract } from '../../shared/ipc'
import {
  AUTO_LOCK_CHOICES,
  MAX_MASTER_PASSWORD,
  MAX_SECRET_NAME,
  MAX_SECRET_VALUE,
  MAX_VAULT_NAME,
  QUICK_UNLOCK_MODES,
  SECRET_KINDS,
  VAULT_COLOR,
  type SecretInput,
  type SecretPatch,
  type VaultInput,
} from '../../shared/vault'
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
}
