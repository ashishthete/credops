import type { EnvironmentMeta } from '../../../shared/inventory'
import { MULTIPLE_PROTECTED_MESSAGE } from '../../../shared/ops'

/** Main's refusal, shown before asking it. */
export const MULTIPLE_PROTECTED = MULTIPLE_PROTECTED_MESSAGE

export interface RunProtection {
  /** The environment whose protection governs the run, if any. */
  env: EnvironmentMeta | null
  /** The name the user must type, or null. */
  needed: string | null
  /** Why main would refuse the run outright, or null. */
  refused: string | null
}

/**
 * Mirrors main's rule so the dialog shows before main is asked; main still checks, and its refusal wins.
 * A protected context is used as is. Otherwise every protected environment a target host belongs to counts:
 * one governs the run, more than one is refused. The name is needed for many hosts or a destructive command.
 */
export function runProtection(
  context: EnvironmentMeta | null,
  environments: readonly EnvironmentMeta[],
  hostIds: readonly string[],
  targetCount: number,
  destructive: boolean,
): RunProtection {
  let env = context
  if (!context?.protected) {
    const ids = new Set(hostIds)
    const found = environments.filter((e) => e.protected && e.hosts.some((m) => ids.has(m.hostId)))
    if (found.length > 1) return { env: null, needed: null, refused: MULTIPLE_PROTECTED }
    env = found[0] ?? context
  }
  const needed = env?.protected && (targetCount > 1 || destructive) ? env.name : null
  return { env, needed, refused: null }
}
