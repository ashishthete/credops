import type { Actor } from '../../shared/deploy'

/** What a caller can ask to do. The Hub (Phase 10) swaps in its own checker; locally everything is allowed. */
export type DeployAction = 'deploy.view' | 'deploy.edit' | 'release.start' | 'release.rollback' | 'release.cancel' | 'lock.break' | 'ops.run'

export interface DeployAccess {
  check(actor: Actor, action: DeployAction, target: { environmentId: string; deploymentIds?: string[] }): Promise<{ allowed: boolean; reason?: string }>
}

export const localAllowAll: DeployAccess = { check: async () => ({ allowed: true }) }

export { DeployError } from '../../shared/deploy-error'
