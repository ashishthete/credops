import { AUDIT_ACTIONS, type AuditFilter } from '../../shared/audit'
import type { Channel, IpcContract } from '../../shared/ipc'
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

/** Every channel must have an entry; each later task adds its own. */
export const VALIDATORS: { [K in Channel]: ArgsValidator<IpcContract[K]['args']> } = {
  'app:info': args(),
  'audit:list': args(asFilter),
  'audit:verify': args(),
  'audit:exportCsv': args(asFilter),
}
