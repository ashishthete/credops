import { useEffect, useMemo, useState } from 'react'
import type { DeploymentMeta, EnvDeploySettings } from '../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import { checkAgainstScript, isFlagged, type ScriptCheck, type ScriptEnv } from '../../../../shared/script-parity'
import type { EnvironmentIntegrations } from '../../../../shared/settings'
import { api } from '../../lib/api'

export interface ScriptChecks {
  env: ScriptEnv
  checks: ScriptCheck[]
  /** Risks, and differences there is something to change for. */
  flagged: number
  /** The QA settings have been read (or failed to): until then the QA rows are left out and `flagged` may grow. */
  ready: boolean
}

/**
 * One environment's comparison with unified_release.sh. The QA settings are read here once; when they can't be
 * read the QA rows are left out rather than guessed. Null with no environment (a Hub one) or no settings yet.
 */
export function useScriptChecks(environment: EnvironmentMeta | undefined, settings: EnvDeploySettings | undefined, deployments: DeploymentMeta[]): ScriptChecks | null {
  // undefined while loading; null when it couldn't be read.
  const [qa, setQa] = useState<Pick<EnvironmentIntegrations, 'qa' | 'qaOnDeploy' | 'qaWait'> | null | undefined>(undefined)
  const envId = environment?.id
  useEffect(() => {
    if (!envId) return
    let live = true
    setQa(undefined)
    api.invoke('integration:get', envId).then(
      (s) => live && setQa(s ? { qa: s.qa, qaOnDeploy: s.qaOnDeploy, qaWait: s.qaWait } : null),
      () => live && setQa(null),
    )
    return () => {
      live = false
    }
  }, [envId])

  const versioned = settings?.versioned
  const env = useMemo(
    () => (environment && versioned !== undefined ? { name: environment.name, protected: environment.protected, versioned, ...(qa ?? { qa: null }) } : null),
    [environment, versioned, qa],
  )
  return useMemo(() => {
    if (!env) return null
    const checks = checkAgainstScript(env, deployments).filter((c) => qa || !c.id.startsWith('qa-'))
    return { env, checks, flagged: checks.filter(isFlagged).length, ready: qa !== undefined }
  }, [env, deployments, qa])
}
