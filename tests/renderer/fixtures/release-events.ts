import type { DeploymentRunMeta, ReleaseDetail, RunEvent, RunEventBody, StepKind } from '../../../src/shared/deploy'

const STAMP = '2026-10-19T10:00:00.000Z'
export const REL = 'rel-1'

const RELEASE_STEPS: StepKind[] = ['record', 'fetch', 'checkout', 'build', 'up', 'health', 'tag']

function run(over: Partial<DeploymentRunMeta> & { id: string }): DeploymentRunMeta {
  return {
    releaseId: REL,
    deploymentId: `dep-${over.id}`,
    deploymentName: over.id,
    hostId: 'h1',
    hostLabel: 'app1',
    position: 0,
    branch: 'main',
    previousCommit: null,
    deployedCommit: null,
    commits: [],
    status: 'pending',
    rolledBack: false,
    backupFile: null,
    startedAt: null,
    finishedAt: null,
    steps: RELEASE_STEPS.map((kind) => ({ stepId: `${over.id}:${kind}`, kind, state: 'pending', startedAt: null, finishedAt: null })),
    services: [],
    wholeCheckout: false,
    ...over,
  }
}

const svc = (id: string, name: string) => ({ id, name, composeService: name, previousCommit: null, previousReleaseId: null, deployedCommit: null })

/** Two hosts: r1 (core: api, worker) and r2 (web, whole checkout) on app1, r3 (site) on app2. */
export function releaseDetail(over: Partial<ReleaseDetail> = {}): ReleaseDetail {
  return {
    id: REL,
    environmentId: 'e1',
    environmentName: 'staging',
    kind: 'release',
    status: 'ready',
    version: 'v1.5.0',
    previousVersion: 'v1.4.0',
    redeploy: false,
    rollbackOf: null,
    triggeredBy: 'ana@mbp',
    createdAt: STAMP,
    startedAt: null,
    finishedAt: null,
    deploymentCount: 3,
    hostCount: 2,
    serviceIds: ['s1', 's2', 's3'],
    serviceCount: 4,
    error: null,
    options: { backup: false, notify: false, qa: false },
    releaseNotes: null,
    playbook: null,
    playbookGenerated: null,
    operation: null,
    playbookSource: 'generated',
    runs: [
      run({ id: 'r1', deploymentName: 'core', position: 0, services: [svc('s1', 'api'), svc('s2', 'worker')] }),
      run({ id: 'r2', deploymentName: 'web', position: 1, wholeCheckout: true, services: [svc('s4', 'site-web')] }),
      run({ id: 'r3', deploymentName: 'site', hostId: 'h2', hostLabel: 'app2', position: 2, services: [svc('s3', 'site')] }),
    ],
    preflight: null,
    lastSeq: 0,
    ...over,
  }
}

/** Numbers the bodies seq 1… with one second between them. */
export function events(bodies: RunEventBody[], from = 1): RunEvent[] {
  return bodies.map((b, i) => ({ id: `ev-${from + i}`, runId: REL, seq: from + i, at: new Date(Date.parse(STAMP) + (from + i) * 1000).toISOString(), ...b }) as RunEvent)
}

const step = (stepId: string, kind: StepKind, hostId: string | null, deploymentRunId: string | null): RunEventBody[] => [
  { type: 'step.started', stepId, kind, name: kind, hostId, deploymentRunId },
  { type: 'step.done', stepId, state: 'ok', durationMs: 1000 },
]

const runSteps = (runId: string, hostId: string, kinds = RELEASE_STEPS): RunEventBody[] => kinds.flatMap((k) => step(`${runId}:${k}`, k, hostId, runId))

