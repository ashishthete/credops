import { Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { KnownHostMeta } from '../../../../shared/ssh'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { attempt, ConfirmDialog, fail, type ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { createStore } from '../../ui/store'
import { relativeTime } from '../../ui/time'

const openStore = createStore(false)
export const openKnownHosts = () => openStore.set(true)
export const closeKnownHosts = () => openStore.set(false)

/** The hosts trusted through the app. Entries in ~/.ssh/known_hosts are not listed or editable. */
export function KnownHostsDialog() {
  const open = useSyncExternalStore(openStore.subscribe, openStore.get)
  const [entries, setEntries] = useState<KnownHostMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const [failed, setFailed] = useState(false)

  const load = () => {
    setFailed(false)
    return api
      .invoke('knownhost:list')
      .then(setEntries)
      .catch((err) => {
        setFailed(true)
        fail("Couldn't load known hosts", err)
      })
  }

  useEffect(() => {
    if (!open) return
    setQuery('')
    setEntries(null)
    void load()
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (entries ?? []).filter((e) => !q || [e.host, e.keyType, e.fingerprint].some((s) => s.toLowerCase().includes(q))),
    [entries, q],
  )

  const ask = (e: KnownHostMeta) =>
    setConfirm({
      title: `Remove ${e.host}?`,
      description: 'The next connection will ask you to trust this host again.',
      confirmLabel: 'Remove',
      run: async () => {
        await attempt("Couldn't remove the entry", () => api.invoke('knownhost:remove', e.id))
        await load()
      },
    })

  return (
    <>
      <Dialog
        open={open}
        onClose={() => closeKnownHosts()}
        title="Known hosts"
        description="Hosts you chose to trust in OpsDeck."
        width={680}
        footer={
          <Button variant="ghost" onClick={() => closeKnownHosts()}>
            Close
          </Button>
        }
      >
        <input
          type="search"
          aria-label="Filter known hosts"
          placeholder="Host, key type or fingerprint"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="mb-3 h-8 w-full rounded-lg border border-line bg-canvas/60 px-2.5 text-[12.5px] text-fg placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
        />
        <div className="max-h-[45vh] overflow-y-auto">
          {failed && entries === null ? (
            <div className="flex flex-col items-center gap-2 py-6 text-[12.5px] text-muted">
              Couldn't load the list.
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : entries === null ? (
            <p className="py-6 text-center text-[12.5px] text-muted">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-muted">{entries.length === 0 ? 'No trusted hosts yet.' : 'Nothing matches.'}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line/70">
              {shown.map((e) => (
                <li key={e.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[12.5px] text-fg">{e.host}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-muted">{e.keyType}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11.5px] break-all text-muted">{e.fingerprint}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted">
                      First seen {relativeTime(e.firstSeen)} · last seen {relativeTime(e.lastSeen)}
                    </div>
                  </div>
                  <Button variant="danger" size="sm" aria-label={`Remove ${e.host} ${e.keyType}`} icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => ask(e)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="mt-3 text-[11.5px] leading-5 text-muted">
          Entries in ~/.ssh/known_hosts are read-only here; use ssh-keygen -R to remove them.
        </p>
      </Dialog>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
