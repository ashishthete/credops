import { registerReleaseNotesEditor, registerReleaseOptions } from '../deploy/slots'
import { ReleaseNotesSlotEditor } from './ReleaseNotesSlotEditor'

// Imported once from App.tsx: fills the release wizard's Phase 9 mount points.
registerReleaseNotesEditor(ReleaseNotesSlotEditor)
registerReleaseOptions({ notify: true, qa: true })
