import { Settings2 } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import { registerCommand } from '../ui/commands'
import { Padlock } from '../ui/Padlock'
import { formatShortcut, useShortcut } from '../ui/shortcuts'
import { toneColor } from '../ui/tone'
import { useVaultStatus, vaultStatusStore } from '../vault/status'
import { ensureUnlocked, lockVaults } from '../vault/unlock'
import { openVaultSettings } from '../vault/VaultSettingsDialog'

/** Sidebar lock toggle plus the vault palette commands and ⌘L. */
export function VaultLockButton() {
  const status = useVaultStatus()
  const loaded = status !== null
  const setUp = !!status?.setUp
  const unlocked = !!status?.unlocked

  useEffect(() => {
    if (!loaded) return
    const off = [
      unlocked
        ? registerCommand({
            id: 'vault.lock',
            title: 'Lock vaults',
            section: 'Vaults',
            keywords: ['padlock', 'secure'],
            shortcut: 'mod+l',
            run: () => void lockVaults(),
          })
        : registerCommand({
            id: 'vault.unlock',
            title: setUp ? 'Unlock vaults' : 'Set up vaults',
            section: 'Vaults',
            keywords: ['master password', 'touch id'],
            run: () => void ensureUnlocked(),
          }),
    ]
    if (setUp) {
      off.push(
        registerCommand({
          id: 'vault.settings',
          title: 'Vault settings…',
          section: 'Vaults',
          keywords: ['auto-lock', 'touch id', 'master password'],
          run: openVaultSettings,
        }),
      )
    }
    return () => off.forEach((fn) => fn())
  }, [loaded, setUp, unlocked])

  useShortcut('mod+l', () => {
    if (vaultStatusStore.get()?.unlocked) void lockVaults()
  })

  const label = !loaded ? 'Vaults' : !setUp ? 'Set up vaults' : unlocked ? 'Lock vaults' : 'Unlock vaults'
  const tone = unlocked ? toneColor.success : toneColor.info
  return (
    <div className="flex items-center gap-1 px-3 pb-2" style={{ '--tone': tone } as CSSProperties}>
      <button
        type="button"
        disabled={!loaded}
        onClick={() => void (unlocked ? lockVaults() : ensureUnlocked())}
        title={unlocked ? 'Vaults are unlocked' : 'Vaults are locked'}
        className="group flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors select-none hover:bg-white/[0.035] hover:text-fg disabled:opacity-50"
      >
        <span
          className={`grid size-5 place-items-center rounded-md transition-colors duration-200 ${
            unlocked ? 'tone-soft' : 'text-muted group-hover:text-fg'
          }`}
        >
          <Padlock open={unlocked} className="size-3.5" />
        </span>
        <span className="flex-1 truncate text-left">{label}</span>
        {unlocked && (
          <span aria-hidden className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {formatShortcut('mod+l').map((k) => (
              <kbd
                key={k}
                className="grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-line bg-surface-2 px-1 text-[10.5px] leading-none text-muted"
              >
                {k}
              </kbd>
            ))}
          </span>
        )}
      </button>
      {setUp && (
        <button
          type="button"
          aria-label="Vault settings"
          title="Vault settings"
          onClick={openVaultSettings}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/[0.035] hover:text-fg"
        >
          <Settings2 aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
}
