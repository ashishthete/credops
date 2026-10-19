import { useEffect } from 'react'
import type { FailureActionProps } from '../deploy/slots'
import { ExplainButton } from './ExplainPanel'
import { noteFailure } from './explain-store'

/** The failure panel's Explain; a shown release failure also becomes the palette's last failure. */
export function FailureExplain({ releaseId, stepId }: FailureActionProps) {
  useEffect(() => noteFailure({ kind: 'release', releaseId, stepId }), [releaseId, stepId])
  return <ExplainButton subject={{ kind: 'release', releaseId, stepId }} />
}
