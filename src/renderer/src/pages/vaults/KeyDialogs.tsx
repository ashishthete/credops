import { AnimatePresence, motion } from 'framer-motion'
import { FileKey2, FolderSearch, Lock } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  MAX_KEY_COMMENT,
  MAX_LABEL,
  MAX_PASSPHRASE,
  type KeyImportInput,
  type LocalKeyCandidate,
  type SshKeyMeta,
} from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SecretField, TextAreaField, TextField } from '../../ui/Field'
import { exitFast, fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { withUnlock } from '../../vault/unlock'
import { attempt, errorText, fail } from '../../ui/common'

const PASSPHRASE_REQUIRED = 'passphrase required'

interface NewKeyDialogProps {
  open: boolean
  vaultId: string
  onClose: () => void
  onSaved: (key: SshKeyMeta) => void
}

function Footer({ formId, busy, valid, label, onClose }: { formId: string; busy: boolean; valid: boolean; label: string; onClose: () => void }) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={formId} disabled={!valid} loading={busy}>
        {label}
      </Button>
    </>
  )
}

/** Slides a passphrase field in and out as the key turns out to be encrypted or not. */
function PassphraseSlot({ show, children }: { show: boolean; children: ReactNode }) {
  const motionSafe = useMotionSafe()
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="passphrase"
          initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 }}
          exit={motionSafe ? { opacity: 0, height: 0, transition: exitFast } : { opacity: 0, transition: exitFast }}
          transition={motionSafe ? spring : fast}
          className="overflow-hidden"
        >
          <div className="pt-0.5">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function GenerateKeyDialog({ open, vaultId, onClose, onSaved }: NewKeyDialogProps) {
  const formId = useId()
  const [label, setLabel] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setLabel('')
      setComment('')
    }
  }, [open])

  const valid = label.trim().length > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const input = { vaultId, label: label.trim(), ...(comment.trim() ? { comment: comment.trim() } : {}) }
    const key = await attempt("Couldn't generate the key", () => api.invoke('key:generate', input))
    setBusy(false)
    if (key) {
      toast({ title: `Generated ${key.label}`, description: key.fingerprint, tone: 'success' })
      onSaved(key)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Generate SSH key"
      description="A fresh ed25519 key pair. The private half never leaves this vault."
      footer={<Footer formId={formId} busy={busy} valid={valid} label="Generate key" onClose={onClose} />}
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField
          autoFocus
          label="Label"
          placeholder="deploy"
          maxLength={MAX_LABEL}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          label="Comment"
          placeholder="Optional"
          maxLength={MAX_KEY_COMMENT}
          hint="Written after the public key; defaults to your user and machine."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </form>
    </Dialog>
  )
}

/**
 * Whether pasted key text is passphrase-protected: PEM headers say so, and an openssh-key-v1
 * blob names its cipher right after the magic. Unknown shapes count as unencrypted; main has the
 * final word (it answers "passphrase required").
 */
export function isEncryptedKey(text: string): boolean {
  if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/.test(text)) return true
  const body = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text)?.[1]
  if (!body) return false
  try {
    const head = atob(body.replace(/\s+/g, '').slice(0, 64))
    const magic = 'openssh-key-v1\0'
    if (!head.startsWith(magic)) return false
    const at = magic.length
    const len = (head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)
    return head.slice(at + 4, at + 4 + len) !== 'none'
  } catch {
    return false
  }
}

export function ImportKeyDialog({ open, vaultId, onClose, onSaved }: NewKeyDialogProps) {
  const formId = useId()
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const [passphrase, setPassphrase] = useState('')
  // Main answered "passphrase required" for this text (or picked file); cleared when the text changes.
  const [forcePass, setForcePass] = useState(false)
  const [busy, setBusy] = useState<'paste' | 'file' | null>(null)

  // Key material and passphrase never outlive the dialog, whether it saved or not.
  useEffect(() => {
    setText('')
    setPassphrase('')
    setForcePass(false)
    if (open) setLabel('')
  }, [open])

  const pasted = text.trim().length > 0
  const needsPass = (pasted && isEncryptedKey(text)) || forcePass
  const base: Omit<KeyImportInput, 'privateKey'> = {
    vaultId,
    label: label.trim(),
    ...(needsPass && passphrase ? { passphrase } : {}),
  }
  const ready = label.trim().length > 0 && (!needsPass || passphrase.length > 0)

  const done = (key: SshKeyMeta) => {
    setText('')
    setPassphrase('')
    toast({ title: `Imported ${key.label}`, description: key.fingerprint, tone: 'success' })
    onSaved(key)
  }

  // "passphrase required" asks for it inline instead of failing with a toast.
  const run = async (which: 'paste' | 'file', call: () => Promise<SshKeyMeta | null>) => {
    if (!ready || busy) return
    setBusy(which)
    try {
      const key = await withUnlock(call)
      if (key) done(key)
    } catch (err) {
      if (errorText(err) === PASSPHRASE_REQUIRED) setForcePass(true)
      else fail("Couldn't import the key", err)
    } finally {
      setBusy(null)
    }
  }

  const importPasted = (e: FormEvent) => {
    e.preventDefault()
    if (pasted) void run('paste', () => api.invoke('key:import', { ...base, privateKey: text }))
  }

  // Main opens the file picker and answers null on cancel.
  const importFile = () => void run('file', () => api.invoke('key:importFile', base))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import key"
      description="Paste a private key, or pick its file. It is encrypted into this vault."
      width={480}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            disabled={!ready || pasted}
            loading={busy === 'file'}
            icon={<FolderSearch aria-hidden className="size-3.5" />}
            onClick={importFile}
          >
            Choose file…
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!ready || !pasted} loading={busy === 'paste'}>
            Import key
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={importPasted} className="flex flex-col gap-3.5" noValidate>
        <TextField
          autoFocus
          label="Label"
          placeholder="work laptop"
          maxLength={MAX_LABEL}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextAreaField
          label="Private key"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setForcePass(false)
          }}
          className="h-28 resize-none font-mono text-[11.5px]"
          hint={pasted ? undefined : 'Or leave this empty and choose the key file.'}
        />
        <PassphraseSlot show={needsPass}>
          <SecretField
            label="Passphrase"
            maxLength={MAX_PASSPHRASE}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            hint={
              !pasted && forcePass
                ? 'That file is encrypted. Enter its passphrase, then choose it again.'
                : 'This key is encrypted; its passphrase is stored with it.'
            }
          />
        </PassphraseSlot>
      </form>
    </Dialog>
  )
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path

