import { LogIn, LogOut, Unplug } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { cancelSignIn, connectHub, signInHub, signOutHub, unlinkHub, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { TextField } from '../../ui/Field'
import { PendingNotice, roleLabel } from './shared'
import { useHubGroupNames } from './names'

/** Connect, sign-in, waiting, signed-in and pending states of the Hub link. */
export function ConnectCard() {
  const { status, busy } = useHub()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const groupNames = useHubGroupNames()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (url.trim()) void connectHub(url.trim(), setError)
  }

  if (!status.linked) {
    return (
      <form onSubmit={submit} className="flex max-w-xl flex-col gap-3">
        <p className="text-[13px] leading-5 text-muted">
          Connect to your team's Hub to sign in with Microsoft and share deployments. Everything else in OpsDeck keeps working
          without it.
        </p>
        <TextField
          label="Hub URL"
          placeholder="https://hub.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          error={error ?? undefined}
          autoFocus
          spellCheck={false}
        />
        <div>
          <Button type="submit" loading={busy} disabled={!url.trim()}>
            Connect
          </Button>
        </div>
      </form>
    )
  }

  const disconnect = (
    <Button
      variant="ghost"
      size="sm"
      icon={<Unplug aria-hidden className="size-3.5" />}
      onClick={() =>
        setConfirm({
          title: `Disconnect from ${status.hubName}?`,
          description: 'You will be signed out and OpsDeck will stop using this Hub. You can connect again later.',
          confirmLabel: 'Disconnect',
          run: async () => {
            await unlinkHub()
          },
        })
      }
    >
      Disconnect
    </Button>
  )

  let body
  if (status.signingIn) {
    body = (
      <div className="flex items-center justify-between gap-4">
        <p role="status" className="text-[13px] text-muted">
          Waiting for your browser…
        </p>
        {/* Never disabled: this is the way out if the browser tab was closed. */}
        <Button variant="ghost" size="sm" onClick={() => void cancelSignIn()}>
          Cancel
        </Button>
      </div>
    )
  } else if (!status.signedIn || !status.user) {
    body = (
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-muted">Sign in to see and run your team's deployments.</p>
        <Button icon={<LogIn aria-hidden className="size-3.5" />} loading={busy} onClick={() => void signInHub()}>
          Sign in with Microsoft
        </Button>
      </div>
    )
  } else {
    const u = status.user
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium text-fg">{u.name}</p>
            <p className="truncate text-[12.5px] text-muted">{u.upn}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={u.role === 'admin' ? 'info' : 'success'}>{roleLabel(u.role)}</Badge>
              {u.groupIds.every((id) => groupNames(id) !== undefined) ? (
                u.groupIds.map((id) => (
                  <Badge key={id} tone="info">
                    {groupNames(id)}
                  </Badge>
                ))
              ) : (
                // Only admins can list groups, so for everyone else the names can't be resolved.
                <span className="text-[12.5px] text-muted">{`In ${plural(u.groupIds.length, 'group')}`}</span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" icon={<LogOut aria-hidden className="size-3.5" />} loading={busy} onClick={() => void signOutHub()}>
            Sign out
          </Button>
        </div>
        {u.status === 'pending' && <PendingNotice />}
        {u.status === 'disabled' && (
          <p role="alert" className="text-[12.5px] text-err">
            Your access to this Hub is turned off. Ask a Hub admin.
          </p>
        )}
      </div>
    )
  }

  return (
    <section aria-label="Hub connection" className="max-w-2xl rounded-xl border border-line bg-surface/70 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-fg">{status.hubName}</h3>
          <p className="truncate font-mono text-[12px] text-muted">{status.url}</p>
        </div>
        {disconnect}
      </div>
      {body}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}
