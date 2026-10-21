import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { COMPOSE_AUTO, type DeployBatch, type DeploymentMeta, type EnvDeploySettings } from '../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import { checkAgainstScript, scriptPreset, type ScriptCheckLevel, type ScriptDeploymentPatch, type ScriptPreset } from '../../../../shared/script-parity'
import type { QaWorkflow } from '../../../../shared/settings'
import { applyDeployBatch } from '../../deploy/store'
import { environmentKey } from '../../inventory/tree'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog, type ConfirmRequest } from '../../ui/common'
import { toast } from '../../ui/Toaster'

const TITLE = 'Compared with unified_release.sh'
const DOT: Record<ScriptCheckLevel, string> = { ok: 'bg-ok', differs: 'bg-warn', risk: 'bg-err' }
const LEVEL: Record<ScriptCheckLevel, string> = { ok: 'Same', differs: 'Differs', risk: 'Risk' }

const FIELD: Record<keyof ScriptDeploymentPatch, string> = {
  buildTimeoutSec: 'build limit',
  composeTimeoutSec: 'start limit',
  useSudo: 'sudo',
  composeFile: 'compose file',
}
const show = (k: keyof ScriptDeploymentPatch, v: unknown) =>
  k === 'composeFile' && v === COMPOSE_AUTO ? 'found by Compose' : k === 'buildTimeoutSec' || k === 'composeTimeoutSec' ? `${v} s` : String(v)

/** One line per changed value, for the confirm. */
function describe(preset: ScriptPreset, settings: EnvDeploySettings, deployments: DeploymentMeta[]): string[] {
  const lines: string[] = []
  if (preset.env.versioned !== undefined) lines.push(`Versioned releases: ${settings.versioned ? 'on' : 'off'} → ${preset.env.versioned ? 'on' : 'off'}`)
  for (const d of deployments) {
    const patch = preset.deployments[d.id]
    if (!patch) continue
    for (const k of Object.keys(patch) as (keyof ScriptDeploymentPatch)[]) lines.push(`${d.name}: ${FIELD[k]} ${show(k, d[k])} → ${show(k, patch[k])}`)
  }
  return lines
}

function toBatch(preset: ScriptPreset, deployments: DeploymentMeta[]): DeployBatch {
  return {
    ...(preset.env.versioned !== undefined && { settings: { versioned: preset.env.versioned } }),
    deployments: deployments.filter((d) => preset.deployments[d.id]).map((d) => ({ id: d.id, patch: preset.deployments[d.id] })),
  }
}

/** The same fields at the values they hold now. */
function undoOf(batch: DeployBatch, settings: EnvDeploySettings, deployments: DeploymentMeta[]): DeployBatch {
  const byId = new Map(deployments.map((d) => [d.id, d]))
  return {
    ...(batch.settings && { settings: { versioned: settings.versioned } }),
    deployments: batch.deployments.map(({ id, patch }) => {
      const d = byId.get(id)!
      return { id, patch: Object.fromEntries(Object.keys(patch).map((k) => [k, d[k as keyof ScriptDeploymentPatch]])) }
    }),
  }
}

/**
 * Checks this environment's deploy config against what deployment/unified_release.sh does, and saves every
 * script-compatible setting in one go. QA settings live in the environment's Notifications; rows about them link there.
 */
export function ScriptCompare({ environment, settings, deployments }: { environment: EnvironmentMeta; settings: EnvDeploySettings; deployments: DeploymentMeta[] }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // undefined while loading; null when it couldn't be read (the QA rows are left out rather than guessed).
  const [qa, setQa] = useState<{ value: QaWorkflow | null } | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setQa(undefined)
    api.invoke('integration:get', environment.id).then(
      (s) => live && setQa(s ? { value: s.qa } : null),
      () => live && setQa(null),
    )
    return () => {
      live = false
    }
  }, [environment.id])

  const env = useMemo(
    () => ({ name: environment.name, protected: environment.protected, versioned: settings.versioned, qa: qa?.value ?? null }),
    [environment.name, environment.protected, settings.versioned, qa],
  )
  const checks = useMemo(() => checkAgainstScript(env, deployments).filter((c) => qa || !c.id.startsWith('qa-')), [env, deployments, qa])
  const preset = useMemo(() => scriptPreset(env, deployments), [env, deployments])
  const lines = useMemo(() => describe(preset, settings, deployments), [preset, settings, deployments])
  const flagged = checks.filter((c) => c.level !== 'ok').length

  const apply = () => {
    const batch = toBatch(preset, deployments)
    const undo = undoOf(batch, settings, deployments)
    setConfirm({
      title: 'Apply script-compatible settings?',
      description: `These changes to ${environment.name} are saved together:`,
      code: lines.join('\n'),
      confirmLabel: 'Apply',
      gentle: { cancelLabel: 'Cancel' },
      run: async () => {
        if (!(await applyDeployBatch(environment.id, batch))) return
        toast({
          title: 'Script-compatible settings saved',
          tone: 'success',
          action: { label: 'Undo', run: () => void applyDeployBatch(environment.id, undo) },
        })
      },
    })
  }

  return (
    <section aria-label={TITLE} className="rounded-xl border border-line bg-surface/60 px-4 py-3">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-1.5 text-left text-[12.5px] font-semibold text-fg" onClick={() => setOpen((v) => !v)}>
        <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {TITLE}
        <span className="ml-1 font-normal text-muted">{flagged ? `${flagged} ${flagged === 1 ? 'difference' : 'differences'}` : 'no differences'}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <ul className="flex flex-col gap-2.5">
            {checks.map((c) => (
              <li key={c.id} aria-label={c.title} data-level={c.level} className="flex gap-2.5">
                <span aria-hidden className={`mt-[5px] size-2 shrink-0 rounded-full ${DOT[c.level]}`} />
                <div className="min-w-0 flex-1 text-[12.5px] leading-5">
                  <p className="font-medium text-fg">
                    {c.title} <span className="sr-only">{LEVEL[c.level]}</span>
                  </p>
                  <p className="text-muted">Script: {c.script}</p>
                  <p className="text-fg/90">OpsDeck: {c.opsdeck}</p>
                </div>
                {c.fix?.open === 'notifications' && (
                  <Button size="sm" variant="ghost" className="shrink-0 self-start" onClick={() => navigate(`/products?${new URLSearchParams({ node: environmentKey(environment) })}`)}>
                    Open notification settings
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" disabled={lines.length === 0} onClick={apply}>
              Apply script-compatible settings
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}
