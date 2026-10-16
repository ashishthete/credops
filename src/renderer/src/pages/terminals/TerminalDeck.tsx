import { AnimatePresence } from 'framer-motion'
import { useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import type { SessionMeta } from '../../../../shared/ssh'
import { useInventory } from '../../inventory/store'
import { closeSession, nextTab, openLocal, reconnectSession, sessionStore, setActive } from '../../terminal/sessions'
import { TerminalView } from '../../terminal/TerminalView'
import { ConfirmDialog, type ConfirmRequest } from '../../ui/common'
import { useShortcut } from '../../ui/shortcuts'
import { ConnectOverlay } from './ConnectOverlay'
import { QuickConnect } from './QuickConnect'
import { SessionEnded } from './SessionEnded'
import { TabStrip } from './TabStrip'

export const useSessions = () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get)

/**
 * Every open session as a tab over its terminal. Mounted once by the shell and only hidden off
 * the Terminals page, so terminals keep their state across navigation.
 */
export function TerminalDeck({ visible }: { visible: boolean }) {
  const navigate = useNavigate()
  const { sessions, order, activeId } = useSessions()
  const inventory = useInventory()
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const byId = new Map(sessions.map((s) => [s.id, s]))
  const tabs = order.flatMap((id) => byId.get(id) ?? [])
  const active = activeId ? byId.get(activeId) : undefined

  const envName = (id: string | null) => (id ? inventory?.environments.find((e) => e.id === id)?.name : undefined)

  // A live session asks first; one that is connecting, failed or closed goes at once.
  const requestClose = (meta: SessionMeta) => {
    if (meta.state !== 'ready') return void closeSession(meta.id)
    setConfirm({
      title: `Close ${meta.label}?`,
      description: 'The session will end.',
      confirmLabel: 'Close',
      run: () => closeSession(meta.id),
    })
  }

  useShortcut('mod+t', () => {
    navigate('/terminals')
    void openLocal()
  })

  return (
    <section aria-label="Terminals" hidden={!visible} className="absolute inset-0 z-[1] flex flex-col bg-canvas">
      {visible && <TabShortcuts onClose={() => active && requestClose(active)} />}
      {tabs.length === 0 ? (
        <QuickConnect visible={visible} />
      ) : (
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
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}

/** Bound only while the deck is on screen, so mod+w never closes a tab you can't see. */
function TabShortcuts({ onClose }: { onClose: () => void }) {
  useShortcut('mod+w', onClose)
  useShortcut('mod+shift+]', () => nextTab(1))
  useShortcut('mod+shift+[', () => nextTab(-1))
  return null
}

function SessionPane({ meta, visible, onClose }: { meta: SessionMeta; visible: boolean; onClose: () => void }) {
  const reconnect = () => void reconnectSession(meta.id)
  const overlay = meta.state === 'failed' || (meta.state === 'connecting' && meta.kind === 'ssh')
  return (
    <div hidden={!visible} className="absolute inset-0 flex flex-col">
      <div className="relative min-h-0 flex-1">
        <TerminalView sessionId={meta.id} visible={visible} />
        <AnimatePresence>{visible && overlay && <ConnectOverlay key="overlay" meta={meta} onReconnect={reconnect} onClose={onClose} />}</AnimatePresence>
      </div>
      {meta.state === 'closed' && <SessionEnded meta={meta} onReconnect={reconnect} />}
    </div>
  )
}
