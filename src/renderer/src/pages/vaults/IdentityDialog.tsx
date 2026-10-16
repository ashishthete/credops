import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  MAX_LABEL,
  MAX_SECRET_VALUE,
  MAX_USERNAME,
  type IdentityAuth,
  type IdentityMeta,
  type IdentityPatch,
  type SshKeyMeta,
} from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SecretField, SelectField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'
import { attempt } from './common'

const AUTH_LABEL: Record<IdentityAuth, string> = {
  agent: 'SSH agent',
  key: 'SSH key from this vault',
  password: 'Password',
}

interface IdentityDialogProps {
  open: boolean
  vaultId: string
  /** Keys to pick from; only this vault's are offered. */
  keys: SshKeyMeta[]
  /** Edits this identity; creates a new one when absent. */
  identity?: IdentityMeta
  onClose: () => void
  onSaved: (identity: IdentityMeta) => void
}

export function IdentityDialog({ open, vaultId, keys, identity, onClose, onSaved }: IdentityDialogProps) {
  const motionSafe = useMotionSafe()
  const formId = useId()
  const [label, setLabel] = useState('')
  const [username, setUsername] = useState('')
  const [auth, setAuth] = useState<IdentityAuth>('agent')
  const [sshKeyId, setSshKeyId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLabel(identity?.label ?? '')
    setUsername(identity?.username ?? '')
    setAuth(identity?.auth ?? 'agent')
    setSshKeyId(identity?.sshKeyId ?? '')
    setPassword('')
  }, [open, identity])

  const vaultKeys = keys.filter((k) => k.vaultId === vaultId)
  // A stored password can be kept when the identity already used password auth.
  const keepsPassword = !!identity?.hasPassword && identity.auth === 'password'
  const valid =
    label.trim().length > 0 &&
    username.trim().length > 0 &&
    (auth !== 'key' || vaultKeys.some((k) => k.id === sshKeyId)) &&
    (auth !== 'password' || password.length > 0 || keepsPassword)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    const fields = {
      label: label.trim(),
      username: username.trim(),
      auth,
      ...(auth === 'key' ? { sshKeyId } : {}),
      ...(auth === 'password' && password ? { password } : {}),
    }
    setPassword('')
    setBusy(true)
    const saved = await attempt(identity ? "Couldn't update the identity" : "Couldn't save the identity", () => {
      if (!identity) return api.invoke('identity:create', { vaultId, ...fields })
      const patch: IdentityPatch = {}
      if (fields.label !== identity.label) patch.label = fields.label
      if (fields.username !== identity.username) patch.username = fields.username
      if (auth !== identity.auth) patch.auth = auth
      if (fields.sshKeyId && fields.sshKeyId !== identity.sshKeyId) patch.sshKeyId = fields.sshKeyId
      if (fields.password) patch.password = fields.password
      return api.invoke('identity:update', identity.id, patch)
    })
    setBusy(false)
    if (saved) {
      toast({ title: identity ? `Updated ${saved.label}` : `Saved ${saved.label}`, tone: 'success' })
      onSaved(saved)
    }
  }

  const reveal = {
    initial: motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 },
    animate: motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 },
    exit: { opacity: 0, height: motionSafe ? 0 : 'auto', transition: fast },
    transition: motionSafe ? spring : fast,
    className: 'overflow-hidden',
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={identity ? 'Edit identity' : 'New identity'}
      description="A username and how to sign in with it, ready to attach to hosts."
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            Save identity
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            autoFocus
            label="Label"
            placeholder="ops"
            maxLength={MAX_LABEL}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <TextField
            label="Username"
            placeholder="ubuntu"
            maxLength={MAX_USERNAME}
            spellCheck={false}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="font-mono"
          />
        </div>
        <SelectField label="Authentication" value={auth} onChange={(e) => setAuth(e.target.value as IdentityAuth)}>
          {(Object.keys(AUTH_LABEL) as IdentityAuth[]).map((a) => (
            <option key={a} value={a}>
              {AUTH_LABEL[a]}
            </option>
          ))}
        </SelectField>
        <AnimatePresence initial={false}>
          {auth === 'key' && (
            <motion.div key="key" {...reveal}>
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
            </motion.div>
          )}
          {auth === 'password' && (
            <motion.div key="password" {...reveal}>
              <SecretField
                label="Password"
                maxLength={MAX_SECRET_VALUE}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint={keepsPassword ? 'Leave empty to keep the stored password.' : undefined}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </form>
    </Dialog>
  )
}
