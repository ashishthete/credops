import { ACCESS_CACHE_MS, type HubDecision } from '../../shared/hub'
import type { Actor } from '../../shared/deploy'
import type { DeployAccess, DeployAction } from '../deploy/access'
import { HubError } from './client'
import type { HubConnection } from './connection'

type Target = { environmentId: string; deploymentIds?: string[] }
type Decision = { allowed: boolean; reason?: string }

/** Phase 8's access checker backed by the Hub. Results are cached briefly; any Hub state change clears the cache. */
export class HubAccess implements DeployAccess {
  private readonly cache = new Map<string, { at: number; decision: Decision }>()
  private readonly now: () => number
  private readonly ttl: number

  constructor(
    private readonly conn: Pick<HubConnection, 'client' | 'status' | 'onState'>,
    opts: { now: () => number; ttlMs?: number },
  ) {
    this.now = opts.now
    this.ttl = opts.ttlMs ?? ACCESS_CACHE_MS
    conn.onState(() => this.cache.clear())
  }

  async check(_actor: Actor, action: DeployAction, target: Target): Promise<Decision> {
    const st = this.conn.status()
    if (!st.linked || !st.signedIn) return { allowed: false, reason: 'Sign in to the Hub' }
    const ids = target.deploymentIds ?? []
    const key = JSON.stringify([action, target.environmentId, [...ids].sort()])
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < this.ttl) return hit.decision
    let decision: Decision
    try {
      const d = await this.conn
        .client()
        .get<HubDecision>('/api/v1/access', {
          action,
          environmentId: target.environmentId,
          ...(ids.length ? { deploymentIds: ids } : {}),
        })
      decision = d.allowed ? { allowed: true } : { allowed: false, reason: d.reason }
    } catch (err) {
      if (err instanceof HubError && (err.code === 'network' || err.code === 'timeout')) {
        return { allowed: false, reason: 'Hub unreachable' }
      }
      return { allowed: false, reason: err instanceof HubError ? err.message : 'Hub access check failed' }
    }
    this.cache.set(key, { at: this.now(), decision })
    return decision
  }
}

/** Environments published to a Hub are checked there; everything else keeps Phase 8's local allow-all. */
export class RoutingAccess implements DeployAccess {
  constructor(private readonly d: { local: DeployAccess; hub: DeployAccess; isHubTarget: (environmentId: string) => boolean }) {}

  check(actor: Actor, action: DeployAction, target: Target): Promise<Decision> {
    return (this.d.isHubTarget(target.environmentId) ? this.d.hub : this.d.local).check(actor, action, target)
  }
}
