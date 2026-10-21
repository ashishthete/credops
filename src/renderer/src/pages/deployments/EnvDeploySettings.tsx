import { useState, type FormEvent } from 'react'
import { VERSION, type DeploymentMeta, type EnvDeploySettings as Settings } from '../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import { updateSettings } from '../../deploy/store'
import { Button } from '../../ui/Button'
import { TextField } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { ScriptCompare } from './ScriptCompare'

/**
 * One environment's release settings: versioned tags, auto-rollback, and the current version. With `environment`
 * (a local one: a Hub environment's settings are not edited here), also the comparison with unified_release.sh.
 */
export function EnvDeploySettings({
  settings,
  environment,
  deployments = [],
}: {
  settings: Settings | undefined
  environment?: EnvironmentMeta
  deployments?: DeploymentMeta[]
}) {
  const [busy, setBusy] = useState<'versioned' | 'autoRollback' | 'version' | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!settings) {
    return <div aria-hidden className="h-[52px] rounded-xl border border-line bg-surface/50" />
  }
  const id = settings.environmentId

  const toggle = async (field: 'versioned' | 'autoRollback', value: boolean) => {
    setBusy(field)
    await updateSettings(id, { [field]: value })
    setBusy(null)
  }

  const draftError = draft.trim() && !VERSION.test(draft.trim()) ? 'A version looks like v1.2.3' : undefined
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (draftError) return
    setBusy('version')
    const ok = await updateSettings(id, { currentVersion: draft.trim() || null })
    setBusy(null)
    if (ok) setEditing(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Deploy settings" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-surface/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Switch label="Versioned releases" checked={settings.versioned} busy={busy === 'versioned'} onChange={(v) => void toggle('versioned', v)} />
          <span className="text-[12.5px] text-fg/90">Versioned</span>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch label="Auto-rollback" checked={settings.autoRollback} busy={busy === 'autoRollback'} onChange={(v) => void toggle('autoRollback', v)} />
          <span className="text-[12.5px] text-fg/90">Auto-rollback</span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {editing ? (
            <form onSubmit={save} className="flex items-start gap-2">
              <TextField
                label="Current version"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="v1.2.3"
                className="w-32 font-mono"
                error={draftError}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(false))}
              />
              <div className="flex gap-1.5 pt-[26px]">
                <Button size="sm" type="submit" loading={busy === 'version'} disabled={!!draftError}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <span className="text-[12.5px] text-muted">Current version</span>
              <span data-testid="current-version" className="font-mono text-[13px] font-medium text-fg tabular-nums">
                {settings.currentVersion ?? 'none'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(settings.currentVersion ?? '')
                  setEditing(true)
                }}
              >
                Correct
              </Button>
            </>
          )}
        </div>
      </section>
      {environment && <ScriptCompare environment={environment} settings={settings} deployments={deployments} />}
    </div>
  )
}