export function LinkKeyDialog({ open, vaultId, onClose, onSaved }: NewKeyDialogProps) {
  const motionSafe = useMotionSafe()
  const formId = useId()
  const [candidates, setCandidates] = useState<LocalKeyCandidate[] | null>(null)
  const [picked, setPicked] = useState<LocalKeyCandidate | null>(null)
  const [label, setLabel] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPassphrase('')
    if (!open) return
    let live = true
    setCandidates(null)
    setPicked(null)
    setLabel('')
    api
      .invoke('key:scanLocal')
      .then((c) => live && setCandidates(c))
      .catch((err: unknown) => {
        if (!live) return
        setCandidates([])
        fail("Couldn't read ~/.ssh", err)
      })
    return () => {
      live = false
    }
  }, [open])

  const pick = (c: LocalKeyCandidate) => {
    setPicked(c)
    setLabel(basename(c.path))
    setPassphrase('')
  }

  const valid = !!picked && label.trim().length > 0 && (!picked.encrypted || passphrase.length > 0)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || !picked || busy) return
    setBusy(true)
    const input = {
      vaultId,
      label: label.trim(),
      path: picked.path,
      ...(picked.encrypted ? { passphrase } : {}),
    }
    const key = await attempt("Couldn't link the key", () => api.invoke('key:link', input))
    setBusy(false)
    if (key) {
      setPassphrase('')
      toast({ title: `Linked ${key.label}`, description: picked.path, tone: 'success' })
      onSaved(key)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Link from ~/.ssh"
      description="OpsDeck keeps the path and public key; the private key stays in its file."
      width={520}
      footer={<Footer formId={formId} busy={busy} valid={valid} label="Link key" onClose={onClose} />}
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <div role="radiogroup" aria-label="Keys in ~/.ssh" className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
          {candidates === null ? (
            Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[52px] w-full rounded-lg" />)
          ) : candidates.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-muted">
              No private keys found in ~/.ssh.
            </p>
          ) : (
            candidates.map((c, i) => {
              const checked = picked?.path === c.path
              return (
                <motion.button
                  key={c.path}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={c.alreadyLinked}
                  onClick={() => pick(c)}
                  initial={motionSafe ? { opacity: 0, y: 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...spring, delay: motionSafe ? staggerDelay(i, 0.03) : 0 }}
                  className={`relative flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                    checked ? 'border-accent/60 bg-accent/8' : 'border-line bg-canvas/40 hover:border-muted/30'
                  }`}
                >
                  <FileKey2 aria-hidden className={`size-4 shrink-0 ${checked ? 'text-accent' : 'text-muted'}`} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12.5px] text-fg">{basename(c.path)}</span>
                      <span className="text-[11px] text-muted">{c.keyType}</span>
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted">{c.fingerprint}</span>
                  </span>
                  {c.encrypted && (
                    <Badge tone="warn">
                      <Lock aria-hidden className="size-2.5" />
                      Encrypted
                    </Badge>
                  )}
                  {c.alreadyLinked && <Badge tone="success">Linked</Badge>}
                </motion.button>
              )
            })
          )}
        </div>
        <AnimatePresence initial={false}>
          {picked && (
            <motion.div
              key="details"
              initial={motionSafe ? { opacity: 0, y: -4 } : { opacity: 0 }}
              animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
              transition={motionSafe ? spring : fast}
              className="flex flex-col gap-3.5"
            >
              <TextField label="Label" maxLength={MAX_LABEL} value={label} onChange={(e) => setLabel(e.target.value)} />
            </motion.div>
          )}
        </AnimatePresence>
        <PassphraseSlot show={!!picked?.encrypted}>
          <SecretField
            label="Passphrase"
            maxLength={MAX_PASSPHRASE}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            hint="This key is encrypted; its passphrase is stored in the vault."
          />
        </PassphraseSlot>
      </form>
    </Dialog>
  )
}

export function RenameKeyDialog({
  open,
  sshKey,
  onClose,
  onSaved,
}: {
  open: boolean
  sshKey: SshKeyMeta | null
  onClose: () => void
  onSaved: (key: SshKeyMeta) => void
}) {
  const formId = useId()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setLabel(sshKey?.label ?? '')
  }, [open, sshKey])

  const valid = label.trim().length > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || !sshKey || busy) return
    setBusy(true)
    const key = await attempt("Couldn't rename the key", () => api.invoke('key:update', sshKey.id, { label: label.trim() }))
    setBusy(false)
    if (key) onSaved(key)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename key"
      footer={<Footer formId={formId} busy={busy} valid={valid} label="Save" onClose={onClose} />}
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate>
        <TextField autoFocus label="Label" maxLength={MAX_LABEL} value={label} onChange={(e) => setLabel(e.target.value)} />
      </form>
    </Dialog>
  )
}
