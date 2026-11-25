import { Trash2 } from 'lucide-react'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { HealthFrom } from '../../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../../shared/inventory'
import {
  COMPOSE_SERVICE,
  DB_DEFAULT_PORT,
  SERVICE_KIND_LABEL,
  type DbEngine,
  type ServiceInput,
  type ServiceKind,
  type ServiceMeta,
  type ServicePatch,
} from '../../../../../shared/services'
import { createService, deleteService, markRouteChanged, syncServiceTunnel, updateService, useDeployments, useServices } from '../../../deploy/store'
import { hostsByRegion } from '../../../inventory/regions'
import { useInventory } from '../../../inventory/store'
import { tunnelStore } from '../../../tunnels/store'
import { Button } from '../../../ui/Button'
import { ConfirmDialog, type ConfirmRequest } from '../../../ui/common'
import { Dialog } from '../../../ui/Dialog'
import { SelectField, TextField } from '../../../ui/Field'
import { Segmented } from '../../../ui/Segmented'
import { Switch } from '../../../ui/Switch'

const ENGINES: { id: DbEngine; label: string }[] = [
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mongodb', label: 'MongoDB' },
  { id: 'redis', label: 'Redis' },
  { id: 'other', label: 'Other' },
]

const KINDS = (['service', 'db', 'bastion'] as const).map((id) => ({ id, label: SERVICE_KIND_LABEL[id] }))

const CHECK_FROM = [
  { id: 'mac', label: 'This Mac' },
  { id: 'host', label: 'The host' },
] as const

interface Form {
  kind: ServiceKind
  name: string
  description: string
  /** The host the service runs on; an app with a checkout follows the checkout's. */
  hostId: string
  deploymentId: string
  composeService: string
  /** Until the user edits it, the compose service follows the name. */
  composeEdited: boolean
  url: string
  urlCheckFrom: HealthFrom
  skipUnchanged: boolean
  dbEngine: DbEngine
  dbAddress: string
  dbPort: string
  localPort: string
}

function formOf(service: ServiceMeta | undefined, kind: ServiceKind = 'service', hostId = ''): Form {
  const blank: Form = {
    kind,
    name: '',
    description: '',
    hostId,
    deploymentId: '',
    composeService: '',
    composeEdited: false,
    url: '',
    urlCheckFrom: 'mac',
    skipUnchanged: false,
    dbEngine: 'postgres',
    dbAddress: '127.0.0.1',
    dbPort: String(DB_DEFAULT_PORT.postgres),
    localPort: '',
  }
  if (!service) return blank
  const base = { ...blank, kind: service.kind, name: service.name, description: service.description, hostId: service.hostId }
  if (service.kind === 'bastion') return base
  if (service.kind === 'service') {
    return {
      ...base,
      deploymentId: service.deploymentId ?? '',
      composeService: service.composeService,
      composeEdited: true,
      url: service.url ?? '',
      urlCheckFrom: service.urlCheckFrom,
      skipUnchanged: service.skipUnchanged,
    }
  }
  return {
    ...base,
    dbEngine: service.dbEngine,
    dbAddress: service.dbAddress,
    dbPort: String(service.dbPort),
    localPort: service.localPort == null ? '' : String(service.localPort),
  }
}

/** The first of `base`, `base 2`, `base 3`… not in `taken` (compared without case). */
function freeName(base: string, taken: string[], sep: string): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!used.has(`${base}${sep}${n}`.toLowerCase())) return `${base}${sep}${n}`
}

/**
 * A new service's form filled from `source`: named "<name> copy" and, in the same checkout, a compose
 * service of its own (both must be unique). A db's local port is left to be picked, so the two tunnels
 * don't fight over it.
 */
export function duplicateForm(source: ServiceMeta, siblings: ServiceMeta[]): Form {
  const f = formOf(source)
  const name = freeName(`${source.name} copy`, siblings.map((s) => s.name), ' ')
  if (source.kind !== 'service') return { ...f, name, localPort: '' }
  const sameCheckout = siblings.filter((s): s is ServiceMeta & { kind: 'service' } => s.kind === 'service' && s.deploymentId === source.deploymentId)
  const composeService = source.deploymentId ? freeName(`${source.composeService}-copy`, sameCheckout.map((s) => s.composeService), '-') : f.composeService
  return { ...f, name, composeService }
}

