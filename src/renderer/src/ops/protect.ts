import type { EnvironmentMeta, HostMeta } from '../../../shared/inventory'
import { DESTRUCTIVE_PATTERN, MULTIPLE_PROTECTED_MESSAGE, type RunRequest, type SnippetMeta } from '../../../shared/ops'

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

/**
 * The protection a request needs as things are now (Run again): its targets and context as the inventory has
 * them, and whether its command looks destructive. A snippet counts if it is flagged or its script looks it, or
 * if it is gone (main then refuses the run anyway). For a snippet, `rendered` (main's render of it) is what is
 * tested, as main does; the raw script only when it is not given. `labels` are the target hosts, in the order main runs them.
 */
export function requestProtection(
  req: RunRequest,
  environments: readonly EnvironmentMeta[],
  hosts: readonly HostMeta[],
  snippets: readonly SnippetMeta[],
  rendered?: string,
): RunProtection & { labels: string[] } {
  const { target, command } = req
  const context = environments.find((e) => e.id === target.environmentId) ?? null
  const ids = new Set(
    target.kind === 'hosts' ? target.hostIds : (context?.hosts.filter((m) => !target.role || m.role === target.role).map((m) => m.hostId) ?? []),
  )
  const targets = hosts.filter((h) => ids.has(h.id))
  const snippet = command.kind === 'snippet' ? snippets.find((s) => s.id === command.snippetId) : undefined
  const destructive = command.kind === 'text' ? DESTRUCTIVE_PATTERN.test(command.text) : !snippet || snippet.destructive || DESTRUCTIVE_PATTERN.test(rendered ?? snippet.script)
  const protection = runProtection(context, environments, targets.map((h) => h.id), targets.length, destructive)
  return { ...protection, labels: targets.map((h) => h.label) }
}
