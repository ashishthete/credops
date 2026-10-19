import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { COMPOSE_PROJECT } from '../../../../shared/deploy'
import { MAX_DESCRIPTION, MAX_NAME } from '../../../../shared/inventory'
import { createApp, deployStore, updateApp, useDeploy } from '../../deploy/store'
import { useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'

export type AppRequest = { kind: 'new'; environmentId: string } | { kind: 'edit'; id: string }

interface AppDialogProps {
  request: AppRequest | null
  onClose: () => void
  /** Called with the new app, so a deployment dialog can pick it. */
  onSaved?: (id: string) => void
  onDelete?: (id: string) => void
}

/** Creates or edits an app: a named group of deployments on one host. */
export function AppDialog({ request, onClose, onSaved, onDelete }: AppDialogProps) {
  const formId = useId()
  const data = useInventory()
  const { apps } = useDeploy()
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current
  const original = r?.kind === 'edit' ? apps.find((a) => a.id === r.id) : undefined
  const environmentId = r?.kind === 'new' ? r.environmentId : (original?.environmentId ?? '')

  const [name, setName] = useState('')
  const [hostId, setHostId] = useState('')
  const [project, setProject] = useState('')
  const [description, setDescription] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)

  const key = request ? (request.kind === 'new' ? `new:${request.environmentId}` : `edit:${request.id}`) : null
  const hosts = useMemo(() => {
    const env = data?.environments.find((e) => e.id === environmentId)
    const byId = new Map(data?.hosts.map((h) => [h.id, h]))
    return (env?.hosts ?? []).flatMap((m) => (byId.has(m.hostId) ? [byId.get(m.hostId)!] : [])).sort((a, b) => a.label.localeCompare(b.label))
  }, [data, environmentId])

  useEffect(() => {
    if (!request) return
    const a = request.kind === 'edit' ? deployStore.get().apps.find((a) => a.id === request.id) : undefined
    setName(a?.name ?? '')
    setHostId(a?.hostId ?? '')
    setProject(a?.composeProject ?? '')
    setDescription(a?.description ?? '')
    setServerError(null)
    setBusy(false)
    // Reset when the dialog opens or switches app, not when the list refreshes mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // A new app defaults to the environment's only host.
  useEffect(() => {
    if (r?.kind === 'new' && !hostId && hosts.length === 1) setHostId(hosts[0].id)
  }, [r?.kind, hostId, hosts])

  const errors = {
    name: !name.trim() ? 'Give the app a name' : name.trim().length > MAX_NAME ? `A name can be at most ${MAX_NAME} characters` : undefined,
    hostId: !hostId ? 'Pick the host it runs on' : undefined,
    project: project.trim() && !COMPOSE_PROJECT.test(project.trim()) ? 'A compose project uses letters, digits and . _ - only, starting with a letter or digit' : undefined,
    description: description.length > MAX_DESCRIPTION ? `A description can be at most ${MAX_DESCRIPTION} characters` : undefined,
  }
  const valid = !errors.name && !errors.hostId && !errors.project && !errors.description

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy || !r) return
    setBusy(true)
    const onError = (message: string) => {
      setServerError(message)
      setShake((n) => n + 1)
    }
    const composeProject = project.trim() || null
    const meta =
      r.kind === 'edit'
        ? await updateApp(r.id, { name: name.trim(), composeProject, description }, onError)
        : await createApp({ environmentId: r.environmentId, hostId, name: name.trim(), composeProject, description }, onError)
    setBusy(false)
    if (!meta) return
    onSaved?.(meta.id)
    onClose()
  }

  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      shake={shake}
      title={r?.kind === 'edit' ? 'Edit app' : 'New app'}
      description="An app groups the deployments of one service on a host."
      footer={
        <>
          {r?.kind === 'edit' && onDelete && (
            <Button variant="danger" className="mr-auto" onClick={() => onDelete(r.id)} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button form={formId} type="submit" loading={busy} disabled={!valid}>
            {r?.kind === 'edit' ? 'Save' : 'Create app'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3.5">
        <TextField label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} error={name ? errors.name : undefined} />
        <SelectField label="Host" value={hostId} onChange={(e) => setHostId(e.target.value)} disabled={r?.kind === 'edit'}>
          <option value="">Choose a host…</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Compose project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="Optional"
          className="font-mono"
          error={errors.project}
        />
        <TextAreaField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} error={errors.description} />
        {serverError && (
          <p role="alert" className="text-[12.5px] text-err">
            {serverError}
          </p>
        )}
      </form>
    </Dialog>
  )
}
