import type { Actor, DockerMode, HealthUrl, PreflightReport, RunEventBody, UseSudo } from '../../shared/deploy'
import type { StepAnchor, StepBody } from '../../shared/steps'

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

/**
 * A custom step as the playbook runs it. Secrets and params are references and base64 only: `secretKeys` name
 * OPSDECK_SECRETS keys, and each env name passes ENV_NAME and the deny-list (params are `OD_PARAM_<NAME>`).
 */
export interface PlanStep {
  /** `c_<n>`: n is the step's index in its checkout's effective steps; the log and tag kind. */
  key: string
  /** stepLabel(step), snapshotted for the step list. */
  label: string
  step: StepBody
  /** Null for a step outside a release (a runbook or a flow stage). */
  anchor: StepAnchor | null
  /** A rollback runs only the steps that set this. */
  alsoOnRollback?: boolean
  secretKeys: { envName: string; key: string }[]
  paramKeys: { envName: string; valueB64: string }[]
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
  /** Legacy hooks: null whenever `steps` is used. A plan that still carries them gets them as steps (effectiveSteps). */
  preHookB64: string | null
  postHookB64: string | null
  /** In anchor order within each anchor; empty when the checkout has none. */
  steps: PlanStep[]
  /** The previous commit `when` compares against (SHA-checked); null counts as changed. */
  whenBase: string | null
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
  /** `-p` for every compose command; null lets compose name the project after the directory. */
  composeProject: string | null
  /** Compose services to build and up (with --no-deps), in position order; null means the whole checkout. */
  services: string[] | null
  /**
   * Preflight lists commits from the merge-base of these (each selected service's last deployed commit, plus
   * the deploy tag's commit when `tag`) to origin/<branch>. No shas: the tag range alone.
   */
  commitBases: { shas: string[]; tag: boolean }
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
  preflight?: RunnerPreflight
  failedDeploymentRunIds: string[]
  /** Deployment runs whose checkout step started, so a rollback has something to undo. */
  reachedCheckout: string[]
  /** Deployment runs whose `up` step started, so a rollback knows what may be running new code. */
  reachedUp?: string[]
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

/** What a runner reports from preflight; the release service adds `serviceCommits` from its selection. */
export type RunnerPreflight = Omit<PreflightReport, 'releaseId' | 'serviceCommits'>
