import type { AccessTarget, HubAction, HubDecision, HubGrant, HubGroup, HubUser } from '../../../src/shared/hub'

const ADMIN_ONLY: readonly HubAction[] = ['admin', 'deploy.edit', 'lock.break']

interface Candidate {
  group: HubGroup
  grant: HubGrant
}

// Lower is narrower.
const RANK = { deployment: 0, environment: 1, all: 2 } as const

function narrowest(cands: Candidate[]): Candidate | undefined {
  return [...cands].sort(
    (a, b) =>
      RANK[a.grant.scope.kind] - RANK[b.grant.scope.kind] ||
      (a.group.createdAt < b.group.createdAt ? -1 : a.group.createdAt > b.group.createdAt ? 1 : 0),
  )[0]
}

const deny = (code: 'pending' | 'disabled' | 'no_grant' | 'admin_only', reason: string): HubDecision => ({
  allowed: false,
  code,
  reason,
})

/** Pure authorization: who may do `action` on `target`, and through which grant. */
export function decide(user: HubUser, groups: HubGroup[], action: HubAction, target?: AccessTarget): HubDecision {
  if (user.status === 'disabled') return deny('disabled', 'Your Hub account is disabled')
  if (user.status === 'pending') {
    return deny('pending', "You're not in any group yet. Ask a Hub admin to add you.")
  }
  if (ADMIN_ONLY.includes(action) && user.role !== 'admin') return deny('admin_only', 'Only Hub admins can do this')
  if (user.role === 'admin') return { allowed: true, via: { role: 'admin', groupId: null, groupName: null } }

  const mine = groups.filter((g) => user.groupIds.includes(g.id))
  const cands: Candidate[] = mine.flatMap((group) => group.grants.map((grant) => ({ group, grant })))
  const via = (c: Candidate): HubDecision => ({
    allowed: true,
    via: { role: user.role, groupId: c.group.id, groupName: c.group.name },
  })

  // Fail closed: a non-admin decision always needs a target to be judged against.
  if (!target) return deny('no_grant', "You don't have access. Ask a Hub admin for a grant.")

  const env = target.environmentId
  const wide = cands.filter(
    (c) =>
      c.grant.scope.kind === 'all' || (c.grant.scope.kind === 'environment' && c.grant.scope.environmentId === env),
  )
  const depGrants = (id: string): Candidate[] =>
    cands.filter(
      (c) => c.grant.scope.kind === 'deployment' && c.grant.scope.environmentId === env && c.grant.scope.deploymentId === id,
    )
  const ids = [...new Set(target.deploymentIds ?? [])]

  if (ids.length === 0) {
    const pool =
      action === 'deploy.view' ? [...wide, ...cands.filter((c) => c.grant.scope.kind === 'deployment' && c.grant.scope.environmentId === env)] : wide
    const c = narrowest(pool)
    return c ? via(c) : deny('no_grant', `You don't have access to ${env}. Ask a Hub admin for a grant.`)
  }

  const perDep = ids.map((id) => ({ id, best: narrowest([...depGrants(id), ...wide]) }))
  const missing = perDep.find((p) => !p.best)
  if (missing) return deny('no_grant', `You don't have access to ${missing.id}. Ask a Hub admin for a grant.`)

  // One grant covering the whole target: a wide grant, or the only deployment's own grant.
  const single = narrowest(ids.length === 1 ? [...depGrants(ids[0]), ...wide] : wide)
  if (single) return via(single)
  return {
    allowed: true,
    via: { role: user.role, groupId: null, groupName: 'multiple' },
    vias: perDep.map((p) => ({ deploymentId: p.id, groupId: p.best!.group.id, groupName: p.best!.group.name })),
  }
}
