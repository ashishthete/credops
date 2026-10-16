import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
import type { Channel, IpcContract } from '../../shared/ipc'
import { MAX_MASTER_PASSWORD, MAX_VAULT_NAME, VAULT_COLOR, type VaultInput } from '../../shared/vault'
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

/** Every channel must have an entry; each later task adds its own. */
export const VALIDATORS: { [K in Channel]: ArgsValidator<IpcContract[K]['args']> } = {
  'app:info': args(),
  'audit:list': args(asFilter),
  'audit:verify': args(),
  'audit:exportCsv': args(asFilter),
  'vault:status': args(),
  'vault:setup': args(asPassword),
  'vault:unlock': args(asPassword),
  'vault:lock': args(),
  'vault:changePassword': args(asPassword, asPassword),
  'vault:list': args(),
  'vault:create': args(asVaultInput),
  'vault:update': args(v.uuid(), asVaultPatch),
  'vault:delete': args(v.uuid()),
}
