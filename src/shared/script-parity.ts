// Imported by the renderer: pure functions only (no node or electron imports).
// Compares one environment's deploy config with what deployment/unified_release.sh does
// (docs/superpowers/specs/2026-10-21-script-parity.md). The UI calls this "Compared with unified_release.sh".
import { COMPOSE_AUTO, type DeploymentMeta, type DeploymentPatch, type EnvDeploySettingsPatch } from './deploy'
import { QA_WAIT_DEFAULT_MIN, type QaWorkflow } from './settings'

export interface ScriptEnv {
  name: string
  versioned: boolean
  protected: boolean
  qa?: QaWorkflow | null
  /** The environment's "QA after deploy" and "Wait for result" switches (Notifications); absent means on. */
  qaOnDeploy?: boolean
  qaWait?: boolean
}
export type ScriptDeployment = Pick<DeploymentMeta, 'id' | 'name' | 'composeFile' | 'useSudo' | 'buildTimeoutSec' | 'composeTimeoutSec'>

/** The fields the preset may change, so Undo restores exactly these. */
export type ScriptDeploymentPatch = Pick<DeploymentPatch, 'buildTimeoutSec' | 'composeTimeoutSec' | 'useSudo' | 'composeFile'>
export type ScriptEnvPatch = Pick<EnvDeploySettingsPatch, 'versioned'>

export interface ScriptFix {
  env?: ScriptEnvPatch
  /** By deployment id. */
  deployments?: Record<string, ScriptDeploymentPatch>
  /** The setting lives elsewhere: the environment's Notifications settings on the Products page. */
  open?: 'notifications'
}

export type ScriptCheckLevel = 'ok' | 'differs' | 'risk'
export interface ScriptCheck {
  id: string
  level: ScriptCheckLevel
  title: string
  script: string
  opsdeck: string
  fix?: ScriptFix
}

export interface ScriptPreset {
  env: ScriptEnvPatch
  deployments: Record<string, ScriptDeploymentPatch>
}

export const SCRIPT_BUILD_MIN_SEC = 1800
export const SCRIPT_UP_MIN_SEC = 600
export const SCRIPT_BUILD_SEC = 3600
export const SCRIPT_UP_SEC = 900
export const SCRIPT_QA_WAIT_MIN = 45

/** The script tags versions on prod only; never touch a prod or protected environment's flag. */
export const isProd = (name: string): boolean => /^prod$/i.test(name.trim())
const byId = <T>(ds: ScriptDeployment[], patch: (d: ScriptDeployment) => T | null): Record<string, T> =>
  Object.fromEntries(ds.flatMap((d) => {
    const p = patch(d)
    return p ? [[d.id, p]] : []
  }))

/** Counts as a difference: any risk, and a difference there is something to change for. Failed builds (no fix) is a note. */
export const isFlagged = (c: ScriptCheck): boolean => c.level === 'risk' || (c.level === 'differs' && !!c.fix)

