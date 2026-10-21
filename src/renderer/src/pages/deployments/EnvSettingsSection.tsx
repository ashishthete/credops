import { ChevronRight } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DeploymentMeta, EnvDeploySettings as Settings } from '../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import type { QaWorkflow } from '../../../../shared/settings'
import { checkAgainstScript } from '../../../../shared/script-parity'
import { api } from '../../lib/api'
import { EnvDeploySettings } from './EnvDeploySettings'

/**
 * The environment's release settings and its comparison with unified_release.sh, folded away. It opens by itself,
 * once, when the comparison first finds a difference to fix; after the user toggles it, it is theirs.
 */
export function EnvSettingsSection({
  settings,
  environment,
  deployments,
  loaded,
}: {
  settings: Settings | undefined
  environment?: EnvironmentMeta
  deployments: DeploymentMeta[]
  /** The deployments have been read: before that an empty list would compare as no differences. */
  loaded: boolean
}) {
  const [open, setOpen] = useState(false)
  const decided = useRef(false)
  const bodyId = useId()
  const differs = useDiffers(settings, environment, deployments, loaded)

  useEffect(() => {
    if (decided.current || differs === undefined) return
    decided.current = true
    if (differs) setOpen(true)
  }, [differs])

  const summary = settings ? [settings.versioned ? 'Versioned' : 'Not versioned', settings.autoRollback ? 'auto-rollback' : null, settings.currentVersion].filter(Boolean).join(' · ') : ''
  return (
    <section aria-label="Settings" className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          decided.current = true
          setOpen((v) => !v)
        }}
        className="flex items-center gap-1.5 self-start rounded-md text-left text-[12.5px] font-semibold text-fg/90 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        Settings
        {summary && <span className="ml-1 font-normal text-muted">{summary}</span>}
      </button>
      {open && (
        <div id={bodyId}>
          <EnvDeploySettings settings={settings} environment={environment} deployments={deployments} />
        </div>
      )}
    </section>
  )
}

/** Whether the comparison with unified_release.sh finds a difference to fix; undefined until it can tell. Mirrors ScriptCompare. */
function useDiffers(settings: Settings | undefined, environment: EnvironmentMeta | undefined, deployments: DeploymentMeta[], loaded: boolean): boolean | undefined {
  // undefined while loading; null when it couldn't be read (the QA checks are left out, as ScriptCompare does).
  const [qa, setQa] = useState<{ value: QaWorkflow | null } | null | undefined>(undefined)
  const envId = environment?.id
  useEffect(() => {
    if (!envId) return
    let live = true
    setQa(undefined)
    api.invoke('integration:get', envId).then(
      (s) => live && setQa(s ? { value: s.qa } : null),
      () => live && setQa(null),
    )
    return () => {
      live = false
    }
  }, [envId])
  return useMemo(() => {
    // A Hub environment has no comparison here.
    if (!environment) return settings ? false : undefined
    if (!settings || !loaded || qa === undefined) return undefined
    const env = { name: environment.name, protected: environment.protected, versioned: settings.versioned, qa: qa?.value ?? null }
    // Only differences the user can act on: some (OpsDeck's stricter failed builds) are always there and have no fix.
    return checkAgainstScript(env, deployments).some((c) => c.level !== 'ok' && !!c.fix && (qa || !c.id.startsWith('qa-')))
  }, [environment, settings, qa, deployments, loaded])
}
