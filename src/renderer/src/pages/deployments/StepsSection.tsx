import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { MAX_STEPS_PER_CHECKOUT, STEP_ANCHORS, stepLabel, type Step, type StepAnchor } from '../../../../shared/steps'
import { stepErrors } from '../../deploy/form'
import { Button } from '../../ui/Button'
import { StepEditor } from './StepEditor'

export const ANCHOR_LABEL: Record<StepAnchor, string> = {
  before_fetch: 'before fetch',
  after_checkout: 'after checkout',
  before_build: 'before build',
  after_build: 'after build',
  after_up: 'after up',
  after_health: 'after health check',
  after_tag: 'after tag',
}

export interface StepsSectionProps {
  steps: Step[]
  onChange: (steps: Step[]) => void
  secrets: { id: string; name: string }[]
  serviceNames: string[]
}

/** A fresh id and name that no step uses yet. */
function newStep(steps: Step[], anchor: StepAnchor): Step {
  let n = steps.length + 1
  while (steps.some((s) => s.id === `step-${n}` || s.name === `step-${n}`)) n++
  return {
    id: `step-${n}`,
    name: `step-${n}`,
    run: 'shell',
    service: null,
    script: '',
    cwd: null,
    sudo: 'docker',
    timeoutSec: 600,
    // A failing step after the tag cannot undo it.
    onFailure: anchor === 'after_tag' ? 'continue' : 'stop',
    when: { kind: 'always' },
    secrets: [],
    anchor,
    alsoOnRollback: false,
  }
}

/** The checkout's steps as a timeline of the built-in anchors. Order inside an anchor is run order. */
export function StepsSection({ steps, onChange, secrets, serviceNames }: StepsSectionProps) {
  const [open, setOpen] = useState<string | null>(null)
  const errors = stepErrors(
    steps,
    secrets.map((s) => s.id),
    serviceNames,
  )

  const replace = (id: string, next: Step) => onChange(steps.map((s) => (s.id === id ? next : s)))
  const move = (id: string, dir: -1 | 1) => {
    const i = steps.findIndex((s) => s.id === id)
    let j = i + dir
    while (j >= 0 && j < steps.length && steps[j].anchor !== steps[i].anchor) j += dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const add = (anchor: StepAnchor) => {
    const step = newStep(steps, anchor)
    // Added after the last step of its anchor, so it runs last there.
    const last = steps.map((s) => s.anchor).lastIndexOf(anchor)
    const at = last === -1 ? steps.length : last + 1
    onChange([...steps.slice(0, at), step, ...steps.slice(at)])
    setOpen(step.id)
  }

  return (
    <div className="flex flex-col gap-3">
      {STEP_ANCHORS.map((anchor) => {
        const here = steps.filter((s) => s.anchor === anchor)
        return (
          <div key={anchor} role="group" aria-label={ANCHOR_LABEL[anchor]} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[12.5px] font-medium text-fg/90">{ANCHOR_LABEL[anchor]}</h4>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Plus aria-hidden className="size-3.5" />}
                disabled={steps.length >= MAX_STEPS_PER_CHECKOUT}
                aria-label={`Add step ${ANCHOR_LABEL[anchor]}`}
                onClick={() => add(anchor)}
              >
                Add step
              </Button>
            </div>
            {here.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {here.map((s, k) => {
                  const expanded = open === s.id
                  const error = errors[steps.indexOf(s)]
                  return (
                    <li key={s.id} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : s.id)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-left text-[13px] text-fg hover:border-muted/30"
                        >
                          <ChevronRight aria-hidden className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                          <span className="truncate font-mono">{stepLabel(s) || 'unnamed'}</span>
                          {error && <span className="ml-auto shrink-0 text-[11.5px] text-err">needs attention</span>}
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${s.name} up`}
                          disabled={k === 0}
                          onClick={() => move(s.id, -1)}
                          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-fg disabled:opacity-40"
                        >
                          <ArrowUp aria-hidden className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${s.name} down`}
                          disabled={k === here.length - 1}
                          onClick={() => move(s.id, 1)}
                          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-fg disabled:opacity-40"
                        >
                          <ArrowDown aria-hidden className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${s.name}`}
                          onClick={() => onChange(steps.filter((x) => x.id !== s.id))}
                          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-fg"
                        >
                          <Trash2 aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      {expanded && <StepEditor step={s} onChange={(next) => replace(s.id, next)} secrets={secrets} serviceNames={serviceNames} error={error} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
