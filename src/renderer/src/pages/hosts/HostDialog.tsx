import { AnimatePresence, motion } from 'framer-motion'
import { AppWindow, Laptop, Server, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  DEFAULT_SSH_PORT,
  HOST_ADDRESS,
  MAX_ADDRESS,
  MAX_NOTES,
  MAX_TAG,
  MAX_TAGS,
  OS_ICONS,
  TAG,
  type HostMeta,
  type Membership,
  type OsIcon,
} from '../../../../shared/inventory'
import { DEFAULT_VAULT_ID, MAX_LABEL } from '../../../../shared/vault'
import { identityChoices, jumpHostChoices, sourceLabel } from '../../inventory/choices'
import { inv, useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'
import { useVaultStatus } from '../../vault/status'
import { HostAdvanced, advancedFrom, checkAdvanced, type AdvancedState } from './HostAdvanced'

export const OS_META: Record<OsIcon, { label: string; icon: LucideIcon }> = {
  linux: { label: 'Linux', icon: SquareTerminal },
  windows: { label: 'Windows', icon: AppWindow },
  macos: { label: 'macOS', icon: Laptop },
  other: { label: 'Other', icon: Server },
}

/** Blank means "inherit"; anything else must be a whole port number. */
function parsePort(text: string): { value: number | null; error?: string } {
  const t = text.trim()
  if (!t) return { value: null }
  const n = Number(t)
  return /^\d+$/.test(t) && n >= 1 && n <= 65535 ? { value: n } : { value: null, error: 'Use a port from 1 to 65535.' }
}

function addressError(text: string): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (t.length > MAX_ADDRESS || !HOST_ADDRESS.test(t)) return 'Use a hostname or IP address, with no spaces.'
  return undefined
}

interface HostDialogProps {
  open: boolean
  /** Edits this host; creates a new one when absent. */
  host?: HostMeta
  /** A new host starts in this environment, with this role. */
  presetEnvironment?: Membership
  /** The environment the host is being looked at from; blank fields say what they inherit there. */
  contextEnvironmentId?: string
  onClose: () => void
  onSaved: (host: HostMeta, created: boolean) => void
}

