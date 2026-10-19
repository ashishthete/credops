import type { ComponentType } from 'react'
import type { ReleaseDetail, ReleaseOptions } from '../../../shared/deploy'
import { api } from '../lib/api'

/**
 * Mount points the release wizard renders and Phase 9 fills. Each renders nothing until registered.
 * The wizard renders `ReleaseNotesSlot` in *Choose* (`release: null`) and in *Confirm* (the preflighted
 * release), awaits `flushReleaseNotes(id)` before `release:start`, and enables the notify/QA toggles
 * from `releaseOptionsAvailable()`, seeding QA from `releaseOptionDefaults(environmentId)`.
 */
export interface ReleaseNotesSlotProps {
  environmentId: string
  /** Null before preflight; the preflighted release in *Confirm*. */
  release: ReleaseDetail | null
  productName?: string | null
}

let notesEditor: ComponentType<ReleaseNotesSlotProps> | null = null

export function registerReleaseNotesEditor(component: ComponentType<ReleaseNotesSlotProps>): void {
  notesEditor = component
}

export function ReleaseNotesSlot(props: ReleaseNotesSlotProps) {
  const Editor = notesEditor
  return Editor ? <Editor {...props} /> : null
}

const flushers = new Map<string, () => Promise<void>>()

/** Registers the save the wizard flushes before Start; returns its unregister. */
export function registerNotesFlush(releaseId: string, flush: () => Promise<void>): () => void {
  flushers.set(releaseId, flush)
  return () => {
    if (flushers.get(releaseId) === flush) flushers.delete(releaseId)
  }
}

/** Sends any notes edit still waiting on its debounce, and waits for saves in flight. */
export async function flushReleaseNotes(releaseId: string): Promise<void> {
  await flushers.get(releaseId)?.()
}

export type ReleaseOptionToggles = { notify: boolean; qa: boolean }
let toggles: ReleaseOptionToggles = { notify: false, qa: false }

/** Enables the wizard's option toggles; until then they read `Available with notifications (Phase 9)`. */
export function registerReleaseOptions(enabled: Partial<ReleaseOptionToggles>): void {
  toggles = { ...toggles, ...enabled }
}

export function releaseOptionsAvailable(): ReleaseOptionToggles {
  return { ...toggles }
}

/** Option defaults for a new release: QA follows the environment's `qaOnDeploy` (and needs a workflow). */
export async function releaseOptionDefaults(environmentId: string): Promise<Partial<Pick<ReleaseOptions, 'qa'>>> {
  if (!toggles.qa) return {}
  try {
    const i = await api.invoke('integration:get', environmentId)
    return i ? { qa: i.qaOnDeploy && i.qa !== null } : {}
  } catch {
    return {}
  }
}

/** Props of the action the release failure panel shows beside a failed step. */
export interface FailureActionProps {
  releaseId: string
  stepId: string
}

let failureAction: ComponentType<FailureActionProps> | null = null

/** Fills the failure panel's action slot (Phase 9 registers `Explain`). */
export function registerFailureAction(component: ComponentType<FailureActionProps>): void {
  failureAction = component
}

/** Rendered by the release failure panel for its failed step; nothing until registered. */
export function FailureActionSlot(props: FailureActionProps) {
  const Action = failureAction
  return Action ? <Action {...props} /> : null
}
