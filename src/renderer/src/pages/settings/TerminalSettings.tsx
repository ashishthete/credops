import { SquareTerminal } from 'lucide-react'
import { saveSettings, useIntegrations } from '../../settings/store'
import { formatShortcut } from '../../ui/shortcuts'
import { Switch } from '../../ui/Switch'

/** Terminal preferences; a section of the Settings page. The Integrations section loads the settings. */
export function TerminalSection() {
  const { settings } = useIntegrations()
  return (
    <section aria-labelledby="settings-terminal" className="mt-2 max-w-[640px] rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <SquareTerminal aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="settings-terminal" className="text-[14px] font-semibold text-fg">
            Terminal
          </h2>
          <div className="mt-3 flex items-center justify-between gap-3 text-[13px] text-fg/90">
            <span>Copy text when it is selected</span>
            <Switch
              label="Copy on select"
              checked={!!settings?.terminalCopyOnSelect}
              disabled={!settings}
              onChange={(terminalCopyOnSelect) => void saveSettings({ terminalCopyOnSelect })}
            />
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Never on hosts in a protected environment, so a secret printed there can't reach the clipboard by accident.{' '}
            {formatShortcut('mod+c').join('')} copies a selection either way.
          </p>
        </div>
      </div>
    </section>
  )
}
