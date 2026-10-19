import { AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { SessionMeta } from '../../../../shared/ssh'
import { useInventory } from '../../inventory/store'
import { useConnect } from '../../terminal/connect'
import { closeSession, nextTab, openLocal, reconnectSession, sessionStore, setActive } from '../../terminal/sessions'
import { TerminalView } from '../../terminal/TerminalView'
import { ConfirmDialog, type ConfirmRequest } from '../../ui/common'
import { useShortcut } from '../../ui/shortcuts'
import { ConnectOverlay } from './ConnectOverlay'
import { openKnownHosts } from './KnownHostsDialog'
import { SessionEnded } from './SessionEnded'
import { paneId, TabStrip, tabId } from './TabStrip'

export const useSessions = () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get)

/**
 * Every open session as a tab over its terminal. Mounted once by the shell and only hidden off
 * the Terminals page, so terminals keep their state across navigation.
 */
export function TerminalDeck({ visible }: { visible: boolean }) {
  const navigate = useNavigate()
  const { connectLocal } = useConnect()
  const { sessions, order, activeId } = useSessions()
  const inventory = useInventory()
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // The session a close was asked for, with the tab order at that moment, until focus is placed.
  const [closing, setClosing] = useState<{ id: string; order: string[] } | null>(null)
  const [refocus, setRefocus] = useState<{ id: string; order: string[] } | null>(null)

  const byId = new Map(sessions.map((s) => [s.id, s]))
  const tabs = order.flatMap((id) => byId.get(id) ?? [])
  const active = activeId ? byId.get(activeId) : undefined

  // Where you were before Terminals; with no tab left to show (a direct visit, the last tab closed
  // or its shell exited) the deck goes back there, or home.
  const location = useLocation()
  const before = useRef<string | null>(null)
  if (!location.pathname.startsWith('/terminals')) before.current = location.pathname + location.search
  useEffect(() => {
    if (visible && tabs.length === 0) navigate(before.current ?? '/', { replace: true })
  }, [tabs.length, visible, navigate])

  const envName = (id: string | null) => (id ? inventory?.environments.find((e) => e.id === id)?.name : undefined)

  // A live session asks first; one that is connecting, failed or closed goes at once. Either way
  // focus is placed afterwards, since the button that had it may be gone.
  const requestClose = (meta: SessionMeta) => {
    const target = { id: meta.id, order }
    if (meta.state !== 'ready') return void closeSession(meta.id).then(() => setRefocus(target))
    setClosing(target)
    setConfirm({
      title: `Close ${meta.label}?`,
      description: 'The session will end.',
      confirmLabel: 'Close',
      run: () => closeSession(meta.id),
    })
  }

  // Runs after the dialog hands focus back (a layout effect), so this placement wins.
  useEffect(() => {
    if (!refocus) return
    setRefocus(null)
    focusAfterClose(refocus.id, refocus.order)
  }, [refocus])

  // The shell opens first; going to an empty Terminals page would bounce straight back.
  useShortcut('mod+t', () => void connectLocal())

  return (
    <section aria-label="Terminals" hidden={!visible} className="absolute inset-0 z-[1] flex flex-col bg-canvas">
      {visible && <TabShortcuts onClose={() => active && requestClose(active)} />}
      {tabs.length > 0 && (
        <>
          <TabStrip
            sessions={tabs}
            activeId={activeId}
            envName={envName}
            onSelect={setActive}
            onClose={requestClose}
            onNew={() => void openLocal()}
          />
          <div className="relative min-h-0 flex-1">
            {tabs.map((s) => (
              <SessionPane key={s.id} meta={s} visible={visible && s.id === activeId} onClose={() => requestClose(s)} />
            ))}
          </div>
        </>
      )}
      <ConfirmDialog
        request={confirm}
        onClose={() => {
          setConfirm(null)
          setRefocus(closing)
          setClosing(null)
        }}
      />
    </section>
  )
}

/**
 * After a close: the tab itself if it is still open (a cancel or a failed close), else the next
 * tab, else the one before. With none left the deck leaves the page and focus is left be. Focus that went somewhere real is left be.
 */
function focusAfterClose(id: string, before: string[]): void {
  const now = document.activeElement
  const lost = !now || now === document.body || !now.isConnected || now.closest('[data-session]')
  if (!lost) return
  const { order } = sessionStore.get()
  const at = before.indexOf(id)
  const next = order.includes(id)
    ? id
    : (before.slice(at + 1).find((x) => order.includes(x)) ?? before.slice(0, at).reverse().find((x) => order.includes(x)))
  if (next) document.getElementById(tabId(next))?.focus()
}

/** Bound only while the deck is on screen, so mod+w never closes a tab you can't see. */
function TabShortcuts({ onClose }: { onClose: () => void }) {
  useShortcut('mod+w', onClose)
  useShortcut('mod+shift+]', () => nextTab(1))
  useShortcut('mod+shift+[', () => nextTab(-1))
  return null
}

function SessionPane({ meta, visible, onClose }: { meta: SessionMeta; visible: boolean; onClose: () => void }) {
  // The store drops a second reconnect too; this only keeps the button honest while one runs.
  const [reconnecting, setReconnecting] = useState(false)
  const reconnect = () => {
    if (reconnecting) return
    setReconnecting(true)
    void reconnectSession(meta.id).finally(() => setReconnecting(false))
  }
  const overlay = meta.state === 'failed' || (meta.state === 'connecting' && meta.kind === 'ssh')
  return (
    <div
      hidden={!visible}
      role="tabpanel"
      id={paneId(meta.id)}
      aria-labelledby={tabId(meta.id)}
      className="absolute inset-0 flex flex-col"
    >
      <div className="relative min-h-0 flex-1">
        <TerminalView sessionId={meta.id} visible={visible} />
        <AnimatePresence>
          {visible && overlay && (
            <ConnectOverlay key="overlay" meta={meta} onReconnect={reconnect} reconnecting={reconnecting} onClose={onClose} onOpenKnownHosts={openKnownHosts} />
          )}
        </AnimatePresence>
      </div>
      {meta.state === 'closed' && <SessionEnded meta={meta} onReconnect={reconnect} reconnecting={reconnecting} />}
    </div>
  )
}
