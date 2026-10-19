import type { RunRequest } from '../../../../../shared/ops'
import { api } from '../../../lib/api'
import { addRunIfAbsent, rememberRequest, selectRun } from '../../../ops/runs'
import { attempt, plural, type ConfirmRequest } from '../../../ui/common'

/** Labels a confirmation names before "and N more". */
const NAMED = 5

/** "db-1, db-2, web-1, web-2, web-3 and 3 more" */
function namesOf(labels: readonly string[]): string {
  const shown = labels.slice(0, NAMED).join(', ')
  return labels.length > NAMED ? `${shown} and ${labels.length - NAMED} more` : shown
}

/** The typed-name confirmation for a run; `run` sends the request with the name as `confirm`. */
export function confirmFor(env: string, labels: readonly string[], run: (confirm: string) => Promise<unknown>): ConfirmRequest {
  return {
    title: `Run on ${plural(labels.length, 'host')} in ${env}?`,
    description: namesOf(labels),
    confirmLabel: 'Run',
    typeToConfirm: env,
    run: () => run(env),
  }
}

/** Starts a run and shows it; main's refusal (or any failure) is a toast. */
export async function launch(req: RunRequest): Promise<void> {
  const run = await attempt("Couldn't start the run", () => api.invoke('runs:start', req))
  if (!run) return
  // Main's first events for it come before its reply, and are newer than it.
  addRunIfAbsent(run)
  rememberRequest(run.id, req)
  selectRun(run.id)
}