export function checkAgainstScript(env: ScriptEnv, deployments: ScriptDeployment[]): ScriptCheck[] {
  const checks: ScriptCheck[] = []

  // Row 31.
  const short = deployments.filter((d) => d.buildTimeoutSec < SCRIPT_BUILD_MIN_SEC || d.composeTimeoutSec < SCRIPT_UP_MIN_SEC)
  checks.push({
    id: 'timeouts',
    level: short.length ? 'risk' : 'ok',
    title: 'Build and start time limits',
    script: 'Runs docker compose up --build with no time limit.',
    opsdeck: short.length
      ? `Stops and rolls back when a build or start takes longer than its limit: ${short
          .map((d) => `${d.name} build ${d.buildTimeoutSec} s, up ${d.composeTimeoutSec} s`)
          .join('; ')}.`
      : `Every deployment allows at least ${SCRIPT_BUILD_MIN_SEC} s to build and ${SCRIPT_UP_MIN_SEC} s to start.`,
    ...(short.length > 0 && {
      fix: {
        deployments: byId(short, (d) => ({
          ...(d.buildTimeoutSec < SCRIPT_BUILD_MIN_SEC && { buildTimeoutSec: SCRIPT_BUILD_SEC }),
          ...(d.composeTimeoutSec < SCRIPT_UP_MIN_SEC && { composeTimeoutSec: SCRIPT_UP_SEC }),
        })),
      },
    }),
  })

  // Rows 16 and 22.
  const notSudo = deployments.filter((d) => d.useSudo !== 'yes')
  checks.push({
    id: 'sudo',
    level: notSudo.length ? 'differs' : 'ok',
    title: 'Docker runs with sudo',
    script: "Always runs sudo docker, so builds and pulls use root's Docker login.",
    opsdeck: notSudo.length
      ? `${notSudo.map((d) => `${d.name} sudo ${d.useSudo}`).join('; ')}. Docker may run as the SSH user, with that user's Docker login.`
      : 'Every deployment runs docker with sudo.',
    ...(notSudo.length > 0 && { fix: { deployments: byId(notSudo, () => ({ useSudo: 'yes' as const })) } }),
  })

  // Rows 4, 39 and 40.
  const versionRisk = env.versioned && !isProd(env.name)
  checks.push({
    id: 'versioned',
    level: versionRisk ? 'risk' : 'ok',
    title: 'Version tags',
    script: 'Bumps the version and creates a version tag on prod only.',
    opsdeck: env.versioned
      ? versionRisk
        ? `Versioned releases are on, so every release to ${env.name} creates and pushes a version tag.${env.protected ? ' This environment is protected: change it yourself.' : ''}`
        : 'Versioned releases are on for prod; the script also tags prod only.'
      : 'Versioned releases are off: no version tag is created.',
    ...(versionRisk && !env.protected && { fix: { env: { versioned: false } } }),
  })

  // Row 11.
  const explicit = deployments.filter((d) => d.composeFile !== COMPOSE_AUTO)
  checks.push({
    id: 'compose',
    level: explicit.length ? 'differs' : 'ok',
    title: 'Compose files',
    script: 'Runs docker compose with no -f, so Compose also reads docker-compose.override.yml and COMPOSE_FILE from .env.',
    opsdeck: explicit.length
      ? `${explicit.map((d) => `${d.name} uses -f ${d.composeFile}`).join('; ')}, which skips override files and COMPOSE_FILE.`
      : 'Every deployment lets Compose find its own files.',
    ...(explicit.length > 0 && { fix: { deployments: byId(explicit, () => ({ composeFile: COMPOSE_AUTO })) } }),
  })

  // Row 45: the script starts QA after every release except on prod.
  const prod = isProd(env.name)
  const onDeploy = env.qaOnDeploy ?? true
  const started = !!env.qa && onDeploy
  checks.push({
    id: 'qa-env-name',
    level: started === !prod ? 'ok' : 'differs',
    title: 'QA workflow',
    script: prod ? 'The script never starts QA on prod.' : 'Starts the QA workflow with environment set to the --env value (alpha or uat).',
    opsdeck: !env.qa
      ? 'No QA workflow is set for this environment.'
      : `${started ? 'Starts' : 'Has'} ${env.qa.repo} ${env.qa.workflow} on ${env.qa.ref} with environment set to "${env.name}", the environment name exactly${started ? '' : ', but it is not started after a deploy'}.`,
    ...(started !== !prod && { fix: { open: 'notifications' as const } }),
  })

  // Row 46. Only meaningful when QA starts and the script would start it too.
  const wait = env.qa?.waitMinutes ?? QA_WAIT_DEFAULT_MIN
  const waits = env.qaWait ?? true
  const waitDiffers = started && !prod && (!waits || wait < SCRIPT_QA_WAIT_MIN)
  checks.push({
    id: 'qa-wait',
    level: waitDiffers ? 'differs' : 'ok',
    title: 'QA result wait',
    script: `Waits up to ${SCRIPT_QA_WAIT_MIN} minutes for the QA result.`,
    opsdeck: !started
      ? 'Not applicable: QA is not started.'
      : prod
        ? 'Not applicable: the script never starts QA on prod.'
        : waits
          ? `Waits up to ${wait} minutes for the QA result, in the background.`
          : 'OpsDeck does not wait for the QA result.',
    ...(waitDiffers && { fix: { open: 'notifications' as const } }),
  })

  // Row 32: OpsDeck is deliberately stricter, so there is nothing to fix.
  checks.push({
    id: 'strict-build',
    level: 'differs',
    title: 'Failed builds',
    script: 'The script ignored failed builds.',
    opsdeck: 'OpsDeck stops and rolls back.',
  })

  // Row 37.
  checks.push({
    id: 'rollback',
    level: 'ok',
    title: 'Rollback',
    script: 'Checks out the previous commit and starts it again.',
    opsdeck: 'OpsDeck also moves deploy tags back.',
  })

  return checks
}

/** Every fix that changes a setting, merged: one save. Empty on an environment that already matches. */
export function scriptPreset(env: ScriptEnv, deployments: ScriptDeployment[]): ScriptPreset {
  const preset: ScriptPreset = { env: {}, deployments: {} }
  for (const { fix } of checkAgainstScript(env, deployments)) {
    if (!fix) continue
    Object.assign(preset.env, fix.env)
    for (const [id, patch] of Object.entries(fix.deployments ?? {})) preset.deployments[id] = { ...preset.deployments[id], ...patch }
  }
  // The rule the checks already follow, kept here too because this is what gets saved.
  if (env.protected || isProd(env.name)) delete preset.env.versioned
  return preset
}
