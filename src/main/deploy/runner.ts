import type { Actor, DockerMode, HealthUrl, PreflightReport, ReleaseFlow, RunEventBody, UseSudo } from '../../shared/deploy'
import type { BuiltinKind } from '../../shared/runbooks'
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
  /**
   * Release only, set when some of this checkout's services are skipped as unchanged: the origin head preflight
   * saw (SHA-checked). After the fetch the run fails unless origin is still there, so a skip never outlives it.
   */
  expectOriginHead?: string | null
}

/**
 * One stage of a release flow (see flowStages). A services stage ups each part's compose services (null: the whole
 * checkout) and checks the health URLs at `urls` (indices into the run's `urls`); a step stage runs one step on its
 * checkout's host.
 */
export type PlanStage =
  | { kind: 'services'; parts: { runId: string; services: string[] | null; urls: number[] }[] }
  | { kind: 'step'; runId: string; step: PlanStep }

/** A release's flow: its stages in order, each one play. */
export interface PlanFlow {
  stages: PlanStage[]
  onFailure: ReleaseFlow['onFailure']
}

/**
 * A runbook run: its items in order on each target checkout. Never a release: no tags, notes or rollback.
 * Steps carry `anchor: null` and their param values as base64 (PlanStep.paramKeys).
 */
export interface PlanOperation {
  runbookId: string
  name: string
  /** Takes the host lock like a release (the same lock and unlock tasks); only read-only runbooks may be false. */
  lock: boolean
  items: ({ type: 'step'; step: PlanStep } | { type: 'builtin'; builtin: BuiltinKind; tail?: number; untilHours?: number })[]
  /** `services` are compose service names; empty means the whole checkout. */
  targets: { runId: string; services: string[] }[]
}

export type PlanKind = 'preflight' | 'release' | 'rollback' | 'version' | 'unlock' | 'break-lock' | 'operation'

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
  /** Rollback only: the release being rolled back, when it is another one (a manual rollback); its .env backup is restored. */
  rollbackOf?: string
  /** For `break-lock`: the raw lock content preflight saw, per host. */
  lock: { expectRaw?: Record<string, string> }
  startedAt: string
  /** Release only: the stages the deploy phase runs in, one play each. Null: one play per host. */
  flow: PlanFlow | null
  /**
   * Release only: prepare every checkout first, in one play over all hosts, with builds launched async (at most
   * `cap` per host at once); no service goes up unless every checkout prepared. Null: each checkout runs in order.
   */
  prepare: { cap: number } | null
  /** Operation only: what to run on `deployments` (the targeted checkouts). */
  operation?: PlanOperation | null
  /** Unlock only: the builds a parallel prepare launched, whose recorded process groups are stopped before the lock goes. */
  killBuilds?: { runId: string; repoPath: string }[]
  /**
   * A validated edit of the generated playbook (Task 10b), written in its place; secret references only, like the
   * generated text. The inventory and every other run file are still generated from the plan.
   */
  playbookText?: string
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
