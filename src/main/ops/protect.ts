/**
 * The protected-environment rule (G9). It runs in main; the renderer only mirrors it to show the dialog.
 * Protection belongs to the environments the target hosts serve, not to the context a request names:
 * a run with no context on a prod host still needs the name typed.
 */
import { CONFIRM_MESSAGE, DESTRUCTIVE_PATTERN, MULTIPLE_PROTECTED_MESSAGE } from '../../shared/ops'

export { CONFIRM_MESSAGE, MULTIPLE_PROTECTED_MESSAGE }

export class ProtectError extends Error {
  constructor(
    readonly code: 'confirm' | 'multiple-protected',
    message: string,
  ) {
    super(message)
    this.name = 'ProtectError'
  }
}

export interface ProtectionEnv {
  id: string
  name: string
  protected: boolean
}

export function isDestructive(command: string, snippetFlag: boolean): boolean {
  return snippetFlag || DESTRUCTIVE_PATTERN.test(command)
}

/**
 * The environment whose protection governs a run or container action. Every protected environment any target host
 * belongs to counts (`memberships`, duplicates fine), and so does a protected context: one is the run's environment,
 * more than one is refused. With none, the context (or null) comes back.
 */
export function protectionFor<E extends ProtectionEnv>(context: E | null, memberships: readonly E[]): E | null {
  const found = new Map<string, E>()
  for (const env of memberships) if (env.protected) found.set(env.id, env)
  // A protected context does not hide another protected environment of the hosts: its name alone would not cover them.
  if (context?.protected) {
    if ([...found.keys()].some((id) => id !== context.id)) throw new ProtectError('multiple-protected', MULTIPLE_PROTECTED_MESSAGE)
    return context
  }
  if (found.size > 1) throw new ProtectError('multiple-protected', MULTIPLE_PROTECTED_MESSAGE)
  const [only] = found.values()
  return only ?? context
}

/** The name the user must type, or null when no confirmation is needed. Hosts outside any environment are never protected. */
export function confirmNeeded(
  env: { name: string; protected: boolean } | null,
  targetCount: number,
  destructive: boolean,
): string | null {
  return env?.protected && (targetCount > 1 || destructive) ? env.name : null
}

/** Exact, case-sensitive match. */
export function checkConfirm(needed: string | null, given: string | undefined): void {
  if (needed !== null && given !== needed) throw new ProtectError('confirm', CONFIRM_MESSAGE)
}