/** Every step succeeds, the version is tagged and the release succeeds. */
export const OK_RUN: RunEventBody[] = [
  { type: 'run.started', kind: 'release', version: 'v1.5.0' },
  ...step('host:h1:lock', 'lock', 'h1', null),
  ...step('host:h2:lock', 'lock', 'h2', null),
  { type: 'deployment.updated', deploymentRunId: 'r1', status: 'running' },
  ...runSteps('r1', 'h1'),
  { type: 'log', stepId: 'r1:build', hostId: 'h1', stream: 'out', line: 'built' },
  { type: 'deployment.updated', deploymentRunId: 'r1', status: 'succeeded', previousCommit: 'a'.repeat(40), deployedCommit: 'b'.repeat(40) },
  { type: 'deployment.updated', deploymentRunId: 'r2', status: 'running' },
  ...runSteps('r2', 'h1'),
  { type: 'deployment.updated', deploymentRunId: 'r2', status: 'succeeded' },
  { type: 'deployment.updated', deploymentRunId: 'r3', status: 'running' },
  ...runSteps('r3', 'h2'),
  { type: 'deployment.updated', deploymentRunId: 'r3', status: 'succeeded' },
  ...step('host:h1:unlock', 'unlock', 'h1', null),
  ...step('host:h2:unlock', 'unlock', 'h2', null),
  ...step('release:version', 'version', null, null),
  { type: 'version.bumped', from: 'v1.4.0', to: 'v1.5.0' },
  { type: 'run.finished', status: 'succeeded' },
]

/** r1 succeeds; r3's health check fails; with auto-rollback r1 is rolled back. */
export function healthFailure(autoRollback: boolean): RunEventBody[] {
  return [
    { type: 'run.started', kind: 'release', version: 'v1.5.0' },
    ...step('host:h1:lock', 'lock', 'h1', null),
    ...step('host:h2:lock', 'lock', 'h2', null),
    ...runSteps('r1', 'h1'),
    { type: 'deployment.updated', deploymentRunId: 'r1', status: 'succeeded' },
    ...runSteps('r3', 'h2', ['record', 'fetch', 'checkout', 'build', 'up']),
    { type: 'step.started', stepId: 'r3:health', kind: 'health', name: 'health', hostId: 'h2', deploymentRunId: 'r3' },
    { type: 'step.failed', stepId: 'r3:health', error: 'health check failed on app2', durationMs: 5000 },
    { type: 'deployment.updated', deploymentRunId: 'r3', status: 'failed' },
    ...(autoRollback
      ? ([
          { type: 'rollback.started', deploymentRunIds: ['r1'] },
          ...step('r1:rb_checkout', 'rb_checkout', 'h1', 'r1'),
          ...step('r1:rb_up', 'rb_up', 'h1', 'r1'),
          { type: 'deployment.updated', deploymentRunId: 'r1', status: 'rolled_back' },
          { type: 'rollback.done', ok: true },
          { type: 'run.finished', status: 'rolled_back', error: 'health check failed on app2' },
        ] satisfies RunEventBody[])
      : ([{ type: 'run.finished', status: 'failed', error: 'health check failed on app2' }] satisfies RunEventBody[])),
  ]
}

/**
 * A release playbook for `detail`'s runs in the generator's shape (JSON, one play per host: lock prep, lock, then
 * one block per deployment). `health` sets how many health tasks (URLs) a run has.
 */
export function playbookOf(detail: ReleaseDetail, health: Record<string, number> = {}): string {
  const hosts = [...new Set(detail.runs.map((r) => r.hostId ?? ''))]
  const tags = (kind: string, run: string) => [`od_step=${kind}`, `od_run=${run}`]
  return JSON.stringify(
    hosts.map((h, i) => ({
      name: `release od-${i + 1}`,
      hosts: `od-${i + 1}`,
      tasks: [
        { name: `lock prep od-${i + 1}`, tags: tags('lock', `host:${h}`) },
        { name: `lock od-${i + 1}`, tags: tags('lock', `host:${h}`) },
        ...detail.runs
          .filter((r) => r.hostId === h)
          .map((r) => ({
            name: `deployment ${r.deploymentName}`,
            vars: { d: { name: r.deploymentName, run: r.id } },
            block: r.steps.flatMap((s) =>
              s.kind === 'health'
                ? Array.from({ length: health[r.id] ?? 1 }, (_, n) => ({ name: `health ${r.deploymentName} ${n}`, tags: tags('health', r.id) }))
                : [{ name: `${s.kind} ${r.deploymentName}`, tags: tags(s.kind, r.id) }],
            ),
            rescue: [{ name: `mark failed ${r.deploymentName}`, 'ansible.builtin.set_fact': { od_failed: true } }],
          })),
      ],
    })),
  )
}
