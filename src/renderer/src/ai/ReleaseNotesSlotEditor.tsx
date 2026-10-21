import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReleaseDetail } from '../../../shared/deploy'
import { registerNotesFlush, type ReleaseNotesSlotProps } from '../deploy/slots'
import { api } from '../lib/api'
import { fail } from '../ui/common'
import { ReleaseNotesEditor } from './ReleaseNotesEditor'

export const SAVE_DEBOUNCE_MS = 400

/** Fills the wizard's notes slot: a hint before preflight, the editor on the preflighted release. */
export function ReleaseNotesSlotEditor({ environmentId, release, productName = null }: ReleaseNotesSlotProps) {
  if (!release) return <p className="text-[12.5px] text-muted">Notes are drafted from the commits after preflight</p>
  return <ConfirmNotes key={release.id} environmentId={environmentId} release={release} productName={productName} />
}

function ConfirmNotes({ environmentId, release, productName }: { environmentId: string; release: ReleaseDetail; productName: string | null }) {
  const [value, setValue] = useState(release.releaseNotes ?? '')
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const id = release.id

  const save = useCallback((): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const notes = pending.current
    if (notes !== null) {
      pending.current = null
      chain.current = chain.current
        .then(() => api.invoke('release:set-notes', id, notes))
        .catch((e: unknown) => fail('Could not save the release notes', e))
    }
    return chain.current
  }, [id])

  useEffect(() => registerNotesFlush(id, save), [id, save])
  // Leaving Confirm sends the last edit rather than dropping it.
  useEffect(() => () => void save(), [save])

  const onChange = (next: string): void => {
    setValue(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS)
  }

  const commits = useMemo(() => (release.redeploy ? [] : Object.values(release.preflight?.commits ?? {}).flatMap((c) => c.commits)), [release])
  const deployments = useMemo(() => release.runs.flatMap((r) => (r.deploymentId ? [{ id: r.deploymentId, name: r.deploymentName }] : [])), [release])

  return <ReleaseNotesEditor commits={commits} value={value} onChange={onChange} context={{ environmentId, productName, deployments, version: release.version }} />
}
