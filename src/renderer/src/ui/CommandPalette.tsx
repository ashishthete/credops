import { AnimatePresence, motion } from 'framer-motion'
import { CornerDownLeft, Search } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import {
  closeCommandPalette,
  commandStore,
  getRecents,
  markRecent,
  paletteOpenStore,
  rankCommands,
  toggleCommandPalette,
  type Command,
  type RankedCommand,
} from './commands'
import { fast, spring, useMotionSafe } from './motion'
import { formatShortcut, useShortcut } from './shortcuts'

export { openCommandPalette, closeCommandPalette, registerCommand, type Command } from './commands'

/** Global ⌘K palette. Mount once; commands come from registerCommand(). */
export function CommandPalette() {
  const open = useSyncExternalStore(paletteOpenStore.subscribe, paletteOpenStore.get)
  useShortcut('mod+k', toggleCommandPalette)
  return <AnimatePresence>{open && <PaletteDialog key="palette" />}</AnimatePresence>
}

function PaletteDialog() {
  const motionSafe = useMotionSafe()
  const commands = useSyncExternalStore(commandStore.subscribe, commandStore.get)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listboxId = useId()
  const optionId = (i: number) => `${listboxId}-opt-${i}`

  const results = useMemo(() => rankCommands(commands, query, getRecents()), [commands, query])
  const activeIndex = results.length ? Math.min(active, results.length - 1) : -1

  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  })

  const runCommand = (cmd: Command) => {
    markRecent(cmd.id)
    closeCommandPalette()
    cmd.run()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const n = results.length
    if (e.key === 'Escape') {
      e.preventDefault()
      closeCommandPalette()
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault()
      setActive((activeIndex + 1) % n)
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault()
      setActive((activeIndex - 1 + n) % n)
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      runCommand(results[activeIndex].command)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[14vh] backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fast}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeCommandPalette()
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        className="w-full max-w-[600px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop"
        initial={motionSafe ? { opacity: 0, scale: 0.96, y: -8 } : { opacity: 0 }}
        animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
        exit={motionSafe ? { opacity: 0, scale: 0.98, y: -4, transition: fast } : { opacity: 0 }}
        transition={motionSafe ? spring : fast}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label="Search commands"
            placeholder="Type a command or search…"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            className="h-13 w-full bg-transparent text-[15px] text-fg placeholder:text-muted/70 focus:outline-none focus-visible:outline-none"
          />
          <Keycaps keys={['Esc']} />
        </div>

        <div className="max-h-[min(380px,52vh)] overflow-y-auto p-2">
          <div id={listboxId} role="listbox" aria-label="Commands">
            {groupRows(results).map(({ group, rows }, gi) => (
              <div key={group} role="group" aria-labelledby={`${listboxId}-g${gi}`}>
                <div
                  id={`${listboxId}-g${gi}`}
                  className={`px-3 pb-1.5 text-[11px] font-medium text-muted ${gi === 0 ? 'pt-1' : 'pt-3'}`}
                >
                  {group}
                </div>
                {rows.map(({ result, index }) => (
                  <PaletteRow
                    key={result.command.id}
                    id={optionId(index)}
                    result={result}
                    active={index === activeIndex}
                    motionSafe={motionSafe}
                    onHover={() => setActive(index)}
                    onRun={() => runCommand(result.command)}
                  />
                ))}
              </div>
            ))}
          </div>
          {results.length === 0 && <p className="px-3 py-10 text-center text-sm text-muted">No results</p>}
        </div>

        <div className="flex items-center gap-4 border-t border-line bg-canvas/40 px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <Keycaps keys={['↑', '↓']} /> to move
          </span>
          <span className="flex items-center gap-1.5">
            <Keycaps keys={['↵']} /> to run
          </span>
        </div>
      </motion.div>
    </motion.div>
  )
}

interface PaletteRowProps {
  id: string
  result: RankedCommand
  active: boolean
  motionSafe: boolean
  onHover: () => void
  onRun: () => void
}

function PaletteRow({ id, result, active, motionSafe, onHover, onRun }: PaletteRowProps) {
  const { command, indices } = result
  return (
    <div
        id={id}
        role="option"
        aria-selected={active}
        onMouseMove={active ? undefined : onHover}
        onClick={onRun}
        className={`relative flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm select-none ${
          active ? 'text-fg' : 'text-fg/80'
        }`}
      >
        {active &&
          (motionSafe ? (
            <motion.span
              layoutId="palette-active"
              transition={spring}
              className="absolute inset-0 rounded-lg bg-accent/12 shadow-[inset_2px_0_0_0_var(--accent)]"
            />
          ) : (
            <span className="absolute inset-0 rounded-lg bg-accent/12 shadow-[inset_2px_0_0_0_var(--accent)]" />
          ))}
        <span className="relative min-w-0 flex-1 truncate">
          <Highlighted text={command.title} indices={indices} />
        </span>
        {command.shortcut && <Keycaps className="relative" keys={formatShortcut(command.shortcut)} />}
        {active && !command.shortcut && <CornerDownLeft aria-hidden className="relative size-3.5 text-muted" />}
    </div>
  )
}

// Results arrive section-contiguous; split them into groups while keeping flat indices.
function groupRows(results: RankedCommand[]) {
  const groups: Array<{ group: string; rows: Array<{ result: RankedCommand; index: number }> }> = []
  results.forEach((result, index) => {
    const last = groups[groups.length - 1]
    if (last?.group === result.group) last.rows.push({ result, index })
    else groups.push({ group: result.group, rows: [{ result, index }] })
  })
  return groups
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>
  const hit = new Set(indices)
  return (
    <>
      {text.split('').map((ch, i) =>
        hit.has(i) ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  )
}

function Keycaps({ keys, className = '' }: { keys: string[]; className?: string }) {
  return (
    <span aria-hidden className={`flex shrink-0 items-center gap-1 ${className}`}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="grid h-5 min-w-5 place-items-center rounded-[5px] border border-line bg-surface-2 px-1 text-[11px] leading-none text-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}