export function HostDialog({ open, host, presetEnvironment, contextEnvironmentId, onClose, onSaved }: HostDialogProps) {
  const formId = useId()
  const data = useInventory()
  const status = useVaultStatus()
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [jumpId, setJumpId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [osIcon, setOsIcon] = useState<OsIcon>('linux')
  const [notes, setNotes] = useState('')
  const [adv, setAdv] = useState<AdvancedState>(() => advancedFrom(host))
  const [busy, setBusy] = useState(false)
  // The host as it was when the dialog opened; a save sends only what changed from this.
  const opened = useRef(host)

  useEffect(() => {
    if (!open) return
    opened.current = host
    setLabel(host?.label ?? '')
    setAddress(host?.address ?? '')
    setPort(host?.port != null ? String(host.port) : '')
    setIdentityId(host?.identityId ?? '')
    setJumpId(host?.jumpHostId ?? '')
    setTags(host?.tags ?? [])
    setOsIcon(host?.osIcon ?? 'linux')
    setNotes(host?.notes ?? '')
    setAdv(advancedFrom(host))
    // Reset when the dialog opens or switches host, not when a refresh hands over a new object mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.id])

  const linkedVaultIds = useMemo(() => host?.vaultIds ?? [DEFAULT_VAULT_ID], [host])
  const memberships = useMemo(() => host?.environments ?? (presetEnvironment ? [presetEnvironment] : []), [host, presetEnvironment])
  const corruptIds = status?.corruptVaultIds
  const groups = useMemo(() => {
    const all = identityChoices(data?.identities ?? [], data?.vaults ?? [], linkedVaultIds, corruptIds ?? [])
    return (['Linked vaults', 'Other vaults'] as const)
      .map((group) => ({ group, entries: all.filter((g) => g.group === group).flatMap((g) => g.identities.map((i) => ({ i, vault: g.vault }))) }))
      .filter((g) => g.entries.length)
  }, [data, linkedVaultIds, corruptIds])
  const jumpHosts = useMemo(
    () => jumpHostChoices(data?.hosts ?? [], host?.id ?? null).filter((h) => h.id !== host?.id).sort((a, b) => a.label.localeCompare(b.label)),
    [data, host],
  )

  // What a blank field falls back to: the context environment's default, or, with no context, the one
  // default every environment agrees on. When they disagree there is no single answer to show.
  const memberEnvs = memberships.flatMap((m) => data?.environments.filter((e) => e.id === m.environmentId) ?? [])
  const ctxEnv = memberEnvs.find((e) => e.id === contextEnvironmentId)
  const envs = ctxEnv ? [ctxEnv] : memberEnvs
  type Env = (typeof envs)[number]
  const fallback = <T,>(pick: (e: Env) => T | null): { env?: Env; value: T | null } | null => {
    const set = new Set(envs.map(pick))
    if (set.size > 1) return null
    const env = envs.find((e) => pick(e) != null)
    return { env, value: env ? pick(env) : null }
  }
  const inheritLabel = (pick: (e: Env) => string | null) => {
    const f = fallback(pick)
    if (!f) return 'Inherit'
    return `Inherit (${f.env ? sourceLabel('environment', f.env.name) : sourceLabel('global')})`
  }
  const portFallback = fallback((e) => e.defaultPort)
  const portPlaceholder = portFallback ? String(portFallback.value ?? DEFAULT_SSH_PORT) : ''
  const knownIdentity = !identityId || groups.some((g) => g.entries.some((x) => x.i.id === identityId))
  const knownJump = !jumpId || jumpHosts.some((h) => h.id === jumpId)

  const parsedPort = parsePort(port)
  const addrError = addressError(address)
  const advCheck = checkAdvanced(adv)
  const valid = label.trim().length > 0 && address.trim().length > 0 && !addrError && !parsedPort.error && advCheck.valid

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const fields = {
      label: label.trim(),
      address: address.trim(),
      port: parsedPort.value,
      identityId: identityId || null,
      jumpHostId: jumpId || null,
      tags,
      osIcon,
      notes,
      keepaliveSec: advCheck.keepaliveSec,
      envVars: advCheck.envVars,
    }
    const saved = await inv.saveHost(
      host ? fields : { ...fields, vaultIds: [DEFAULT_VAULT_ID], environments: memberships },
      host?.id,
      opened.current,
    )
    setBusy(false)
    if (saved) {
      toast({ title: host ? `Saved ${saved.label}` : `Created ${saved.label}`, tone: 'success' })
      onSaved(saved, !host)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={host ? 'Edit host' : 'New host'}
      description={host ? undefined : 'A machine you connect to. Blank fields inherit from its environment.'}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            {host ? 'Save' : 'Create host'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <TextField autoFocus label="Label" placeholder="web-1" maxLength={MAX_LABEL} value={label} onChange={(e) => setLabel(e.target.value)} />
          <OsPicker value={osIcon} onChange={setOsIcon} />
        </div>
        <div className="grid grid-cols-[1fr_112px] gap-3">
          <TextField
            label="Address"
            placeholder="10.0.0.5 or web-1.internal"
            maxLength={MAX_ADDRESS}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            error={addrError}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="font-mono"
          />
          <TextField
            label="Port"
            inputMode="numeric"
            placeholder={portPlaceholder}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            error={parsedPort.error}
            hint={port.trim() ? undefined : 'Blank inherits'}
            className="font-mono tabular-nums"
          />
        </div>
        <SelectField label="Identity" value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
          <option value="">{inheritLabel((e) => e.defaultIdentityId)}</option>
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.entries.map(({ i, vault }) => (
                <option key={i.id} value={i.id}>
                  {i.label} ({i.username}), {vault.name}
                </option>
              ))}
            </optgroup>
          ))}
          {!knownIdentity && (
            <option value={identityId} disabled>
              Unavailable identity
            </option>
          )}
        </SelectField>
        <SelectField label="Jump host" value={jumpId} onChange={(e) => setJumpId(e.target.value)}>
          <option value="">{inheritLabel((e) => e.defaultJumpHostId)}</option>
          {jumpHosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
          {!knownJump && (
            <option value={jumpId} disabled>
              Unavailable host
            </option>
          )}
        </SelectField>
        <TagInput tags={tags} onChange={setTags} />
        <TextAreaField label="Notes" rows={3} maxLength={MAX_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Runbooks, quirks, who owns it" />
        <HostAdvanced value={adv} check={advCheck} onChange={setAdv} />
      </form>
    </Dialog>
  )
}

function OsPicker({ value, onChange }: { value: OsIcon; onChange: (v: OsIcon) => void }) {
  const motionSafe = useMotionSafe()
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-[12.5px] font-medium text-fg/90">
        System
      </span>
      <div role="radiogroup" aria-labelledby={id} className="flex h-9 items-center gap-1">
        {OS_ICONS.map((os) => {
          const { label, icon: Icon } = OS_META[os]
          const checked = os === value
          return (
            <motion.button
              key={os}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              title={label}
              onClick={() => onChange(os)}
              whileTap={motionSafe ? { scale: 0.88 } : undefined}
              transition={spring}
              className={`relative grid size-9 place-items-center rounded-lg transition-colors ${checked ? 'text-fg' : 'text-muted hover:text-fg'}`}
            >
              {checked && (
                <motion.span
                  layoutId={motionSafe ? `${id}-os` : undefined}
                  transition={spring}
                  className="absolute inset-0 rounded-lg bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
                />
              )}
              <Icon aria-hidden className="relative size-4" />
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()

  const commit = () => {
    const t = draft.trim()
    if (!t) return
    if (t.length > MAX_TAG || !TAG.test(t)) return setError(`Tags use letters, numbers and _ . : / - (up to ${MAX_TAG}).`)
    if (tags.length >= MAX_TAGS && !tags.includes(t)) return setError(`Up to ${MAX_TAGS} tags.`)
    if (!tags.includes(t)) onChange([...tags, t])
    setDraft('')
    setError(undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-medium text-fg/90">
        Tags
      </label>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-canvas/60 px-1.5 py-1 transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)]">
        <AnimatePresence initial={false}>
          {tags.map((t) => (
            <motion.span
              key={t}
              layout={motionSafe ? 'position' : false}
              initial={motionSafe ? { opacity: 0, scale: 0.8 } : { opacity: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={motionSafe ? { opacity: 0, scale: 0.8, transition: fast } : { opacity: 0, transition: fast }}
              transition={motionSafe ? spring : fast}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.06] pr-0.5 pl-2 font-mono text-[12px] text-fg/90"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
                className="grid size-5 place-items-center rounded text-muted hover:bg-white/[0.08] hover:text-fg"
              >
                <X aria-hidden className="size-3" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          id={id}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(undefined)
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          placeholder={tags.length ? '' : 'api, edge, eu-west'}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-msg` : undefined}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-[13px] text-fg placeholder:text-muted/60 focus:outline-none"
        />
      </div>
      {error && (
        <p id={`${id}-msg`} aria-live="polite" className="text-[12px] leading-4 text-err">
          {error}
        </p>
      )}
    </div>
  )
}
