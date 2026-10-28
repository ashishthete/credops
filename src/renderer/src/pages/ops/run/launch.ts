import { CONFIRM_MESSAGE, type RunRequest } from '../../../../../shared/ops'
import { inventoryStore } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { requestProtection } from '../../../ops/protect'
import { snippetStore } from '../../../ops/snippets'
import { addRunIfAbsent, rememberRequest, selectRun } from '../../../ops/runs'
import { attempt, fail, plural, type ConfirmRequest } from '../../../ui/common'

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

/**
 * Starts a run and shows it; a failure is a toast. Main's typed-name refusal (the mirror and main can disagree, e.g. a
 * snippet that renders differently, or an inventory that changed) opens the confirmation through `onConfirm` instead,
 * when the request's environment is known.
 */
export async function launch(req: RunRequest, onConfirm?: (request: ConfirmRequest) => void): Promise<void> {
  let refused = false
  const run = await attempt("Couldn't start the run", () => api.invoke('runs:start', req), (_message, code) => {
    refused = code === 'confirm'
  })
  if (!run) {
    if (!refused) return
    const inv = inventoryStore.get()
    const { env, labels } = requestProtection(req, inv?.environments ?? [], inv?.hosts ?? [], snippetStore.get().snippets)
    if (!env?.protected || !onConfirm) return void fail("Couldn't start the run", new Error(CONFIRM_MESSAGE))
    const { confirm: _was, ...fresh } = req
    return onConfirm(confirmFor(env.name, labels, (name) => launch({ ...fresh, confirm: name }, onConfirm)))
  }
  // Main's first events for it come before its reply, and are newer than it.
  addRunIfAbsent(run)
  rememberRequest(run.id, req)
  selectRun(run.id)
}
