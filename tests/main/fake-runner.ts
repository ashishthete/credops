import type { DeployPlan, DeployRunner, RunOutcome, RunSecrets } from '../../src/main/deploy/runner'
import type { PreflightCheck, PreflightReport, RunEventBody } from '../../src/shared/deploy'

/** The scripted DeployRunner shared by the app's release rig and the Hub's release tests. */
export const A = 'a'.repeat(40)

export type Emit = (body: RunEventBody) => void
export type Handler = (plan: DeployPlan, secrets: RunSecrets, emit: Emit, runId: string) => Promise<Partial<RunOutcome> | void> | Partial<RunOutcome> | void

export class FakeRunner implements DeployRunner {
  calls: { plan: DeployPlan; secrets: RunSecrets; seen: { values: Record<string, string>; known: string[] } }[] = []
  cancels: string[] = []
  commitsTotal = 1
  checks: PreflightCheck[] = []
  locks: PreflightReport['locks'] = {}
  /** Overrides per plan kind; the default is a clean run. */
  on: Partial<Record<DeployPlan['kind'], Handler>> = {}
  onCancel: (runId: string) => void = () => undefined
  private listeners = new Set<(releaseId: string, body: RunEventBody) => void>()
  private n = 0

  get kinds(): string[] {
    return this.calls.map((c) => c.plan.kind)
  }
  call(kind: DeployPlan['kind'], i = 0): DeployPlan {
    return this.calls.filter((c) => c.plan.kind === kind)[i].plan
  }

  start(plan: DeployPlan, secrets: RunSecrets) {
    this.calls.push({ plan, secrets, seen: { values: { ...secrets.values }, known: [...secrets.known] } })
    const runId = `fake-run-${++this.n}`
    const emit: Emit = (b) => this.listeners.forEach((l) => l(plan.releaseId, b))
    const done = Promise.resolve()
      .then(async () => {
        const h = this.on[plan.kind]
        const res = h ? await h(plan, secrets, emit, runId) : undefined
        const base: RunOutcome = { exitCode: 0, signal: null, cancelled: false, failedDeploymentRunIds: [], reachedCheckout: [], commits: {} }
        if (plan.kind === 'preflight') {
          base.preflight = {
            checks: this.checks,
            commits: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, { commits: [], hiddenPairs: 0, truncated: 0, firstDeploy: false, head: A, tagCommit: null }])),
            dockerModes: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, 'plain' as const])),
            composeServices: Object.fromEntries(plan.deployments.map((d) => [d.deploymentId, null])),
            locks: this.locks,
            commitsTotal: this.commitsTotal,
            blocked: this.checks.some((c) => c.level === 'block'),
          }
        }
        const out = { ...base, ...(res ?? {}) }
        if (plan.kind === 'release') {
          const failed = new Set(out.failedDeploymentRunIds)
          const reached = new Set(out.reachedCheckout)
          for (const d of plan.deployments) {
            if (failed.size > 0 && !reached.has(d.runId)) continue
            if (out.exitCode !== 0 && failed.size === 0 && !reached.has(d.runId)) continue
            emit({
              type: 'deployment.updated',
              deploymentRunId: d.runId,
              status: failed.has(d.runId) || (out.exitCode !== 0 && failed.size === 0) ? 'failed' : 'succeeded',
              ...(out.commits[d.runId]?.previous ? { previousCommit: out.commits[d.runId].previous } : {}),
            })
          }
        }
        return out
      })
    return { runId, done }
  }
  cancel(runId: string): void {
    this.cancels.push(runId)
    this.onCancel(runId)
  }
  onEvent(fn: (releaseId: string, body: RunEventBody) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}
