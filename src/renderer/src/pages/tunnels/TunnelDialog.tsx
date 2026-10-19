import { AnimatePresence, motion } from 'framer-motion'
import { Cable, Check, Copy, Lock, RotateCw, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { HOST_ADDRESS, MAX_ADDRESS, type EnvironmentMeta } from '../../../../shared/inventory'
import {
  BIND_ADDRESS,
  MAX_BIND_ADDRESS,
  TUNNEL_ROUTE_FIELDS,
  isLoopback,
  type TunnelInput,
  type TunnelMeta,
  type TunnelPatch,
  type TunnelType,
} from '../../../../shared/tunnels'
import { MAX_LABEL } from '../../../../shared/vault'
import { useInventory } from '../../inventory/store'
import { createTunnel, deleteTunnel, tunnelStore, updateTunnel } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import type { ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toaster'
import { hostPort, RouteLine } from './RouteLine'
import { isRunning, TUNNEL_TYPE } from './TunnelCard'

/** What the dialog was opened for: a new tunnel (optionally for a host), or an edit or copy of a saved one. */
export type TunnelRequest = { kind: 'new'; hostId?: string; environmentId?: string } | { kind: 'edit' | 'duplicate'; id: string }

interface Form {
  label: string
  hostId: string
  environmentId: string
  type: TunnelType
  bindAddress: string
  bindPort: string
  targetHost: string
  targetPort: string
  autoStart: boolean
  autoReconnect: boolean
}

type FieldName = 'label' | 'hostId' | 'environmentId' | 'bindAddress' | 'bindPort' | 'targetHost' | 'targetPort'

const TYPES: { type: TunnelType; label: string; hint: string }[] = [
  { type: 'L', label: 'Local', hint: 'Reach a port on the server from this Mac' },
  { type: 'R', label: 'Remote', hint: 'Let the server reach a port on this side' },
  { type: 'D', label: 'SOCKS', hint: 'A proxy that sends any traffic through the server' },
]

const BIND_CHOICES = [
  { address: '127.0.0.1', title: 'Only this machine' },
  { address: '0.0.0.0', title: 'Every network interface' },
]

const PLACEHOLDER = '…'

function formFrom(request: TunnelRequest, tunnels: readonly TunnelMeta[]): { form: Form; original?: TunnelMeta } {
  const blank: Form = {
    label: '',
    hostId: '',
    environmentId: '',
    type: 'L',
    bindAddress: '127.0.0.1',
    bindPort: '',
    targetHost: 'localhost',
    targetPort: '',
    autoStart: false,
    autoReconnect: true,
  }
  if (request.kind === 'new') return { form: { ...blank, hostId: request.hostId ?? '', environmentId: request.environmentId ?? '' } }
  const t = tunnels.find((x) => x.id === request.id)
  if (!t) return { form: blank }
  const form: Form = {
    label: t.label,
    hostId: t.hostId,
    environmentId: t.environmentId ?? '',
    type: t.type,
    bindAddress: t.bindAddress,
    bindPort: String(t.bindPort),
    targetHost: t.targetHost ?? 'localhost',
    targetPort: t.targetPort != null ? String(t.targetPort) : '',
    autoStart: t.autoStart,
    autoReconnect: t.autoReconnect,
  }
  if (request.kind === 'edit') return { form, original: t }
  // A copy that could run beside the original: the next port up (0 already means "any free port").
  const port = t.bindPort === 0 ? 0 : Math.min(t.bindPort + 1, 65535)
  return { form: { ...form, label: `${t.label} copy`.slice(0, MAX_LABEL), bindPort: String(port) } }
}

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN)

interface Check {
  /** Shape errors, in the store's own words; a blank required field is just not ready yet. */
  errors: Partial<Record<FieldName, string>>
  /** The tunnel as the store would save it, once every field is ready. */
  fields: Omit<TunnelMeta, 'id' | 'createdAt' | 'updatedAt'> | null
}

/** The store's rules (main/tunnels/tunnel-store.ts), checked for shape; the store still has the last word. */
function check(f: Form, environments: readonly EnvironmentMeta[]): Check {
  const errors: Check['errors'] = {}
  const label = f.label.trim()
  if (label.length > MAX_LABEL) errors.label = `tunnel label must be 1-${MAX_LABEL} characters`
  if (f.environmentId && !environments.some((e) => e.id === f.environmentId && e.hosts.some((h) => h.hostId === f.hostId))) {
    errors.environmentId = 'host is not in that environment'
  }
  const bindAddress = f.bindAddress.trim()
  if (bindAddress && (bindAddress.length > MAX_BIND_ADDRESS || !BIND_ADDRESS.test(bindAddress))) {
    errors.bindAddress = 'bind address must be an IP address or localhost'
  }
  const bindPort = whole(f.bindPort)
  if (f.bindPort.trim() && !(bindPort >= 0 && bindPort <= 65535)) errors.bindPort = 'bind port must be 0-65535'
  const dynamic = f.type === 'D'
  const targetHost = f.targetHost.trim()
  const targetPort = whole(f.targetPort)
  if (!dynamic) {
    if (targetHost && (targetHost.length > MAX_ADDRESS || !HOST_ADDRESS.test(targetHost))) errors.targetHost = 'host address is invalid'
    if (f.targetPort.trim() && !(targetPort >= 1 && targetPort <= 65535)) errors.targetPort = 'port must be 1-65535'
  }
  const ready =
    label.length > 0 && !!f.hostId && !!bindAddress && f.bindPort.trim() !== '' && (dynamic || (!!targetHost && f.targetPort.trim() !== ''))
  if (!ready || Object.keys(errors).length) return { errors, fields: null }
  return {
    errors,
    fields: {
      label,
      hostId: f.hostId,
      environmentId: f.environmentId || null,
      type: f.type,
      bindAddress: bindAddress.toLowerCase() === 'localhost' ? 'localhost' : bindAddress,
      bindPort,
      targetHost: dynamic ? null : targetHost,
      targetPort: dynamic ? null : targetPort,
      autoStart: f.autoStart,
      autoReconnect: f.autoReconnect,
    },
  }
}

/** Which field a store error is about, by the rule it names; anything else shows above the buttons. */
function fieldOf(message: string): FieldName | null {
  const m = message.toLowerCase()
  if (m.startsWith('tunnel label')) return 'label'
  if (m.startsWith('host not found')) return 'hostId'
  if (m.startsWith('environment') || m.startsWith('host is not in that environment')) return 'environmentId'
  if (m.startsWith('bind address')) return 'bindAddress'
  if (m.startsWith('bind port')) return 'bindPort'
  if (m.startsWith('target host') || m.startsWith('host address')) return 'targetHost'
  if (m.startsWith('port must be')) return 'targetPort'
  return null
}

const WILDCARD = new Set(['0.0.0.0', '::', '*', ''])
const sameLocal = (a: string) => (a.toLowerCase() === 'localhost' ? '127.0.0.1' : a.toLowerCase())

/** Another saved tunnel that listens on the same port, so the two can't both run. Port 0 never clashes. */
function clashWith(f: Form, tunnels: readonly TunnelMeta[], selfId: string | undefined): TunnelMeta | undefined {
  const port = whole(f.bindPort)
  if (!(port > 0)) return undefined
  const address = sameLocal(f.bindAddress.trim())
  return tunnels.find((t) => {
    if (t.id === selfId || t.bindPort !== port) return false
    // L and D listen on this machine; R listens on its server.
    if (f.type === 'R' || t.type === 'R') return f.type === 'R' && t.type === 'R' && t.hostId === f.hostId
    const other = sameLocal(t.bindAddress)
    return other === address || WILDCARD.has(other) || WILDCARD.has(address)
  })
}

/** The fields that differ from the saved tunnel; clearing a value sends null, as the store expects. */
function changes(original: TunnelMeta, fields: NonNullable<Check['fields']>): TunnelPatch {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (original[k as keyof TunnelMeta] !== v) out[k] = v
  return out as TunnelPatch
}

/** Safe to paste into a shell as is; anything else is single-quoted. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The equivalent `ssh` command, naming the host by its label (never its address or user). */
function sshCommand(f: Form, hostLabel: string | undefined): string {
  const bind = hostPort(f.bindAddress.trim() || PLACEHOLDER, f.bindPort.trim() || PLACEHOLDER)
  const spec = f.type === 'D' ? bind : `${bind}:${hostPort(f.targetHost.trim() || PLACEHOLDER, f.targetPort.trim() || PLACEHOLDER)}`
  return `ssh -${f.type} ${spec} ${hostLabel ? shellWord(hostLabel) : PLACEHOLDER}`
}

interface TunnelDialogProps {
  request: TunnelRequest | null
  onClose: () => void
}

/** Creates, edits or copies a tunnel. Shows the route and the ssh command as you type. */
export function TunnelDialog({ request, onClose }: TunnelDialogProps) {
  const formId = useId()
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const { tunnels, runtime } = useSyncExternalStore(tunnelStore.subscribe, tunnelStore.get)
  // Keep the last request while the dialog animates out.
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current
  const open = request !== null

  const [form, setForm] = useState<Form>(() => (r ? formFrom(r, tunnels).form : formFrom({ kind: 'new' }, []).form))
  // The tunnel as it was when the dialog opened; an edit sends only what changed from this.
  const [original, setOriginal] = useState<TunnelMeta | undefined>()
  const [serverError, setServerError] = useState<{ field: FieldName | null; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)

  const requestKey = request ? (request.kind === 'new' ? `new:${request.hostId ?? ''}:${request.environmentId ?? ''}` : `${request.kind}:${request.id}`) : null
  useEffect(() => {
    if (!request) return
    const next = formFrom(request, tunnelStore.get().tunnels)
    setForm(next.form)
    setOriginal(next.original)
    setServerError(null)
    setBusy(false)
    // Reset when the dialog opens or switches tunnel, not when the store refreshes mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  const hosts = useMemo(() => [...(data?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label)), [data])
  const environments = useMemo(() => data?.environments ?? [], [data])
  const hostEnvs = useMemo(
    () => environments.filter((e) => e.hosts.some((h) => h.hostId === form.hostId)).sort((a, b) => a.name.localeCompare(b.name)),
    [environments, form.hostId],
  )
  const host = hosts.find((h) => h.id === form.hostId)
  const env = hostEnvs.find((e) => e.id === form.environmentId)

  const set = (patch: Partial<Form>) => {
    setForm((f) => {
      const next = { ...f, ...patch }
      // A new host keeps the environment only if it is in it too.
      if (patch.hostId !== undefined && !environments.some((e) => e.id === next.environmentId && e.hosts.some((h) => h.hostId === next.hostId))) {
        next.environmentId = ''
      }
      return next
    })
    setServerError(null)
  }

  const result = check(form, environments)
  const errorFor = (name: FieldName) => result.errors[name] ?? (serverError?.field === name ? serverError.message : undefined)

  const patch = original && result.fields ? changes(original, result.fields) : null
  const restarts =
    !!original && isRunning(runtime[original.id]?.state) && !!patch && TUNNEL_ROUTE_FIELDS.some((k) => k in patch)

  const exposed = !!form.bindAddress.trim() && !result.errors.bindAddress && !isLoopback(form.bindAddress)
  const port = whole(form.bindPort)
  const clash = clashWith(form, tunnels, original?.id)
  const warnings = [
    exposed &&
      (form.type === 'R'
        ? "Exposed on the server's network (needs GatewayPorts on the server)"
        : `Anyone who can reach this machine on ${hostPort(form.bindAddress.trim(), form.bindPort.trim() || PLACEHOLDER)} can use this tunnel`),
    form.type !== 'R' && port > 0 && port < 1024 && 'Ports below 1024 need admin rights',
    clash && `"${clash.label}" uses the same port; they can't run at the same time`,
  ].filter((w): w is string => !!w)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!result.fields || busy || !r) return
    const onError = (message: string) => {
      setServerError({ field: fieldOf(message), message })
      setShake((n) => n + 1)
    }
    if (original) {
      if (!patch || Object.keys(patch).length === 0) return onClose()
      setBusy(true)
      const saved = await updateTunnel(original.id, patch, onError)
      setBusy(false)
      if (!saved) return
      toast({ title: `Saved ${saved.label}`, tone: 'success' })
      return onClose()
    }
    const f = result.fields
    const input: TunnelInput = {
      label: f.label,
      hostId: f.hostId,
      ...(f.environmentId ? { environmentId: f.environmentId } : {}),
      type: f.type,
      bindAddress: f.bindAddress,
      bindPort: f.bindPort,
      ...(f.type === 'D' ? {} : { targetHost: f.targetHost!, targetPort: f.targetPort! }),
      autoStart: f.autoStart,
      autoReconnect: f.autoReconnect,
    }
    setBusy(true)
    const created = await createTunnel(input, onError)
    setBusy(false)
    if (!created) return
    toast({ title: `Created ${created.label}`, tone: 'success' })
    onClose()
  }

  const kind = r?.kind ?? 'new'
  const formError = serverError && serverError.field === null ? serverError.message : undefined

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kind === 'edit' ? 'Edit tunnel' : kind === 'duplicate' ? 'Duplicate tunnel' : 'New tunnel'}
      description={kind === 'new' ? 'Forward a port through one of your hosts. It reconnects by itself.' : undefined}
      icon={<Cable aria-hidden className="size-4" />}
      shake={shake}
      width={540}
      footer={
        <>
          <AnimatePresence initial={false}>
            {restarts && (
              <motion.p
                initial={motionSafe ? { opacity: 0, x: -6 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: fast }}
                transition={motionSafe ? spring : fast}
                className="mr-auto flex items-center gap-1.5 text-[12px] text-warn"
              >
                <RotateCw aria-hidden className="size-3.5" />
                Saving restarts this tunnel
              </motion.p>
            )}
          </AnimatePresence>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!result.fields} loading={busy}>
            {kind === 'edit' ? 'Save' : 'Create tunnel'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField
          autoFocus
          label="Label"
          placeholder="postgres on db-1"
          maxLength={MAX_LABEL}
          value={form.label}
          onChange={(e) => set({ label: e.target.value })}
          error={errorFor('label')}
        />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Host" value={form.hostId} onChange={(e) => set({ hostId: e.target.value })} error={errorFor('hostId')}>
            <option value="" disabled>
              Choose a host
            </option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Environment"
            value={form.environmentId}
            disabled={!form.hostId}
            onChange={(e) => set({ environmentId: e.target.value })}
            error={errorFor('environmentId')}
            hint={
              env?.protected ? (
                <span className="inline-flex items-center gap-1 text-warn">
                  <Lock aria-hidden className="size-3" />
                  Protected environment: deleting asks for its name
                </span>
              ) : undefined
            }
          >
            <option value="">None</option>
            {hostEnvs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectField>
        </div>

        <TypePicker value={form.type} onChange={(type) => set({ type })} />

        <div className="rounded-xl border border-line bg-canvas/40 px-3 pt-3.5 pb-3">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={form.type}
              initial={motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: fast }}
              transition={motionSafe ? spring : fast}
            >
              <RouteLine
                type={form.type}
                hostLabel={host?.label ?? 'host'}
                bindAddress={form.bindAddress.trim() || PLACEHOLDER}
                bindPort={form.bindPort.trim() || PLACEHOLDER}
                targetHost={form.type === 'D' ? null : form.targetHost.trim() || PLACEHOLDER}
                targetPort={form.type === 'D' ? null : form.targetPort.trim() || PLACEHOLDER}
                state="stopped"
              />
            </motion.div>
          </AnimatePresence>
          <CopyCommand command={sshCommand(form, host?.label)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-[1fr_112px] gap-3">
            <TextField
              label="Bind address"
              placeholder="127.0.0.1"
              maxLength={MAX_BIND_ADDRESS}
              value={form.bindAddress}
              onChange={(e) => set({ bindAddress: e.target.value })}
              error={errorFor('bindAddress')}
              hint={form.type === 'R' ? 'Where the server listens' : 'Where this machine listens'}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="font-mono"
            />
            <TextField
              label="Bind port"
              inputMode="numeric"
              placeholder={form.type === 'D' ? '1080' : '5433'}
              value={form.bindPort}
              onChange={(e) => set({ bindPort: e.target.value })}
              error={errorFor('bindPort')}
              hint={form.bindPort.trim() === '0' ? 'Any free port' : undefined}
              className="font-mono tabular-nums"
            />
          </div>
          <div role="group" aria-label="Bind address shortcuts" className="flex gap-1">
            {BIND_CHOICES.map((c) => {
              const on = form.bindAddress.trim() === c.address
              return (
                <motion.button
                  key={c.address}
                  type="button"
                  title={c.title}
                  aria-pressed={on}
                  onClick={() => set({ bindAddress: c.address })}
                  whileTap={motionSafe ? { scale: 0.92 } : undefined}
                  transition={spring}
                  className={`h-6 rounded-md px-2 font-mono text-[11.5px] transition-colors ${
                    on ? 'bg-accent/14 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]' : 'bg-white/[0.04] text-muted hover:text-fg'
                  }`}
                >
                  {c.address}
                </motion.button>
              )
            })}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {form.type !== 'D' && (
            <motion.div
              key="target"
              initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
              animate={motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 }}
              exit={{ opacity: 0, ...(motionSafe ? { height: 0 } : {}), transition: fast }}
              transition={motionSafe ? spring : fast}
              // Clipped only while it moves, so focus rings at the edges are never cut off.
              className="-mx-1 overflow-hidden px-1"
            >
              <div className="grid grid-cols-[1fr_112px] gap-3 pb-0.5">
                <TextField
                  label="Target host"
                  placeholder="localhost"
                  maxLength={MAX_ADDRESS}
                  value={form.targetHost}
                  onChange={(e) => set({ targetHost: e.target.value })}
                  error={errorFor('targetHost')}
                  hint={form.type === 'R' ? 'As seen from this machine' : 'As seen from the server'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="font-mono"
                />
                <TextField
                  label="Target port"
                  inputMode="numeric"
                  placeholder="5432"
                  value={form.targetPort}
                  onChange={(e) => set({ targetPort: e.target.value })}
                  error={errorFor('targetPort')}
                  className="font-mono tabular-nums"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {warnings.length > 0 && (
            <motion.div
              key="warnings"
              initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
              animate={motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 }}
              exit={{ opacity: 0, ...(motionSafe ? { height: 0 } : {}), transition: fast }}
              transition={motionSafe ? spring : fast}
              className="overflow-hidden"
            >
              <div className="flex gap-2 rounded-lg bg-warn/8 px-3 py-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_30%,transparent)]">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
                <ul aria-live="polite" className="flex flex-col gap-0.5 text-[12px] leading-4 text-fg/85">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-col gap-2 pt-0.5">
          <SwitchRow label="Start on launch" hint="When OpsDeck opens" checked={form.autoStart} onChange={(autoStart) => set({ autoStart })} />
          <SwitchRow
            label="Reconnect automatically"
            hint="Retries with backoff when the link drops"
            checked={form.autoReconnect}
            onChange={(autoReconnect) => set({ autoReconnect })}
          />
        </div>

        {formError && (
          <p role="alert" className="text-[12px] leading-4 text-err">
            {formError}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** Local, Remote or SOCKS as a segmented radio group; the arrow keys move the choice, as in any radio group. */
function TypePicker({ value, onChange }: { value: TunnelType; onChange: (t: TunnelType) => void }) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const refs = useRef<Partial<Record<TunnelType, HTMLButtonElement | null>>>({})
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = TYPES.findIndex((t) => t.type === value)
    const next = TYPES[(i + step + TYPES.length) % TYPES.length].type
    onChange(next)
    refs.current[next]?.focus()
  }
  const current = TYPES.find((t) => t.type === value)!
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-[12.5px] font-medium text-fg/90">
        Type
      </span>
      <div role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown} className="grid grid-cols-3 gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5">
        {TYPES.map((t) => {
          const checked = t.type === value
          const Icon = TUNNEL_TYPE[t.type].icon
          return (
            <motion.button
              key={t.type}
              ref={(el: HTMLButtonElement | null) => {
                refs.current[t.type] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              title={TUNNEL_TYPE[t.type].title}
              onClick={() => onChange(t.type)}
              whileTap={motionSafe ? { scale: 0.95 } : undefined}
              transition={spring}
              className={`relative flex h-8 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition-colors ${checked ? 'text-fg' : 'text-muted hover:text-fg'}`}
            >
              {checked && (
                <motion.span
                  layoutId={motionSafe ? `${id}-type` : undefined}
                  transition={spring}
                  className="absolute inset-0 rounded-md bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
                />
              )}
              <Icon aria-hidden className="relative size-3.5" style={{ color: checked ? TUNNEL_TYPE[t.type].color : undefined }} />
              <span className="relative">{t.label}</span>
            </motion.button>
          )
        })}
      </div>
      <p className="text-[12px] leading-4 text-muted">{current.hint}</p>
    </div>
  )
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span aria-hidden className="text-[12.5px] font-medium text-fg/90">
          {label}
        </span>
        <span className="text-[12px] leading-4 text-muted">{hint}</span>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

function CopyCommand({ command }: { command: string }) {
  const motionSafe = useMotionSafe()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    navigator.clipboard
      ?.writeText(command)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-canvas/60 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90" title={command}>
        {command}
      </code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={copy}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? 'done' : 'copy'}
            initial={motionSafe ? { scale: 0.6, opacity: 0 } : { opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ opacity: 0, transition: fast }}
            transition={spring}
            className="grid"
          >
            {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  )
}

/**
 * The delete confirmation for a tunnel. A running tunnel is stopped first; in a protected environment
 * the user types the environment's name.
 */
export function tunnelDeleteRequest(meta: TunnelMeta, environment: EnvironmentMeta | undefined, running: boolean): ConfirmRequest {
  const guarded = environment?.protected ? environment.name : undefined
  return {
    title: `Delete ${meta.label}?`,
    description: [
      running ? 'It will be stopped first.' : '',
      'The tunnel is removed from this machine.',
      guarded ? `It belongs to the protected ${guarded} environment.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: 'Delete tunnel',
    typeToConfirm: guarded,
    run: async () => {
      if (await deleteTunnel(meta.id)) toast({ title: `Deleted ${meta.label}`, tone: 'success' })
    },
  }
}
