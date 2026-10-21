import { registerFailureAction, registerReleaseNotesEditor, registerReleaseOptions } from '../deploy/slots'
import { FailureExplain } from './FailureExplain'
import { ReleaseNotesSlotEditor } from './ReleaseNotesSlotEditor'

// Imported once from App.tsx: fills the release wizard's and failure panel's Phase 9 mount points.
registerReleaseNotesEditor(ReleaseNotesSlotEditor)
registerReleaseOptions({ notify: true, qa: true })
registerFailureAction(FailureExplain)
