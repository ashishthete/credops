import { useMemo } from 'react'
import { playbookSteps } from '../../../../../shared/playbook-steps'
import { Button } from '../../../ui/Button'

/** The playbook a release will run: its steps per deployment on the left, the full text on the right. */
export function PlaybookReview({ playbook, autoRollback, onSave }: { playbook: string | null; autoRollback: boolean; onSave: () => void }) {
  const plays = useMemo(() => (playbook === null ? [] : playbookSteps(playbook)), [playbook])
  if (playbook === null) return <p className="text-[12px] text-muted">Generating the playbook</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-[12.5px] text-fg/90">This is exactly what will run. Deploy runs it unchanged.</p>
        <Button size="sm" variant="ghost" onClick={onSave}>
          Save as .yml…
        </Button>
      </div>
      <div className="flex min-h-0 gap-3">
        <ol aria-label="Playbook steps" className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto text-[12px]">
          {plays.map((play, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              {plays.length > 1 && <span className="text-[11px] tracking-wide text-muted uppercase">Host {i + 1}</span>}
              {play.deployments.map((d) => (
                <div key={d.runId ?? d.name} className="flex flex-col gap-0.5">
                  <span className="font-medium text-fg">{d.name}</span>
                  <ul className="flex flex-col gap-0.5 pl-2 text-fg/85">
                    {d.steps.map((s, j) => (
                      <li key={`${s.kind}:${j}`}>{s.label}</li>
                    ))}
                    {d.rollback && <li className="text-muted">{autoRollback ? 'Roll back if a step fails' : 'Stop if a step fails'}</li>}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ol>
        <pre className="max-h-[50vh] min-w-0 flex-1 overflow-auto rounded-lg bg-canvas/70 p-3 font-mono text-[11.5px] whitespace-pre text-fg/90">{playbook}</pre>
      </div>
    </div>
  )
}
