import type { Actor, CommitInfo, DeploymentRunStatus, ReleaseKind, ReleaseOptions, ReleaseStatus } from '../../shared/deploy'

/** What a finalize step may read about the release that just succeeded. */
export interface ReleaseRunMeta {
  /** = releaseId */
  id: string
  releaseId: string
  kind: ReleaseKind
  status: ReleaseStatus
  environmentId: string
  environmentName: string
  productId: string | null
  productName: string | null
  deployments: {
    id: string | null
    name: string
    hostId: string | null
    hostLabel: string
    status: DeploymentRunStatus
    previousCommit: string | null
    deployedCommit: string | null
  }[]
  hostIds: string[]
  version: string | null
  previousVersion: string | null
  commits: CommitInfo[]
  options: ReleaseOptions
  releaseNotes: string | null
  redeploy: boolean
  startedAt: string | null
  finishedAt: string | null
  actor: Actor
  urls: string[]
  /** Set for a runbook operation (only its name is read): it deploys nothing, so it gets no notes or QA. */
  operation?: { name: string } | null
}

export interface FinalizeContext {
  run: ReleaseRunMeta
  /** A line for the release log (redacted by the service). */
  log(line: string): void
  /** Aborted when the release is cancelled. */
  signal: AbortSignal
}

/**
 * Steps after a successful release (Phase 9 plugs in notes, notifications and QA). They run in this order and
 * never change the release outcome: a throw marks only its own step failed.
 */
export interface FinalizeSteps {
  releaseNotes(ctx: FinalizeContext): Promise<string | null>
  notify(ctx: FinalizeContext): Promise<void>
  qa(ctx: FinalizeContext): Promise<void>
}

export const noopFinalize: FinalizeSteps = {
  releaseNotes: async () => null,
  notify: async () => undefined,
  qa: async () => undefined,
}
