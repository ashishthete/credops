import type { DeployPlan } from './runner'
import { sanitizeIdent, type LockHolder } from '../../shared/deploy'

export const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

export { sanitizeIdent }

/** The lock file's content. Key order is fixed: the shell checks `"releaseId":"<id>"` by substring. */
export function lockJson(plan: DeployPlan): string {
  const holder: LockHolder = {
    releaseId: plan.releaseId,
    user: sanitizeIdent(plan.actor.osUser),
    machine: sanitizeIdent(plan.actor.machine),
    environment: plan.environment.name,
    version: plan.version,
    startedAt: plan.startedAt,
  }
  return JSON.stringify(holder)
}

export const ALIAS = /^od-\d{1,4}$/
export const B64 = /^[A-Za-z0-9+/]*={0,2}$/
/** A key into OPSDECK_SECRETS, as `s.<key>` names it. */
export const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`deploy plan: invalid ${what}`)
}
