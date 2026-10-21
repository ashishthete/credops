import { motion } from 'framer-motion'
import { Fragment } from 'react'
import { runLabel, type ChipState, type PipelineState } from '../../../deploy/pipeline'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'
import { StepChip } from './StepChip'

const FINISHED = new Set<ChipState['state']>(['ok', 'warn', 'skipped'])

export { runLabel }

/** The bar between two chips; it fills once the chip on its left has finished. */
function Connector({ filled }: { filled: boolean }) {
  const motionSafe = useMotionSafe()
  return (
    <span aria-hidden data-connector={filled ? 'filled' : 'empty'} className="relative h-0.5 w-3 shrink-0 overflow-hidden rounded-full bg-line">
      {filled &&
        (motionSafe ? (
          <motion.span className="absolute inset-0 origin-left bg-ok/70" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={spring} />
        ) : (
          <span className="absolute inset-0 bg-ok/70" />
        ))}
    </span>
  )
}

/** Chips in order with connectors between them. */
function Chain({
  chips,
  host,
  cancelling,
  selected,
  onSelect,
}: {
  chips: (ChipState | null)[]
  host: string | null
  cancelling: boolean
  selected: string | null
  onSelect: (stepId: string | null) => void
}) {
  const list = chips.filter((c): c is ChipState => c !== null)
  return (
    <span className="flex flex-wrap items-center gap-y-1">
      {list.map((c, i) => (
        <Fragment key={c.stepId}>
          {i > 0 && <Connector filled={FINISHED.has(list[i - 1].state)} />}
          <StepChip
            chip={c}
            host={host}
            cancelling={cancelling}
            selected={selected === c.stepId}
            onSelect={(id) => onSelect(selected === id ? null : id)}
          />
        </Fragment>
      ))}
    </span>
  )
}

/** One lane per host (lock, the runs, unlock), then the release-wide steps. Clicking a chip selects its step. */
export function Pipeline({
  state,
  selected,
  onSelect,
  cancelling = false,
}: {
  state: PipelineState
  selected: string | null
  onSelect: (stepId: string | null) => void
  cancelling?: boolean
}) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex flex-col gap-2" aria-label="Pipeline" role="group">
      {state.lanes.map((lane, i) => (
        <motion.section
          key={lane.hostId}
          data-lane={lane.hostId}
          aria-label={lane.hostLabel}
          className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface/60 px-3 py-2"
          {...(motionSafe ? { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { ...fast, delay: staggerDelay(i) } } : {})}
        >
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-fg">{lane.hostLabel}</span>
            <Chain chips={[lane.lock]} host={lane.hostLabel} cancelling={cancelling} selected={selected} onSelect={onSelect} />
          </div>
          {lane.runs.map((run) => (
            <div key={run.runId} data-run={run.runId} className="flex flex-wrap items-center gap-2 pl-2">
              <span className="min-w-36 text-[12px] text-fg/90">{runLabel(run)}</span>
              <Chain chips={run.chips} host={lane.hostLabel} cancelling={cancelling} selected={selected} onSelect={onSelect} />
            </div>
          ))}
          {lane.unlock && (
            <div className="flex items-center pl-2">
              <Chain chips={[lane.unlock]} host={lane.hostLabel} cancelling={cancelling} selected={selected} onSelect={onSelect} />
            </div>
          )}
        </motion.section>
      ))}
      {state.release.length > 0 && (
        <section data-lane="release" aria-label="Release" className="flex items-center gap-2 px-3">
          <span className="text-[12.5px] font-semibold text-fg">Release</span>
          <Chain chips={state.release} host={null} cancelling={cancelling} selected={selected} onSelect={onSelect} />
        </section>
      )}
    </div>
  )
}
