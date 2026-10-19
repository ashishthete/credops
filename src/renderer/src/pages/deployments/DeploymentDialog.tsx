import { Plus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { MAX_URLS } from '../../../../shared/deploy'
import type { SecretMeta } from '../../../../shared/vault'
import { blankForm, checkForm, formFrom, toInput, toPatch, type DeploymentForm, type FormField } from '../../deploy/form'
import { createDeployment, deployStore, updateDeployment, useDeploy } from '../../deploy/store'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'
import { Segmented } from '../../ui/Segmented'
import { Switch } from '../../ui/Switch'
import { AppDialog, type AppRequest } from './AppDialog'
import { EnvTemplateEditor } from './EnvTemplateEditor'

export type DeploymentRequest = { kind: 'new'; environmentId: string } | { kind: 'edit'; id: string }

interface DeploymentDialogProps {
  request: DeploymentRequest | null
  onClose: () => void
}

const FROM = [
  { id: 'host', label: 'from host' },
  { id: 'mac', label: 'from this Mac' },
] as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 border-t border-line/60 pt-4 first:border-0 first:pt-0">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** Creates or edits a deployment. Rules are checked as you type; messages name the rule, never the value. */
export function DeploymentDialog({ request, onClose }: DeploymentDialogProps) {
  const formId = useId()
  const data = useInventory()
  const { apps } = useDeploy()
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current
  const original = r?.kind === 'edit' ? deployStore.get().deployments.find((d) => d.id === r.id) : undefined
  const environmentId = r?.kind === 'new' ? r.environmentId : (original?.environmentId ?? '')

  const [form, setForm] = useState<DeploymentForm>(blankForm)
  const [touched, setTouched] = useState<Set<FormField>>(new Set())
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [appRequest, setAppRequest] = useState<AppRequest | null>(null)

  const key = request ? (request.kind === 'new' ? `new:${request.environmentId}` : `edit:${request.id}`) : null
  useEffect(() => {
    if (!request) return
    const saved = request.kind === 'edit' ? deployStore.get().deployments.find((d) => d.id === request.id) : undefined
    setForm(saved ? formFrom(saved) : blankForm())
    setTouched(new Set())
    setServerError(null)
    setBusy(false)
    // Secret names only (never values), fetched alongside the open.
    let live = true
    api.invoke('secret:list').then(
      (list) => live && setSecrets(list ?? []),
      () => live && setSecrets([]),
    )
    return () => {
      live = false
    }
    // Reset when the dialog opens or switches deployment, not when the lists refresh mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const hosts = useMemo(() => {
    const env = data?.environments.find((e) => e.id === environmentId)
    const byId = new Map(data?.hosts.map((h) => [h.id, h]))
    return (env?.hosts ?? []).flatMap((m) => (byId.has(m.hostId) ? [byId.get(m.hostId)!] : [])).sort((a, b) => a.label.localeCompare(b.label))
  }, [data, environmentId])
  const hostApps = useMemo(() => apps.filter((a) => a.environmentId === environmentId && a.hostId === form.hostId), [apps, environmentId, form.hostId])
  const vaults = data?.vaults ?? []
  const available = useMemo(() => secrets.filter((s) => form.vaultIds.includes(s.vaultId)), [secrets, form.vaultIds])

  // A new deployment on an environment with one host starts on it.
  useEffect(() => {
    if (r?.kind === 'new' && !form.hostId && hosts.length === 1) setForm((f) => ({ ...f, hostId: hosts[0].id }))
  }, [r?.kind, form.hostId, hosts])

  const set = (patch: Partial<DeploymentForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setTouched((t) => new Set([...t, ...(Object.keys(patch) as FormField[])]))
    setServerError(null)
  }

  const result = checkForm(form)
  const valid = Object.keys(result.errors).length === 0 && result.urlErrors.every((e) => !e)
  // An empty untouched field says nothing yet; the Create button stays off until it is right.
  const err = (f: FormField) => (touched.has(f) ? result.errors[f] : undefined)

  const patch = original && valid ? toPatch(form, original) : null
  const unchanged = !!patch && Object.keys(patch).length === 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy || !r) return
    if (original) {
      if (unchanged) return onClose()
    }
    setBusy(true)
    const onError = (message: string) => {
      setServerError(message)
      setShake((n) => n + 1)
    }
    const meta = original
      ? await updateDeployment(original.id, patch!, onError)
      : await createDeployment(
          toInput(form, environmentId, deployStore.get().deployments.filter((d) => d.environmentId === environmentId).length),
          onError,
        )
    setBusy(false)
    if (meta) onClose()
  }

  const setUrl = (i: number, change: Partial<(typeof form.urls)[number]>) =>
    set({ urls: form.urls.map((u, j) => (j === i ? { ...u, ...change } : u)) })

  return (
    <>
      <Dialog
        open={request !== null}
        onClose={onClose}
        shake={shake}
        width={640}
        title={r?.kind === 'edit' ? 'Edit deployment' : 'New deployment'}
        description="A git checkout on a host that Docker Compose brings up."
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button form={formId} type="submit" loading={busy} disabled={!valid}>
              {r?.kind === 'edit' ? 'Save' : 'Create deployment'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex max-h-[62vh] flex-col gap-5 overflow-y-auto px-0.5 pb-1">
          <Section title="Source">
            <TextField label="Name" autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} error={err('name')} />
            <div className="grid grid-cols-2 gap-3">
              <SelectField label="Host" value={form.hostId} onChange={(e) => set({ hostId: e.target.value, appId: '' })} error={err('hostId')}>
                <option value="">Choose a host…</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="App"
                value={form.appId}
                disabled={!form.hostId}
                onChange={(e) => {
                  if (e.target.value === '__new') setAppRequest({ kind: 'new', environmentId, hostId: form.hostId })
                  else set({ appId: e.target.value })
                }}
              >
                <option value="">No app</option>
                {hostApps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value="__new">New app…</option>
              </SelectField>
            </div>
            <TextField
              label="Repo path"
              value={form.repoPath}
              onChange={(e) => set({ repoPath: e.target.value })}
              placeholder="/srv/app"
              className="font-mono"
              spellCheck={false}
              error={err('repoPath')}
            />
            <div className="grid grid-cols-3 gap-3">
              <TextField label="Branch" value={form.defaultBranch} onChange={(e) => set({ defaultBranch: e.target.value })} className="font-mono" spellCheck={false} error={err('defaultBranch')} />
              <TextField label="Compose file" value={form.composeFile} onChange={(e) => set({ composeFile: e.target.value })} className="font-mono" spellCheck={false} error={err('composeFile')} />
              <TextField label="Deploy tag" value={form.deployTag} onChange={(e) => set({ deployTag: e.target.value })} placeholder="deployed-prod" className="font-mono" spellCheck={false} error={err('deployTag')} />
            </div>
          </Section>

          <Section title="Health">
            <ul aria-label="Health URLs" className="flex flex-col gap-2">
              {form.urls.map((u, i) => (
                <li key={i} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TextField
                      label={`Health URL ${i + 1}`}
                      value={u.url}
                      onChange={(e) => setUrl(i, { url: e.target.value })}
                      placeholder="https://app.example.com/health"
                      className="font-mono"
                      spellCheck={false}
                      error={touched.has('urls') ? result.urlErrors[i] : undefined}
                    />
                  </div>
                  <div className="pt-[26px]">
                    <Segmented label={`Health URL ${i + 1} source`} size="sm" options={FROM} value={u.from} onChange={(from) => setUrl(i, { from })} />
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove health URL ${i + 1}`}
                    onClick={() => set({ urls: form.urls.filter((_, j) => j !== i) })}
                    className="mt-[26px] grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/6 hover:text-fg"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus aria-hidden className="size-3.5" />}
                disabled={form.urls.length >= MAX_URLS}
                onClick={() => set({ urls: [...form.urls, { url: '', from: 'host' }] })}
              >
                Add URL
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Expected status" inputMode="numeric" value={form.healthStatus} onChange={(e) => set({ healthStatus: e.target.value })} error={err('healthStatus')} />
              <TextField label="Timeout (seconds)" inputMode="numeric" value={form.healthTimeoutSec} onChange={(e) => set({ healthTimeoutSec: e.target.value })} error={err('healthTimeoutSec')} />
            </div>
          </Section>

          <Section title="Safety">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-fg">Back up the database before deploying</span>
              <Switch label="Back up the database" checked={form.dbBackup} onChange={(dbBackup) => set({ dbBackup })} />
            </div>
            {form.dbBackup && (
              <TextField label="Backup directory" value={form.backupDir} onChange={(e) => set({ backupDir: e.target.value })} placeholder="/srv/backups" className="font-mono" spellCheck={false} error={err('backupDir')} />
            )}
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Build timeout (seconds)" inputMode="numeric" value={form.buildTimeoutSec} onChange={(e) => set({ buildTimeoutSec: e.target.value })} error={err('buildTimeoutSec')} />
              <TextField label="Compose timeout (seconds)" inputMode="numeric" value={form.composeTimeoutSec} onChange={(e) => set({ composeTimeoutSec: e.target.value })} error={err('composeTimeoutSec')} />
            </div>
          </Section>

          <Section title="Privilege">
            <div className="grid grid-cols-2 gap-3">
              <SelectField label="Use sudo" value={form.useSudo} onChange={(e) => set({ useSudo: e.target.value as DeploymentForm['useSudo'] })}>
                <option value="auto">Automatic</option>
                <option value="yes">Always</option>
                <option value="no">Never</option>
              </SelectField>
              {form.useSudo !== 'no' && (
                <SelectField label="Become secret" value={form.becomeSecretId} onChange={(e) => set({ becomeSecretId: e.target.value })} hint="The sudo password, if it needs one">
                  <option value="">None</option>
                  {available.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </SelectField>
              )}
            </div>
          </Section>

          <Section title="Hooks">
            <TextAreaField label="Pre-deploy hook" value={form.preHook} onChange={(e) => set({ preHook: e.target.value })} rows={2} className="font-mono text-[12.5px]" spellCheck={false} error={err('preHook')} />
            <TextAreaField label="Post-deploy hook" value={form.postHook} onChange={(e) => set({ postHook: e.target.value })} rows={2} className="font-mono text-[12.5px]" spellCheck={false} error={err('postHook')} />
          </Section>

          <Section title="Environment">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-fg">Manage the .env file</span>
              <Switch label="Manage the .env file" checked={form.managedEnv} onChange={(managedEnv) => set({ managedEnv })} />
            </div>
            {(form.managedEnv || form.useSudo !== 'no') && vaults.length > 0 && (
              <fieldset className="flex flex-wrap items-center gap-1.5">
                <legend className="mb-1.5 text-[12.5px] font-medium text-fg/90">Secrets come from</legend>
                {vaults.map((v) => {
                  const on = form.vaultIds.includes(v.id)
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const vaultIds = on ? form.vaultIds.filter((id) => id !== v.id) : [...form.vaultIds, v.id]
                        // A become secret from a deselected vault can't be used any more.
                        const becomeVault = secrets.find((s) => s.id === form.becomeSecretId)?.vaultId
                        set({ vaultIds, ...(becomeVault && !vaultIds.includes(becomeVault) ? { becomeSecretId: '' } : {}) })
                      }}
                      className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors ${
                        on ? 'border-accent/50 bg-accent/12 text-fg' : 'border-line text-muted hover:text-fg'
                      }`}
                    >
                      <span aria-hidden className="size-1.5 rounded-full" style={{ background: v.color }} />
                      {v.name}
                    </button>
                  )
                })}
              </fieldset>
            )}
            {form.managedEnv && (
              <EnvTemplateEditor
                value={form.envTemplate}
                onChange={(envTemplate) => set({ envTemplate })}
                secrets={secrets}
                available={available}
                vaults={vaults}
                error={form.envTemplate ? result.errors.envTemplate : undefined}
              />
            )}
          </Section>

          {serverError && (
            <p role="alert" className="text-[12.5px] text-err">
              {serverError}
            </p>
          )}
        </form>
      </Dialog>
      <AppDialog request={appRequest} onClose={() => setAppRequest(null)} onSaved={(id) => set({ appId: id })} />
    </>
  )
}
