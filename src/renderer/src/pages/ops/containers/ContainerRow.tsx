import { AnimatePresence, motion } from 'framer-motion'
import { Play, RotateCw, ScrollText, SquareTerminal, Square } from 'lucide-react'
import type { ContainerAction, ContainerMeta } from '../../../../../shared/ops'
import { Button } from '../../../ui/Button'
import { ListRow } from '../../../ui/common'
import { fast, useMotionSafe } from '../../../ui/motion'

const DOT: Record<ContainerMeta['state'], string> = {
  running: 'bg-ok',
  restarting: 'bg-warn',
  paused: 'bg-warn',
  exited: 'bg-muted',
  created: 'bg-muted',
  dead: 'bg-muted',
  removing: 'bg-muted',
  unknown: 'bg-muted',
}

export interface RowActions {
  logs: () => void
  shell: () => void
  act: (action: ContainerAction) => void
}

/** One container: state dot, identity, status and ports, and its actions. */
export function ContainerRow({
  c,
  index,
  stagger,
  busy,
  actions,
}: {
  c: ContainerMeta
  index: number
  stagger: boolean
  busy: ContainerAction | undefined
  actions: RowActions
}) {
  const motionSafe = useMotionSafe()
  const running = c.state === 'running' || c.state === 'restarting' || c.state === 'paused'
  const canExec = c.state === 'running' || c.state === 'restarting'
  const icon = 'size-3.5'
  return (
    <ListRow label={c.name} index={index} stagger={stagger}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={c.state}
          role="img"
          aria-label={c.state}
          title={c.state}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionSafe ? fast : { duration: 0 }}
          className={`size-2 shrink-0 rounded-full ${DOT[c.state]}`}
        />
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-fg">{c.name}</span>
        <span className="truncate font-mono text-[11.5px] text-muted">{c.image}</span>
      </div>
      <div className="hidden min-w-0 basis-56 flex-col lg:flex">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={c.status}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionSafe ? fast : { duration: 0 }}
            className="truncate text-[12px] text-fg/85"
          >
            {c.status}
          </motion.span>
        </AnimatePresence>
        {c.ports && <span className="truncate font-mono text-[11px] text-muted">{c.ports}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" aria-label={`Logs of ${c.name}`} icon={<ScrollText aria-hidden className={icon} />} onClick={actions.logs}>
          Logs
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Shell in ${c.name}`}
          disabled={!canExec}
          title={canExec ? undefined : c.state === 'paused' ? 'A paused container cannot run a shell; unpause it first' : 'Start the container to open a shell'}
          icon={<SquareTerminal aria-hidden className={icon} />}
          onClick={actions.shell}
        >
          Shell
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Restart ${c.name}`}
          loading={busy === 'restart'}
          disabled={!!busy}
          icon={<RotateCw aria-hidden className={icon} />}
          onClick={() => actions.act('restart')}
        >
          Restart
        </Button>
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Stop ${c.name}`}
            loading={busy === 'stop'}
            disabled={!!busy}
            icon={<Square aria-hidden className={icon} />}
            onClick={() => actions.act('stop')}
          >
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Start ${c.name}`}
            loading={busy === 'start'}
            disabled={!!busy}
            icon={<Play aria-hidden className={icon} />}
            onClick={() => actions.act('start')}
          >
            Start
          </Button>
        )}
      </div>
    </ListRow>
  )
}
