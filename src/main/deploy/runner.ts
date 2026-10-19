import type { Actor, DockerMode, HealthUrl, PreflightReport, RunEventBody, UseSudo } from '../../shared/deploy'

/** One SSH hop. `hostId` is null for a hop that isn't an inventory host. */
export interface PlanHop {
  /** `od-<n>`: the Host alias in the generated ssh_config */
  alias: string
  hostId: string | null
  label: string
  address: string
  port: number
  user: string
  auth: 'key' | 'agent' | 'default'
}

export interface PlanHost {
  hostId: string
  label: string
  alias: string
  /** The last hop is the target. */
  hops: PlanHop[]
}

export interface PlanDeployment {
  /** deployment_runs.id */
  runId: string
  deploymentId: string
  name: string
  hostId: string
  repoPath: string
  branch: string
  composeFile: string
  deployTag: string
  urls: HealthUrl[]
  healthStatus: number
  healthTimeoutSec: number
  backup: { dir: string; label: string } | null
  preHookB64: string | null
  postHookB64: string | null
  buildTimeoutSec: number
  composeTimeoutSec: number
  docker: DockerMode
  /** Key into OPSDECK_SECRETS; set exactly when the deployment has a managed .env. */
  envSecretKey: string | null
  becomeSecretKey: string | null
  /** Set for rollback plans. */
  previousCommit: string | null
  /** Preflight walks the docker ladder by this setting. */
  useSudo: UseSudo
}

export type PlanKind = 'preflight' | 'release' | 'rollback' | 'version' | 'unlock' | 'break-lock'

/**
 * Everything a run needs, by reference only: no secret values, so it is serialisable (the Phase 10 Hub
 * receives it as is).
 */
export interface DeployPlan {
  releaseId: string
  kind: PlanKind
  environment: { id: string; name: string }
  version: string | null
  actor: Actor
  hosts: PlanHost[]
  /** In plan order. */
  deployments: PlanDeployment[]
  secretRefs: Record<string, { secretId: string } | { envTemplate: { deploymentId: string } }>
  /** For `break-lock`: the raw lock content preflight saw, per host. */
  lock: { expectRaw?: Record<string, string> }
  startedAt: string
}

// ---- The runner boundary (Phase 10's HubRunner implements the same interface) ----

export interface RunSecrets {
  /** key -> plaintext. Reaches ansible only as base64 inside OPSDECK_SECRETS. Ignored by the Hub. */
  values: Record<string, string>
  /** Every individual secret value, for redact(). */
  known: string[]
}

export interface RunOutcome {
  exitCode: number | null
  signal: string | null
  cancelled: boolean
  /** Set for preflight plans. */
  preflight?: Omit<PreflightReport, 'releaseId'>
  failedDeploymentRunIds: string[]
  /** Deployment runs whose checkout step started, so a rollback has something to undo. */
  reachedCheckout: string[]
  commits: Record<string, { previous?: string; deployed?: string }>
}

export interface RunHandle {
  /** UUIDv7, one per playbook execution (a release involves several). The release id is the stream id. */
  runId: string
  /** Resolves when the process has exited and cleanup is done. Rejects before anything is created if a tool is missing. */
  done: Promise<RunOutcome>
}

export interface DeployRunner {
  start(plan: DeployPlan, secrets: RunSecrets): RunHandle
  cancel(runId: string): void
  onEvent(fn: (releaseId: string, body: RunEventBody) => void): () => void
}
