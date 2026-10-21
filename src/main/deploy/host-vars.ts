import { REPO_PATH, SAFE_IDENT, VERSION } from '../../shared/deploy'
import { SECRET_KEY, b64, lockJson, need, sanitizeIdent } from './quote'
import type { DeployPlan, PlanDeployment, PlanHost } from './runner'

/*
 * The per-host variables of a play: `od` (release, environment, the repos to lock, the lock content) and the become
 * password's reference. A one-host play binds them as play vars; a flow's plays span hosts, so the inventory binds
 * them per host instead, from the same values. Neither holds a secret value: become is a `{{ s.<key> }}` reference.
 */

/** True when plays span hosts (a flow, or a parallel prepare), so `od` and become live in the inventory, not in play vars. */
export const hostVarsInInventory = (plan: DeployPlan): boolean => (plan.flow ?? null) !== null || (plan.kind === 'release' && (plan.prepare ?? null) !== null)

/** The pid file a parallel prepare's build records its process group in (repo path and run id checked by the caller). */
export const buildPidFile = (repoPath: string, runId: string): string => `${repoPath}/.git/opsdeck-build-${runId}.pid`

export function hostOd(plan: DeployPlan, h: PlanHost, deps: PlanDeployment[]): Record<string, unknown> {
  const od: Record<string, unknown> = {
    rel: plan.releaseId,
    env: sanitizeIdent(plan.environment.name) || 'env',
    // Every repo the plan touches on this host, sorted: lock, unlock and the lock check all walk this list.
    lock_repos: [...new Set(deps.map((d) => d.repoPath))].sort(),
    lock_b64: b64(lockJson(plan)),
  }
  for (const r of od.lock_repos as string[]) need(REPO_PATH.test(r), 'repo path')
  if (plan.version !== null) {
    need(VERSION.test(plan.version), 'version')
    od.version = plan.version
  }
  if (plan.kind === 'unlock') {
    // Only with builds to stop: an unlock without them keeps its shape.
    const mine = new Set(deps.map((d) => d.runId))
    const kill = (plan.killBuilds ?? []).filter((k) => mine.has(k.runId))
    for (const k of kill) need(REPO_PATH.test(k.repoPath) && SAFE_IDENT.test(k.runId), 'build to stop')
    if (kill.length > 0) od.kill_pids = kill.map((k) => buildPidFile(k.repoPath, k.runId))
  }
  if (plan.kind === 'break-lock') {
    const raw = plan.lock.expectRaw?.[h.hostId]
    need(typeof raw === 'string', 'expected lock content')
    od.expect_b64 = b64(raw as string)
  }
  return od
}

/** The become password as a reference to OPSDECK_SECRETS; undefined when no deployment on the host has one. */
export function hostBecome(deps: PlanDeployment[]): string | undefined {
  // One become password per host: differing keys on one host cannot both apply.
  const keys = new Set(deps.map((d) => d.becomeSecretKey).filter((k): k is string => k !== null))
  need(keys.size <= 1, 'become secrets (one per host)')
  const [k] = keys
  need(k === undefined || SECRET_KEY.test(k), 'secret reference')
  return k === undefined ? undefined : `{{ (s.${k} | b64decode) if s.${k} is defined else omit }}`
}