const asPort = (s: string): number | null => (/^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535 ? +s : null)

type Field = 'name' | 'hostId' | 'composeService' | 'url' | 'dbAddress' | 'dbPort' | 'localPort'

function check(f: Form): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {}
  if (f.name.trim() === '') out.name = 'A name is required'
  if (f.hostId === '' && !(f.kind === 'service' && f.deploymentId)) out.hostId = 'Pick the host it runs on'
  if (f.kind === 'service') {
    if (f.deploymentId !== '' && !COMPOSE_SERVICE.test(f.composeService)) out.composeService = 'Letters, digits, dot, dash and underscore; starting with a letter or digit'
    if (f.url.trim() !== '' && !/^https?:\/\/\S+$/i.test(f.url.trim())) out.url = 'A URL starts with http:// or https://'
  } else if (f.kind === 'db') {
    if (f.dbAddress.trim() === '') out.dbAddress = 'An address is required'
    if (asPort(f.dbPort) === null) out.dbPort = 'A port is a number from 1 to 65535'
    if (f.localPort !== '' && asPort(f.localPort) === null) out.localPort = 'A port is a number from 1 to 65535'
  }
  return out
}

function toInput(f: Form, environmentId: string): ServiceInput {
  const name = f.name.trim()
  const kind = f.kind
  if (kind === 'bastion') return { kind, environmentId, hostId: f.hostId, name, description: f.description.trim() }
  if (kind === 'service') {
    return {
      kind,
      environmentId,
      name,
      ...(f.hostId ? { hostId: f.hostId } : {}),
      deploymentId: f.deploymentId || null,
      // Without a checkout there is nothing to run, so no compose service.
      composeService: f.deploymentId ? f.composeService : '',
      url: f.url.trim() || null,
      urlCheckFrom: f.urlCheckFrom,
      skipUnchanged: f.skipUnchanged,
    }
  }
  return {
    kind,
    environmentId,
    name,
    dbEngine: f.dbEngine,
    dbAddress: f.dbAddress.trim(),
    hostId: f.hostId,
    dbPort: asPort(f.dbPort)!,
    localPort: f.localPort === '' ? null : asPort(f.localPort),
  }
}

/** Only the fields that differ from the saved service. */
function toPatch(f: Form, saved: ServiceMeta): ServicePatch {
  const next = toInput({ ...f, kind: saved.kind }, saved.environmentId) as unknown as Record<string, unknown>
  const before = saved as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) if (k !== 'kind' && k !== 'environmentId' && v !== before[k]) out[k] = v
  return out as ServicePatch
}

/** The delete confirmation for a service; a db with a tunnel offers to delete the tunnel too, checked by default. */
export function deleteRequest(env: EnvironmentMeta, svc: ServiceMeta, onDone?: () => void): ConfirmRequest {
  const tunnelId = svc.kind === 'db' ? svc.tunnelId : null
  // The tunnel list may not be loaded yet; the service's name stands in for the label (the tunnel is named after it).
  const tunnelLabel = tunnelId ? (tunnelStore.get().tunnels.find((t) => t.id === tunnelId)?.label ?? svc.name) : null
  const guarded = env.protected ? env.name : undefined
  return {
    title: `Delete ${svc.name}?`,
    description: guarded
      ? `${guarded} is protected. Deleting a service removes it from ${env.name}; its checkout and release history stay.`
      : `This removes the service from ${env.name}; its checkout and release history stay.`,
    confirmLabel: 'Delete service',
    typeToConfirm: guarded,
    option: tunnelLabel ? { label: `Also delete its tunnel ${tunnelLabel}`, defaultChecked: true } : undefined,
    run: async (checked?: boolean) => {
      const done = await deleteService(svc.id, !!tunnelLabel && checked === true)
      if (done) onDone?.()
      return done
    },
  }
}

interface ServiceDialogProps {
  env: EnvironmentMeta
  service?: ServiceMeta
  /** Adds a new service filled from this one (Duplicate). Ignored with `service`. */
  copyOf?: ServiceMeta
  /** A new service's starting type (App when absent); the user can change it until it is saved. */
  kind?: ServiceKind
  /** A new service's starting host (from a host's page). */
  hostId?: string
  onClose: () => void
}

