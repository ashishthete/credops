import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_WHEN_PATHS, type Step, type StepSecret, type StepWhen } from '../../../../shared/steps'
import { Button } from '../../ui/Button'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'

export interface StepEditorProps {
  step: Step
  onChange: (next: Step) => void
  secrets: { id: string; name: string }[]
  serviceNames: string[]
  /** The rule this step breaks, from validateStep. */
  error?: string
}

const SECRET_LIMIT = 10

/** The fields of one step. Secrets are picked by id from the vault; a value is never shown. */
export function StepEditor({ step, onChange, secrets, serviceNames, error }: StepEditorProps) {
  const [pathsText, setPathsText] = useState(step.when.kind === 'paths' ? step.when.paths.join('\n') : '')
  const [timeout, setTimeoutText] = useState(String(step.timeoutSec))
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch })
  const setWhen = (when: StepWhen) => set({ when })
  const setSecret = (i: number, change: Partial<StepSecret>) => set({ secrets: step.secrets.map((s, j) => (j === i ? { ...s, ...change } : s)) })
  const locked = step.anchor === 'after_tag'

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line/60 bg-canvas/40 p-3">
      <TextField label="Step name" value={step.name} onChange={(e) => set({ name: e.target.value })} className="font-mono" spellCheck={false} />
      <TextAreaField
        label="Script"
        value={step.script}
        onChange={(e) => set({ script: e.target.value })}
        rows={4}
        className="font-mono text-[12.5px]"
        spellCheck={false}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Run"
          value={step.run}
          onChange={(e) => {
            const run = e.target.value as Step['run']
            set({ run, service: run === 'compose-exec' ? (step.service ?? serviceNames[0] ?? null) : null })
          }}
        >
          <option value="shell">On the host</option>
          <option value="compose-exec">In a compose service</option>
        </SelectField>
        {step.run === 'compose-exec' && (
          <SelectField label="Compose service" value={step.service ?? ''} onChange={(e) => set({ service: e.target.value || null })}>
            <option value="">Choose a service…</option>
            {serviceNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Sudo" value={step.sudo} onChange={(e) => set({ sudo: e.target.value as Step['sudo'] })}>
          <option value="docker">Like docker</option>
          <option value="yes">Always</option>
          <option value="no">Never</option>
        </SelectField>
        <TextField
          label="Timeout (seconds)"
          inputMode="numeric"
          value={timeout}
          onChange={(e) => {
            setTimeoutText(e.target.value)
            set({ timeoutSec: /^\d+$/.test(e.target.value.trim()) ? Number(e.target.value.trim()) : Number.NaN })
          }}
        />
        <SelectField
          label="On failure"
          value={locked ? 'continue' : step.onFailure}
          disabled={locked}
          hint={locked ? 'The tag is the last thing a release does: a failing step there cannot undo it.' : undefined}
          onChange={(e) => set({ onFailure: e.target.value as Step['onFailure'] })}
        >
          <option value="stop">Stop the release</option>
          <option value="continue">Continue</option>
        </SelectField>
        <SelectField
          label="Run when"
          value={step.when.kind}
          onChange={(e) => {
            const kind = e.target.value as StepWhen['kind']
            setWhen(kind === 'paths' ? { kind, paths: pathsText.split('\n').map((p) => p.trim()).filter(Boolean) } : { kind })
          }}
        >
          <option value="always">Always</option>
          <option value="changed">The checkout changed</option>
          <option value="paths">These paths changed</option>
        </SelectField>
      </div>
      {step.when.kind === 'paths' && (
        <TextAreaField
          label={`Paths (one per line, up to ${MAX_WHEN_PATHS})`}
          value={pathsText}
          rows={3}
          className="font-mono text-[12.5px]"
          spellCheck={false}
          placeholder="package.json"
          onChange={(e) => {
            setPathsText(e.target.value)
            setWhen({ kind: 'paths', paths: e.target.value.split('\n').map((p) => p.trim()).filter(Boolean) })
          }}
        />
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[12.5px] font-medium text-fg/90">Secrets</legend>
        <ul aria-label="Step secrets" className="flex flex-col gap-2">
          {step.secrets.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={`Secret ${i + 1} env name`}
                  value={s.envName}
                  onChange={(e) => setSecret(i, { envName: e.target.value })}
                  className="font-mono"
                  spellCheck={false}
                  placeholder="API_TOKEN"
                />
              </div>
              <div className="min-w-0 flex-1">
                <SelectField label={`Secret ${i + 1}`} value={s.secretId} onChange={(e) => setSecret(i, { secretId: e.target.value })}>
                  <option value="">Choose a secret…</option>
                  {s.secretId && !secrets.some((x) => x.id === s.secretId) && <option value={s.secretId}>Unavailable secret</option>}
                  {secrets.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              <button
                type="button"
                aria-label={`Remove secret ${i + 1}`}
                onClick={() => set({ secrets: step.secrets.filter((_, j) => j !== i) })}
                className="mt-[26px] grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/6 hover:text-fg"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<Plus aria-hidden className="size-3.5" />}
            disabled={step.secrets.length >= SECRET_LIMIT}
            onClick={() => set({ secrets: [...step.secrets, { envName: '', secretId: '' }] })}
          >
            Add secret
          </Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-[12.5px] text-err">
          {error}
        </p>
      )}
    </div>
  )
}
