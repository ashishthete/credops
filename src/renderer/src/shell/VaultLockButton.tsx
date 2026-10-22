import { Settings2 } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import { registerCommand } from '../ui/commands'
import { Padlock } from '../ui/Padlock'
import { formatShortcut, useShortcut } from '../ui/shortcuts'
import { toneColor } from '../ui/tone'
import { lockVaults } from '../vault/unlock'
import { openVaultSettings } from '../vault/VaultSettingsDialog'

/**
 * Sidebar lock button plus the vault palette commands and ⌘L. The shell only mounts behind the
 * auth gate, so the vaults are always set up and unlocked while this exists.
 */
export function VaultLockButton({ collapsed = false }: { collapsed?: boolean }) {
  useEffect(() => {
    const off = [
      registerCommand({
        id: 'vault.lock',
        title: 'Lock vaults',
        section: 'Vaults',
        keywords: ['padlock', 'secure'],
        shortcut: 'mod+l',
        run: () => void lockVaults(),
      }),
      registerCommand({
        id: 'vault.settings',
        title: 'Vault settings…',
        section: 'Vaults',
        keywords: ['auto-lock', 'touch id', 'master password'],
        run: openVaultSettings,
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [])

  useShortcut('mod+l', () => void lockVaults())

  return (
    <div className={`flex gap-1 pb-2 ${collapsed ? 'flex-col items-center px-2' : 'items-center px-3'}`} style={{ '--tone': toneColor.success } as CSSProperties}>
      <button
        type="button"
        onClick={() => void lockVaults()}
        title={collapsed ? 'Lock vaults' : 'Vaults are unlocked'}
        aria-label={collapsed ? 'Lock vaults' : undefined}
        className={`group flex h-8 items-center rounded-lg text-[13px] ${collapsed ? 'w-full justify-center' : 'min-w-0 flex-1 gap-2.5 px-2.5'} font-medium text-muted transition-colors select-none hover:bg-white/[0.035] hover:text-fg`}
      >
        <span className="tone-soft grid size-5 place-items-center rounded-md transition-colors duration-200">
          <Padlock open className="size-3.5" />
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-left">Lock vaults</span>
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
          </>
        )}
      </button>
      <button
        type="button"
        aria-label="Vault settings"
        title="Vault settings"
        onClick={openVaultSettings}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/[0.035] hover:text-fg"
      >
        <Settings2 aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
