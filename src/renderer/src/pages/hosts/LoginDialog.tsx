import { AnimatePresence, motion } from 'framer-motion'
import { FileInput, Fingerprint, KeyRound, Link2, RectangleEllipsis, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { HostMeta, IdentityRef } from '../../../../shared/inventory'
import { DEFAULT_VAULT_ID, MAX_LABEL, MAX_SECRET_VALUE, MAX_USERNAME, type IdentityInput, type SshKeyMeta } from '../../../../shared/vault'
import { inv, reloadInventory, useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SecretField, SelectField, TextField } from '../../ui/Field'
import { fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'
import { attempt } from '../../ui/common'
import { ImportKeyDialog, LinkKeyDialog } from '../vaults/KeyDialogs'

type Method = 'keys' | 'vaultKey' | 'password'

const METHODS: { id: Method; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'keys', label: 'Your SSH keys (default)', hint: 'ssh-agent, then the keys in ~/.ssh, like ssh does.', icon: Fingerprint },
  { id: 'vaultKey', label: 'A key in a vault', hint: 'A key OpsDeck keeps, or one it links in ~/.ssh.', icon: KeyRound },
  { id: 'password', label: 'Password', hint: 'Stored sealed in the vault.', icon: RectangleEllipsis },
]

const methodOf = (auth: IdentityRef['auth']): Method => (auth === 'key' ? 'vaultKey' : auth === 'password' ? 'password' : 'keys')

interface LoginDialogProps {
  open: boolean
  host: HostMeta
  /** How the host logs in now; prefills the form. */
  current: IdentityRef
  /** The environment whose default login the host inherits now, if any. */
  inheritedFrom?: string
  onClose: () => void
}

/**
 * Sets how one host logs in: finds or creates a matching identity in the host's first vault (or
 * the Default vault) and points the host at it.
 */
export function LoginDialog({ open, host, current, inheritedFrom, onClose }: LoginDialogProps) {
  const motionSafe = useMotionSafe()
  const formId = useId()
  const data = useInventory()
  const vaultId = host.vaultIds[0] ?? DEFAULT_VAULT_ID
  const [username, setUsername] = useState('')
  const [method, setMethod] = useState<Method>('keys')
  const [sshKeyId, setSshKeyId] = useState('')
  const [password, setPassword] = useState('')
  const [keys, setKeys] = useState<SshKeyMeta[]>([])
  const [sub, setSub] = useState<'import' | 'link' | null>(null)
  const [busy, setBusy] = useState(false)
  const radios = useRef<(HTMLButtonElement | null)[]>([])

  // The password never outlives the dialog, whether it saved or not.
  useEffect(() => {
    setPassword('')
    setSub(null)
    if (!open) return
    setUsername(current.username)
    setMethod(methodOf(current.auth))
    const used = current.source === 'global' ? undefined : data?.identities.find((i) => i.id === current.identityId)
    setSshKeyId(used?.vaultId === vaultId ? (used.sshKeyId ?? '') : '')
    let live = true
    api
      .invoke('key:list', vaultId)
      .then((ks) => live && setKeys(ks))
      .catch(() => live && setKeys([]))
    return () => {
      live = false
    }
    // Prefill once per opening; later inventory changes don't reset what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const vaultKeys = keys.filter((k) => k.vaultId === vaultId)
  const user = username.trim()
  const valid =
    user.length > 0 && (method !== 'vaultKey' || vaultKeys.some((k) => k.id === sshKeyId)) && (method !== 'password' || password.length > 0)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    const key = vaultKeys.find((k) => k.id === sshKeyId)
    const input: IdentityInput =
      method === 'keys'
        ? { vaultId, label: user, username: user, auth: 'agent' }
        : method === 'vaultKey'
          ? { vaultId, label: `${user} · ${key!.label}`, username: user, auth: 'key', sshKeyId }
          : { vaultId, label: `${user}@${host.label}`, username: user, auth: 'password', password }
    input.label = input.label.slice(0, MAX_LABEL)
    setPassword('')
    setBusy(true)
    const match =
      input.auth === 'password'
        ? ownPasswordIdentity(user)
        : data?.identities.find(
            (i) => i.vaultId === vaultId && i.username === user && i.auth === input.auth && (input.auth !== 'key' || i.sshKeyId === sshKeyId),
          )
    const identity = await attempt("Couldn't save the login", () =>
      !match
        ? api.invoke('identity:create', input)
        : input.auth === 'password'
          ? api.invoke('identity:update', match.id, { password: input.password })
          : Promise.resolve(match),
    )
    const saved = identity && (await inv.saveHost({ label: host.label, address: host.address, identityId: identity.id }, host.id))
    if (identity && identity !== match) await reloadInventory()
    setBusy(false)
    if (saved) {
      toast({ title: `${host.label} logs in as ${user}`, tone: 'success' })
      onClose()
    }
  }

  /**
   * A password can't be compared, so re-sealing is only safe for the identity this host itself
   * uses, and only when no other host or environment uses it too.
   */
  const ownPasswordIdentity = (user: string) => {
    if (!data || current.source !== 'host') return undefined
    const id = current.identityId
    const shared = data.hosts.some((h) => h.id !== host.id && h.identityId === id) || data.environments.some((e) => e.defaultIdentityId === id)
    const own = data.identities.find((i) => i.id === id)
    return !shared && own?.auth === 'password' && own.vaultId === vaultId && own.username === user ? own : undefined
  }

  // Radio group keys: arrows move and select, wrapping; only the checked radio is a tab stop.
  const onRadioKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + METHODS.length) % METHODS.length
    setMethod(METHODS[next].id)
    radios.current[next]?.focus()
  }

  const keyAdded = (k: SshKeyMeta) => {
    setKeys((ks) => [...ks.filter((x) => x.id !== k.id), k])
    setSshKeyId(k.id)
    setSub(null)
  }

  const reveal = {
    initial: motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 },
    animate: motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 },
    exit: { opacity: 0, height: motionSafe ? 0 : 'auto', transition: fast },
    transition: motionSafe ? spring : fast,
    className: 'overflow-hidden',
  }

  return (
    <>
      <Dialog
        open={open && !sub}
        onClose={onClose}
        title="Change login"
        description={`Who OpsDeck logs in as on ${host.label}, and how.`}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={!valid} loading={busy}>
              Save login
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
          <TextField
            autoFocus
            label="Username"
            placeholder="ubuntu"
            maxLength={MAX_USERNAME}
            spellCheck={false}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="font-mono"
          />
          <div role="radiogroup" aria-label="Login method" className="flex flex-col gap-1.5">
            {METHODS.map((m, i) => {
              const checked = method === m.id
              return (
                <motion.button
                  key={m.id}
                  ref={(el) => {
                    radios.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-labelledby={`${formId}-${m.id}`}
                  aria-describedby={`${formId}-${m.id}-hint`}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setMethod(m.id)}
                  onKeyDown={(e) => onRadioKey(e, i)}
                  initial={motionSafe ? { opacity: 0, y: 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...spring, delay: motionSafe ? staggerDelay(i, 0.03) : 0 }}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    checked ? 'border-accent/60 bg-accent/8' : 'border-line bg-canvas/40 hover:border-muted/30'
                  }`}
                >
                  <m.icon aria-hidden className={`size-4 shrink-0 ${checked ? 'text-accent' : 'text-muted'}`} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span id={`${formId}-${m.id}`} className="text-[13px] text-fg">
                      {m.label}
                    </span>
                    <span id={`${formId}-${m.id}-hint`} className="text-[11.5px] text-muted">
                      {m.hint}
                    </span>
                  </span>
                </motion.button>
              )
            })}
          </div>
          <AnimatePresence initial={false}>
            {method === 'vaultKey' && (
              <motion.div key="key" {...reveal}>
                <div className="flex flex-col gap-2">
                  <SelectField
                    label="SSH key"
                    value={sshKeyId}
                    onChange={(e) => setSshKeyId(e.target.value)}
                    hint={vaultKeys.length ? undefined : 'This vault has no SSH keys yet.'}
                  >
                    <option value="" disabled>
                      Pick a key…
                    </option>
                    {vaultKeys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label} · {k.keyType}
                      </option>
                    ))}
                  </SelectField>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" icon={<FileInput aria-hidden className="size-3.5" />} onClick={() => setSub('import')}>
                      Import key file…
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Link2 aria-hidden className="size-3.5" />} onClick={() => setSub('link')}>
                      Link key file…
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
            {method === 'password' && (
              <motion.div key="password" {...reveal}>
                <SecretField label="Password" maxLength={MAX_SECRET_VALUE} value={password} onChange={(e) => setPassword(e.target.value)} />
              </motion.div>
            )}
          </AnimatePresence>
          {inheritedFrom && (
            <p className="text-[12px] text-muted">{`${host.label} will stop using ${inheritedFrom}'s default login.`}</p>
          )}
        </form>
      </Dialog>
      <ImportKeyDialog open={open && sub === 'import'} vaultId={vaultId} onClose={() => setSub(null)} onSaved={keyAdded} />
      <LinkKeyDialog open={open && sub === 'link'} vaultId={vaultId} onClose={() => setSub(null)} onSaved={keyAdded} />
    </>
  )
}
