import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { onTermLines } from '../../../deploy/releases'
import { termText } from '../../../deploy/term-color'
import { loadTerminalFont, TERMINAL_FONT } from '../../../terminal/registry'
import { terminalTheme } from '../../../terminal/theme'

const SCROLLBACK = 100_000

/**
 * Ansible's console for a release, read-only: every task, its output and the recap, as ansible prints them,
 * streamed while it runs. Lines are already redacted in main.
 */
export function AnsibleTerminal({ releaseId, className = '' }: { releaseId: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      convertEol: false,
      scrollback: SCROLLBACK,
      fontFamily: TERMINAL_FONT,
      fontSize: 12.5,
      theme: { ...terminalTheme, cursor: terminalTheme.background },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const refit = () => {
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
    }
    void loadTerminalFont().then(refit)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
    observer?.observe(el)
    refit()
    const copy = term.onSelectionChange(() => {
      const selection = term.getSelection()
      if (selection) navigator.clipboard?.writeText(selection).catch(() => {})
    })
    const stop = onTermLines(releaseId, (lines, reset) => {
      if (reset) term.reset()
      if (lines.length) term.write(lines.map(termText).join(''))
      setEmpty((was) => (reset ? lines.length === 0 : was && lines.length === 0))
    })
    return () => {
      stop()
      copy.dispose()
      observer?.disconnect()
      term.dispose()
    }
  }, [releaseId])

  return (
    <div className={`relative min-h-0 overflow-hidden rounded-lg border border-line bg-canvas ${className}`} data-testid="ansible-terminal">
      <div ref={host} role="log" aria-label="Ansible output" className="size-full p-2" />
      {empty && <p className="pointer-events-none absolute inset-0 grid place-items-center text-[12.5px] text-muted">Waiting for ansible output</p>}
    </div>
  )
}
