import { useSyncExternalStore, type ComponentType } from 'react'
import type { ReleaseDetail, ReleaseOptions } from '../../../shared/deploy'
import { api } from '../lib/api'
import { createStore } from '../ui/store'

/**
 * Mount points the release wizard and failure panel render, filled by ai/register. Each renders nothing until registered.
 * The wizard renders `ReleaseNotesSlot` in *Choose* (`release: null`) and in *Confirm* (the preflighted release, on
 * its playbook review), awaits `flushReleaseNotes(id)` before `release:start`, and enables the notify/QA toggles
 * from `releaseOptionsAvailable()`, seeding QA from `releaseOptionDefaults(environmentId)`.
 */
export interface ReleaseNotesSlotProps {
  environmentId: string
  /** Null before preflight; the preflighted release in *Confirm*. */
  release: ReleaseDetail | null
  productName?: string | null
}

const notesEditor = createStore<ComponentType<ReleaseNotesSlotProps> | null>(null)

/** Returns its unregister. */
export function registerReleaseNotesEditor(component: ComponentType<ReleaseNotesSlotProps>): () => void {
  notesEditor.set(component)
  return () => {
    if (notesEditor.get() === component) notesEditor.set(null)
  }
}

export function ReleaseNotesSlot(props: ReleaseNotesSlotProps) {
  const Editor = useSyncExternalStore(notesEditor.subscribe, notesEditor.get)
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

/** The disabled toggles' tooltip: nothing registered them, so the release has no notify or QA step to run. */
export const RELEASE_OPTIONS_UNAVAILABLE = "Notifications and QA aren't part of this build"

/**
 * Enables the wizard's option toggles; until then they are disabled with `RELEASE_OPTIONS_UNAVAILABLE`. A wizard
 * reads them when it opens. Returns the undo, which puts back the toggles from before.
 */
export function registerReleaseOptions(enabled: Partial<ReleaseOptionToggles>): () => void {
  const before = toggles
  toggles = { ...toggles, ...enabled }
  return () => {
    toggles = before
  }
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
  error: string
  /** The step's last log lines, already redacted by main. */
  lines: string[]
}

const failureAction = createStore<ComponentType<FailureActionProps> | null>(null)

/** Fills the failure panel's action slot (ai/register puts `Explain` there); returns its unregister. */
export function registerFailureAction(component: ComponentType<FailureActionProps>): () => void {
  failureAction.set(component)
  return () => {
    if (failureAction.get() === component) failureAction.set(null)
  }
}

/** Rendered by the release failure panel for its failed step; nothing until registered. */
export function FailureActionSlot(props: FailureActionProps) {
  const Action = useSyncExternalStore(failureAction.subscribe, failureAction.get)
  return Action ? <Action {...props} /> : null
}
