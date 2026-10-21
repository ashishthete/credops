import { ChevronRight } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { DeploymentMeta, EnvDeploySettings as Settings } from '../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import { rememberSettingsOpen, settingsOpen } from '../../deploy/settings-open'
import { EnvDeploySettings } from './EnvDeploySettings'
import { useScriptChecks } from './useScriptChecks'

/**
 * The environment's release settings and its comparison with unified_release.sh, folded away. The first time an
 * environment is shown this session, it opens by itself when the comparison flags something; after that it keeps
 * what it was, or what the user made it.
 */
export function EnvSettingsSection({
  envId,
  settings,
  environment,
  deployments,
  loaded,
}: {
  envId: string
  settings: Settings | undefined
  /** A local environment; a Hub one has no comparison here. */
  environment?: EnvironmentMeta
  deployments: DeploymentMeta[]
  /** The deployments have been read: before that an empty list would compare as no differences. */
  loaded: boolean
}) {
  const remembered = settingsOpen(envId)
  const [open, setOpen] = useState(remembered ?? false)
  const bodyId = useId()
  const script = useScriptChecks(environment, settings, deployments)
  // Whether the comparison can be trusted yet: a Hub environment has none, so it is settled at once.
  const settled = remembered !== undefined || !environment || (!!script?.ready && loaded)

  useEffect(() => {
    if (!settled || settingsOpen(envId) !== undefined) return
    const flagged = (script?.flagged ?? 0) > 0
    rememberSettingsOpen(envId, flagged)
    if (flagged) setOpen(true)
  }, [settled, envId, script])

  const toggle = () => {
    rememberSettingsOpen(envId, !open)
    setOpen(!open)
  }

  const summary = settings ? [settings.versioned ? 'Versioned' : 'Not versioned', settings.autoRollback ? 'auto-rollback' : null, settings.currentVersion].filter(Boolean).join(' · ') : ''
  return (
    <section aria-label="Settings" aria-busy={!settled || undefined} className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={toggle}
        className="flex items-center gap-1.5 self-start rounded-md text-left text-[12.5px] font-semibold text-fg/90 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        Settings
        {summary && <span className="ml-1 font-normal text-muted">{summary}</span>}
      </button>
      {open && (
        <div id={bodyId}>
          <EnvDeploySettings settings={settings} environment={environment} deployments={deployments} script={script} />
        </div>
      )}
    </section>
  )
}