/** Adds or edits an app, a database or a bastion, each on a host. Mounted while open. */
export function ServiceDialog({ env, service, copyOf, kind: initialKind, hostId: initialHost, onClose }: ServiceDialogProps) {
  const formId = useId()
  const data = useInventory()
  const checkouts = useDeployments(env.id)
  const siblings = useServices(env.id)
  const [form, setForm] = useState<Form>(() => (!service && copyOf ? duplicateForm(copyOf, siblings) : formOf(service, initialKind, initialHost)))
  const [touched, setTouched] = useState<Set<Field>>(new Set())
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)
  const [prompt, setPrompt] = useState<ConfirmRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const restarted = useRef(false)

  // Every host, one group per region; the environment's own hosts are marked.
  const hostGroups = useMemo(() => {
    const inEnv = new Set(env.hosts.map((h) => h.hostId))
    return hostsByRegion(
      data?.regions ?? [],
      (data?.hosts ?? []).map((h) => ({ hostId: h.id, label: h.label, regionId: h.regionId, inEnv: inEnv.has(h.id) })),
    )
  }, [data, env.hosts])
  const checkoutHost = useMemo(() => new Map(checkouts.map((d) => [d.id, d.hostId])), [checkouts])

  const set = (patch: Partial<Form>, fields: Field[] = []) => {
    setForm((f) => ({ ...f, ...patch }))
    if (fields.length) setTouched((t) => new Set([...t, ...fields]))
    setServerError(null)
  }

  const kind = form.kind
  const errors = check(form)
  const valid = Object.keys(errors).length === 0
  const err = (f: Field) => (touched.has(f) ? errors[f] : undefined)
  const isDb = kind === 'db'
  const isApp = kind === 'service'
  const noun = isDb ? 'database' : kind === 'bastion' ? 'bastion' : 'app'
  const title = service ? `Edit ${service.name}` : copyOf ? `Duplicate ${copyOf.name}` : 'Add service'
  // A checkout runs on one host, so an app with a checkout runs there.
  const lockedHost = isApp && form.deploymentId !== '' ? (checkoutHost.get(form.deploymentId) ?? '') : null
  const DESCRIPTION = {
    service: 'An app on a host, optionally deployed from a checkout.',
    db: 'A database on a host, at its address as seen from that host. Its tunnel goes through the host.',
    bastion: 'A host this environment is reached through.',
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    const onError = (message: string) => {
      setServerError(message)
      setShake((n) => n + 1)
    }
    if (!service) {
      setBusy(true)
      const meta = await createService(toInput(form, env.id), onError)
      setBusy(false)
      if (meta) onClose()
      return
    }
    const patch = toPatch(form, service)
    if (Object.keys(patch).length === 0) return onClose()
    setBusy(true)
    const out = await updateService(service.id, patch, onError)
    setBusy(false)
    if (!out) return
    if (!out.tunnelRestartNeeded) return onClose()
    restarted.current = false
    setPrompt({
      title: `Restart the ${out.service.name} tunnel with the new route?`,
      description: 'Its open connections drop while it restarts. Later keeps the old route until the tunnel restarts.',
      confirmLabel: 'Restart',
      gentle: { cancelLabel: 'Later' },
      // A failed restart leaves the old route running, so closing still marks the route changed.
      run: async () => {
        restarted.current = await syncServiceTunnel(out.service.id)
      },
    })
  }

  const closePrompt = () => {
    if (!restarted.current && service) markRouteChanged(service.id)
    setPrompt(null)
    onClose()
  }

  return (
    <>
      <Dialog
        open={!prompt}
        onClose={onClose}
        shake={shake}
        width={520}
        title={title}
        description={DESCRIPTION[kind]}
        footer={
          <>
            {service && (
              <Button
                variant="ghost"
                className="mr-auto"
                icon={<Trash2 aria-hidden className="size-3.5" />}
                onClick={() => setConfirm(deleteRequest(env, service, onClose))}
                disabled={busy}
              >
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button form={formId} type="submit" loading={busy} disabled={!valid}>
              {service ? 'Save' : `Add ${noun}`}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate aria-label={`The ${noun}`} className="flex flex-col gap-3">
          {!service && !copyOf && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] font-medium text-fg/90">Type</span>
              <Segmented label="Type" size="sm" options={KINDS} value={kind} onChange={(k) => set({ kind: k })} />
            </div>
          )}
          <TextField
            label="Name"
            autoFocus
            value={form.name}
            onChange={(e) => {
              const name = e.target.value
              set({ name, ...(!isApp || form.composeEdited ? {} : { composeService: name.trim() }) }, ['name'])
            }}
            error={err('name')}
            spellCheck={false}
          />
          <SelectField
            label="Host"
            value={lockedHost ?? form.hostId}
            disabled={lockedHost !== null}
            onChange={(e) => set({ hostId: e.target.value }, ['hostId'])}
            error={err('hostId')}
            hint={lockedHost !== null ? "The checkout's host" : isDb ? 'For a managed database, the bastion that reaches it' : undefined}
          >
            <option value="">Choose a host…</option>
            {hostGroups.map(({ region, hosts: group }) => (
              <optgroup key={group[0]!.regionId} label={region?.code ?? 'No region'}>
                {group.map((h) => (
                  <option key={h.hostId} value={h.hostId}>
                    {h.inEnv ? `${h.label} · in ${env.name}` : h.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
          {kind === 'bastion' ? (
            <TextField label="Description" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Optional" />
          ) : isDb ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <SelectField
                  label="Engine"
                  value={form.dbEngine}
                  onChange={(e) => {
                    const dbEngine = e.target.value as DbEngine
                    // The port follows the engine until the user types one of their own.
                    const followed = form.dbPort === '' || form.dbPort === String(DB_DEFAULT_PORT[form.dbEngine] ?? '')
                    const next = DB_DEFAULT_PORT[dbEngine]
                    set({ dbEngine, ...(followed ? { dbPort: next == null ? '' : String(next) } : {}) })
                  }}
                >
                  {ENGINES.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <TextField
                  label="Address"
                  value={form.dbAddress}
                  onChange={(e) => set({ dbAddress: e.target.value }, ['dbAddress'])}
                  placeholder="10.0.0.5 or db.internal"
                  className="font-mono"
                  spellCheck={false}
                  error={err('dbAddress')}
                />
                <TextField
                  label="Port"
                  inputMode="numeric"
                  value={form.dbPort}
                  onChange={(e) => set({ dbPort: e.target.value }, ['dbPort'])}
                  className="font-mono"
                  error={err('dbPort')}
                />
              </div>
              <TextField
                label="Local port"
                inputMode="numeric"
                value={form.localPort}
                onChange={(e) => set({ localPort: e.target.value }, ['localPort'])}
                placeholder="Picked on first open"
                className="font-mono"
                error={err('localPort')}
                hint="127.0.0.1 on this Mac"
              />
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <SelectField
                  label="Checkout"
                  value={form.deploymentId}
                  onChange={(e) => {
                    const deploymentId = e.target.value
                    set({ deploymentId, ...(deploymentId ? { hostId: checkoutHost.get(deploymentId) ?? form.hostId } : {}) })
                  }}
                >
                  <option value="">None</option>
                  {checkouts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="Compose service"
                  value={form.composeService}
                  placeholder={form.deploymentId ? undefined : 'Only with a checkout'}
                  onChange={(e) => set({ composeService: e.target.value, composeEdited: true }, ['composeService'])}
                  className="font-mono"
                  spellCheck={false}
                  error={err('composeService')}
                />
              </div>
              <TextField
                label="URL"
                value={form.url}
                onChange={(e) => set({ url: e.target.value }, ['url'])}
                placeholder="https://app.example.com"
                className="font-mono"
                spellCheck={false}
                error={err('url')}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-medium text-fg/90">Check health from</span>
                <Segmented label="Check health from" size="sm" options={CHECK_FROM} value={form.urlCheckFrom} onChange={(urlCheckFrom) => set({ urlCheckFrom })} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-medium text-fg/90">Skip if no new commits</span>
                <Switch label="Skip if no new commits" checked={form.skipUnchanged} onChange={(skipUnchanged) => set({ skipUnchanged })} />
              </div>
            </>
          )}
          {serverError && (
            <p role="alert" className="text-[12.5px] text-err">
              {serverError}
            </p>
          )}
        </form>
      </Dialog>
      <ConfirmDialog request={prompt} onClose={closePrompt} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
