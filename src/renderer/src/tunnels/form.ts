import { HOST_ADDRESS, MAX_ADDRESS, type EnvironmentMeta } from '../../../shared/inventory'
import { BIND_ADDRESS, DEFAULT_TUNNEL_MAX_MINUTES, MAX_BIND_ADDRESS, type TunnelMeta, type TunnelPatch, type TunnelType } from '../../../shared/tunnels'
import { MAX_LABEL } from '../../../shared/vault'
import { hostPort } from '../pages/tunnels/RouteLine'

// The tunnel dialog's form as plain data: defaults, the store's rules checked for shape, the edit
// patch, port clashes and the equivalent ssh command. No React here.

/** What the dialog was opened for: a new tunnel (optionally for a host), or an edit or copy of a saved one. */
export type TunnelRequest = { kind: 'new'; hostId?: string; environmentId?: string } | { kind: 'edit' | 'duplicate'; id: string }

export interface Form {
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
  /** Minutes as text, '' for no limit (a select, so always one of its choices or the saved value). */
  maxMinutes: string
}

export type FieldName = 'label' | 'hostId' | 'environmentId' | 'bindAddress' | 'bindPort' | 'targetHost' | 'targetPort'

export const PLACEHOLDER = '…'

/** The form for a request, or null when an edit or copy names a tunnel that no longer exists. */
export function formFrom(request: TunnelRequest, tunnels: readonly TunnelMeta[]): { form: Form; original?: TunnelMeta } | null {
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
    maxMinutes: String(DEFAULT_TUNNEL_MAX_MINUTES),
  }
  if (request.kind === 'new') return { form: { ...blank, hostId: request.hostId ?? '', environmentId: request.environmentId ?? '' } }
  const t = tunnels.find((x) => x.id === request.id)
  if (!t) return null
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
    maxMinutes: t.maxMinutes === null ? '' : String(t.maxMinutes),
  }
  if (request.kind === 'edit') return { form, original: t }
  // A copy that could run beside the original: the next port up (0 already means "any free port"), and never
  // started on launch, so it can't race the original for a port before anyone has looked at it.
  const port = t.bindPort === 0 ? 0 : Math.min(t.bindPort + 1, 65535)
  return { form: { ...form, label: `${t.label} copy`.slice(0, MAX_LABEL), bindPort: String(port), autoStart: false } }
}

export const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN)

export interface Check {
  /** Shape errors, in the store's own words; a blank required field is just not ready yet. */
  errors: Partial<Record<FieldName, string>>
  /** The tunnel as the store would save it, once every field is ready. */
  fields: Omit<TunnelMeta, 'id' | 'createdAt' | 'updatedAt'> | null
}

/** The store's rules (main/tunnels/tunnel-store.ts), checked for shape; the store still has the last word. */
export function checkForm(f: Form, environments: readonly EnvironmentMeta[]): Check {
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
      maxMinutes: f.maxMinutes === '' ? null : Number(f.maxMinutes),
    },
  }
}

/** Which field a store error is about, by the rule it names; anything else shows above the buttons. */
export function fieldOf(message: string): FieldName | null {
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
export function clashWith(f: Form, tunnels: readonly TunnelMeta[], selfId: string | undefined): TunnelMeta | undefined {
  const port = whole(f.bindPort)
  const address = sameLocal(f.bindAddress.trim())
  // A blank address is still being typed, not a wildcard.
  if (!(port > 0) || !address) return undefined
  return tunnels.find((t) => {
    if (t.id === selfId || t.bindPort !== port) return false
    // L and D listen on this machine; R listens on its server.
    if (f.type === 'R' || t.type === 'R') return f.type === 'R' && t.type === 'R' && t.hostId === f.hostId
    const other = sameLocal(t.bindAddress)
    return other === address || WILDCARD.has(other) || WILDCARD.has(address)
  })
}

/** The fields that differ from the saved tunnel; clearing a value sends null, as the store expects. */
export function changes(original: TunnelMeta, fields: NonNullable<Check['fields']>): TunnelPatch {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (original[k as keyof TunnelMeta] !== v) out[k] = v
  return out as TunnelPatch
}

/** Safe to paste into a shell as is; anything else is single-quoted. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The equivalent `ssh` command, naming the host by its label (never its address or user). */
export function sshCommand(f: Form, hostLabel: string | undefined): string {
  const bind = hostPort(f.bindAddress.trim() || PLACEHOLDER, f.bindPort.trim() || PLACEHOLDER)
  const spec = f.type === 'D' ? bind : `${bind}:${hostPort(f.targetHost.trim() || PLACEHOLDER, f.targetPort.trim() || PLACEHOLDER)}`
  return `ssh -${f.type} ${spec} ${hostLabel ? shellWord(hostLabel) : PLACEHOLDER}`
}
