import type { DeployPlan } from './runner'
import type { LockHolder } from '../../shared/deploy'

export const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** Anything outside [A-Za-z0-9._@-] becomes `_`; at most 64 characters. */
export const sanitizeIdent = (s: string): string => s.replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64)

/** The lock file's content. Key order is fixed: the shell checks `"releaseId":"<id>"` by substring. */
export function lockJson(plan: DeployPlan): string {
  const holder: LockHolder = {
    releaseId: plan.releaseId,
    user: plan.actor.osUser,
    machine: plan.actor.machine,
    environment: plan.environment.name,
    version: plan.version,
    startedAt: plan.startedAt,
  }
  return JSON.stringify(holder)
}
