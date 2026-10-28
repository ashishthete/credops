import type { IdentityStore, ResolvedIdentity } from '../vault/identity-store'
import type { PlanKind } from './runner'

/** Plans that hold the identities they resolve. A preflight holds none: it can sit on screen for as long as the person likes. */
const HOLDING: ReadonlySet<PlanKind> = new Set(['release', 'rollback', 'version', 'unlock', 'break-lock', 'operation'])

/**
 * The ssh identities a started release resolved, held until it finishes. A vault lock mid-release (the screen
 * locking, say) would otherwise fail every later plan of that release at its first host: its rollback, and the
 * deploy-lock release at the end, leaving the lock on the hosts. A running release already keeps its other
 * secrets past a lock; this keeps the keys it reaches the hosts with as well, and only for as long.
 */
export class HeldIdentities {
  private readonly held = new Map<string, Map<string, ResolvedIdentity>>()

  constructor(private readonly inner: Pick<IdentityStore, 'resolve'>) {}

  /** The identity lookup for one plan: from the vault, then from what this release already holds. */
  for(releaseId: string, kind: PlanKind): Pick<IdentityStore, 'resolve'> {
    if (!HOLDING.has(kind)) return this.inner
    return {
      resolve: async (id) => {
        const kept = this.held.get(releaseId)?.get(id)
        if (kept) return kept
        const r = await this.inner.resolve(id)
        let mine = this.held.get(releaseId)
        if (!mine) this.held.set(releaseId, (mine = new Map()))
        mine.set(id, r)
        return r
      },
    }
  }

  /** The release finished: what it held goes. */
  drop(releaseId: string): void {
    this.held.delete(releaseId)
  }

  /** A vault reset: nothing the old password guarded is kept. */
  dropAll(): void {
    this.held.clear()
  }
}
