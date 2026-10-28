import { useEffect, useId, useRef, useState } from 'react'
import { LOCK_FREE_EDIT_MESSAGE, validateParamValues, type Runbook } from '../../../../shared/runbooks'
import type { AppServiceMeta } from '../../../../shared/services'
import type { PlaybookPreview } from '../../../../shared/deploy'
import { closeRelease } from '../../deploy/releases'
import { useServices } from '../../deploy/store'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { attempt, ConfirmDialog, errorText, type ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextField } from '../../ui/Field'
import { PLAYBOOK_CHANGED_MESSAGE } from '../../../../shared/deploy'
import { PlaybookReview } from '../deployments/release/PlaybookReview'
import { ReleaseView } from '../deployments/release/ReleaseView'

type Step = 'form' | 'review' | 'started'

/** Params and services, then the playbook it will run, then the live run. The start carries the reviewed playbook's hash. */
export function RunRunbookDialog({ runbook, onClose }: { runbook: Runbook; onClose: () => void }) {
  const formId = useId()
  const env = useInventory()?.environments.find((e) => e.id === runbook.environmentId)
  const apps = useServices(runbook.environmentId).filter((s): s is AppServiceMeta => s.kind === 'service')
  const targets = apps.filter((s) => runbook.targetServiceIds.includes(s.id))
  const [step, setStep] = useState<Step>('form')
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(runbook.params.map((p) => [p.name, p.type === 'choice' ? (p.choices[0] ?? '') : ''])))
  const [picked, setPicked] = useState<Set<string>>(() => new Set(runbook.targetServiceIds))
  const [releaseId, setReleaseId] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<PlaybookPreview | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // The ready release row is dropped when the dialog goes back or closes without starting it.
  const held = useRef<string | null>(null)

  const drop = () => {
    const id = held.current
    held.current = null
    if (!id) return
    closeRelease(id)
    void api.invoke('release:discard', id).catch(() => {})
  }
  // Gone without starting (the parent unmounts it): the ready release goes too.
  useEffect(() => drop, [])
  const close = () => {
    if (busy) return
    if (step !== 'started') drop()
    onClose()
  }

  const review = async () => {
    setError(null)
    let params: Record<string, string>
    try {
      params = validateParamValues(runbook.params, values)
    } catch (err) {
      setError(errorText(err))
      return
    }
    const serviceIds = targets.filter((s) => picked.has(s.id)).map((s) => s.id)
    if (!serviceIds.length) {
      setError('Pick at least one service')
      return
    }
    setBusy(true)
    drop()
    const pre = await attempt("Couldn't prepare the run", () => api.invoke('release:preflightOperation', { environmentId: runbook.environmentId, runbookId: runbook.id, serviceIds, params }), setError)
    if (!pre) return setBusy(false)
    held.current = pre.releaseId
    setReleaseId(pre.releaseId)
    const out = await attempt("Couldn't generate the playbook", () => api.invoke('deploy:previewPlaybook', pre.releaseId), setError)
    setBusy(false)
    if (!out) return
    setReviewed(out)
    setSaved(null)
    setStep('review')
  }

  // `edit`: the person's edited text with the hash main gave it, run in place of the generated playbook.
  const start = async (typedName?: string, edit?: { text: string; sha256: string }) => {
    if (!releaseId || !reviewed) return
    setBusy(true)
    setError(null)
    const id = releaseId
    let changed = false
    const ok = await attempt(
      "Couldn't start the run",
      // release:start answers nothing, so success is marked here: undefined is attempt's failure.
      async () => (await api.invoke('release:start', id, { ...(typedName !== undefined ? { typedName } : {}), playbookSha256: edit?.sha256 ?? reviewed.sha256, ...(edit ? { editedPlaybook: edit.text } : {}) }), true),
      (message) => {
        changed = message.includes(PLAYBOOK_CHANGED_MESSAGE)
        setError(message)
      },
    )
    if (ok === undefined) {
      // Show what would run now, so the next Run is bound to the playbook the person has seen.
      if (changed) {
        setReviewed(null)
        const out = await attempt("Couldn't generate the playbook", () => api.invoke('deploy:previewPlaybook', id), setError)
        if (out) setReviewed(out)
      }
      setBusy(false)
      return
    }
    setBusy(false)
    held.current = null
    setStep('started')
  }

  const run = (edit?: { text: string; sha256: string }) => {
    // An environment this window can't look up is treated as protected: the typed name is the safe default.
    if (env && !env.protected) return void start(undefined, edit)
    const name = env?.name ?? runbook.environmentId
    setConfirm({
      title: `Run ${runbook.name} in ${name}?`,
      description: env ? `${name} is protected.` : `${name} could not be checked, so it is treated as protected.`,
      confirmLabel: 'Run',
      typeToConfirm: name,
      run: () => start(name, edit),
    })
  }

  const save = async () => {
    if (!releaseId || !reviewed) return
    const out = await attempt("Couldn't save the playbook", () => api.invoke('deploy:savePlaybook', releaseId, reviewed.sha256))
    if (out) setSaved(out.path)
  }

  // Main no longer holds the preview an edit is checked against: ask for a new one.
  const previewAgain = async () => {
    if (!releaseId) return
    setError(null)
    setReviewed(null)
    const out = await attempt("Couldn't generate the playbook", () => api.invoke('deploy:previewPlaybook', releaseId), setError)
    if (out) setReviewed(out)
  }

  const back = () => {
    if (busy) return
    drop()
    setReleaseId(null)
    setReviewed(null)
    setError(null)
    setStep('form')
  }

  const footer =
    step === 'form' ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button form={formId} type="submit" loading={busy}>
          Review
        </Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button variant="ghost" onClick={back} disabled={busy}>
          Back
        </Button>
        <Button onClick={() => run()} disabled={!reviewed || editing} loading={busy}>
          Run
        </Button>
      </>
    ) : (
      <Button variant="ghost" onClick={close}>
        Close
      </Button>
    )

  return (
    <Dialog open onClose={close} width={760} title={`Run ${runbook.name}`} description={runbook.description || undefined} footer={footer}>
      <div className="flex flex-col gap-3">
        {step === 'form' && (
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void review()
            }}
          >
            {runbook.params.map((p) =>
              p.type === 'choice' ? (
                <SelectField key={p.name} label={p.label} value={values[p.name]} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                  {p.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <TextField key={p.name} label={p.label} value={values[p.name]} spellCheck={false} autoComplete="off" onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
              ),
            )}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12.5px] font-medium text-fg/90">Services</legend>
              {targets.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-[12.5px] text-fg/90">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={(e) =>
                      setPicked((p) => {
                        const next = new Set(p)
                        if (e.target.checked) next.add(s.id)
                        else next.delete(s.id)
                        return next
                      })
                    }
                    className="size-3.5 rounded accent-(--accent)"
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          </form>
        )}
        {step === 'review' && (
          <>
            <PlaybookReview
              playbook={reviewed?.playbook ?? null}
              inventory={reviewed?.inventory}
              autoRollback={false}
              onSave={() => void save()}
              editable={runbook.lock}
              editNote={runbook.lock ? undefined : LOCK_FREE_EDIT_MESSAGE}
              releaseId={releaseId ?? undefined}
              onRunEdited={(text, sha256) => run({ text, sha256 })}
              onEditingChange={setEditing}
              busy={busy}
              onPreviewAgain={() => void previewAgain()}
            />
            {saved && <p className="text-[12px] text-muted">Saved to {saved}</p>}
          </>
        )}
        {step === 'started' && releaseId && <ReleaseView releaseId={releaseId} />}
        {error && (
          <p role="alert" className="text-[12.5px] text-err">
            {error}
          </p>
        )}
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Dialog>
  )
}
