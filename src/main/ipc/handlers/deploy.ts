import {
  MAX_EVENTS_PAGE,
  PLAYBOOK_CHANGED_MESSAGE,
  PLAYBOOK_NOT_STORED_MESSAGE,
  type DeploymentMeta,
  type EnvDeploySettings,
  type EnvLastRelease,
  type PlaybookPreview,
  type ReleaseDetail,
  type Tooling,
} from '../../../shared/deploy'
import type { Handlers } from '../../../shared/ipc'
import { DeployError } from '../../deploy/access'
import { redact } from '../../security/redact'
import type { DeployStore } from '../../deploy/deploy-store'
import type { ReleaseApi } from '../../hub/runner'
import type { HubCatalog } from '../../hub/catalog'

export const REVIEW_REQUIRED_MESSAGE = 'Review the playbook before you deploy.'

type DeployChannel =
  | 'deploy:list'
  | 'deploy:create'
  | 'deploy:update'
  | 'deploy:delete'
  | 'deploy:reorder'
  | 'deploy:settings'
  | 'deploy:updateSettings'
  | 'deploy:applyBatch'
  | 'deploy:tooling'
  | 'deploy:previewPlaybook'
  | 'deploy:savePlaybook'
  | 'release:savePlaybook'
  | 'release:preflight'
  | 'release:start'
  | 'release:cancel'
  | 'release:rollback'
  | 'release:break-lock'
  | 'release:discard'
  | 'release:set-notes'
  | 'release:retry-version'
  | 'release:list'
  | 'release:get'
  | 'release:events'
  | 'release:active'
  | 'release:latest'

export function createDeployHandlers(deps: {
  deploys: DeployStore
  releases: ReleaseApi
  tooling: () => Promise<Tooling>
  /** The signed-in person's Hub catalog: where the wizard reads a Hub environment this desktop has no local copy of. */
  catalog?: Pick<HubCatalog, 'get' | 'list'>
  /** An environment this desktop published: its settings are edited here (and pushed again), not read from the Hub. */
  published?: (environmentId: string) => boolean
  /** "Save as .yml…": a save dialog shown by main (undefined when cancelled), and the write of the reviewed text. */
  playbookFile?: { saveDialog: (releaseId: string) => Promise<string | undefined>; write: (path: string, text: string) => Promise<void> }
  /** Each local environment's newest release that ran (`release:latest`). */
  lastReleases?: () => EnvLastRelease[]
  /** The vault's and Hub's secret values, masked out of a stored playbook before it is written to a file. */
  knownSecrets?: () => readonly string[]
}): Pick<Handlers, DeployChannel> {
  const { deploys, releases, tooling, catalog, published, playbookFile, lastReleases, knownSecrets } = deps
  /** A stored text with every known secret value (and key block) masked, in main, before it leaves over IPC or to a file. */
  const mask = (text: string): string => redact(text, knownSecrets?.() ?? [])
  /**
   * A release as `release:get` returns it, local or Hub: its playbook, error and check messages masked again,
   * since a Hub release's text reaches this desktop unredacted by it.
   */
  const maskedDetail = async (id: string): Promise<ReleaseDetail> => {
    const d = await releases.detail(id)
    return {
      ...d,
      playbook: d.playbook === null ? null : mask(d.playbook),
      error: d.error === null ? null : mask(d.error),
      preflight: d.preflight && { ...d.preflight, checks: d.preflight.checks.map((c) => ({ ...c, message: mask(c.message) })) },
    }
  }
  // The last playbook reviewed per release. Saving writes this text, so the renderer sends only its hash, never a path or text.
  const reviewed = new Map<string, PlaybookPreview>()
  return {
    'deploy:list': (environmentId) => {
      const local = deploys.list(environmentId)
      if (!catalog) return local
      const known = new Set(local.map((d) => d.id))
      const envs = environmentId === undefined ? catalog.list() : [catalog.get(environmentId)].flatMap((e) => (e ? [e] : []))
      const extra = envs.flatMap((e) => e.deployments.filter((d) => !known.has(d.id)).map(catalogDeployment))
      return extra.length ? [...local, ...extra] : local
    },
    'deploy:create': (input) => deploys.create(input),
    'deploy:update': (id, patch) => deploys.update(id, patch),
    'deploy:delete': (id) => deploys.delete(id),
    'deploy:reorder': (environmentId, ids) => deploys.reorder(environmentId, ids),
    'deploy:settings': (environmentId) => {
      // The Hub is the authority for a Hub environment's settings, unless this desktop published it: edits go to the local row.
      const hub = published?.(environmentId) ? undefined : catalog?.get(environmentId)?.environment
      if (hub) return catalogSettings(environmentId, hub)
      return deploys.settings(environmentId)
    },
    'deploy:updateSettings': (environmentId, patch) => deploys.updateSettings(environmentId, patch),
    'deploy:applyBatch': (environmentId, batch) => deploys.applyBatch(environmentId, batch),
    'deploy:tooling': () => tooling(),
    'release:preflight': (request) => releases.preflight(request),
    'deploy:previewPlaybook': async (id) => {
      const preview = await releases.previewPlaybook(id)
      reviewed.set(id, preview)
      return preview
    },
    'deploy:savePlaybook': async (id, sha256) => {
      const preview = reviewed.get(id)
      if (!preview || preview.sha256 !== sha256) throw new DeployError('INVALID_STATE', PLAYBOOK_CHANGED_MESSAGE)
      if (!playbookFile) throw new DeployError('INVALID_STATE', 'Saving a playbook is not available here')
      const path = await playbookFile.saveDialog(id)
      if (path === undefined) return null
      await playbookFile.write(path, preview.playbook)
      return { path }
    },
    // The text the release stored, read and masked exactly as `release:get` returns it (the same access check).
    'release:savePlaybook': async (id) => {
      const { playbook } = await maskedDetail(id)
      if (!playbook) throw new DeployError('INVALID_STATE', PLAYBOOK_NOT_STORED_MESSAGE)
      if (!playbookFile) throw new DeployError('INVALID_STATE', 'Saving a playbook is not available here')
      const path = await playbookFile.saveDialog(id)
      if (path === undefined) return null
      await playbookFile.write(path, playbook)
      return { path }
    },
    // Every start from the UI is bound to the playbook the person reviewed: without its hash it is refused here.
    // The service checks the hash against a fresh generation. Retry-tagging (`release:retry-version`) and
    // rollback (`release:rollback`) generate their own playbook from a finished release and are exempt.
    'release:start': async (id, confirm) => {
      if (confirm?.playbookSha256 === undefined) throw new DeployError('CONFIRM_REQUIRED', REVIEW_REQUIRED_MESSAGE)
      await releases.start(id, confirm)
      // Only once started: a start refused for another reason (busy, capacity) leaves the review on screen valid.
      reviewed.delete(id)
    },
    'release:cancel': (id) => releases.cancel(id),
    'release:rollback': (id, confirm) => releases.rollback(id, confirm),
    'release:break-lock': (id, hostId, confirm) => releases.breakLock(id, hostId, confirm),
    'release:discard': (id) => releases.discard(id),
    'release:set-notes': (id, notes) => releases.setNotes(id, notes),
    'release:retry-version': (id) => releases.retryVersion(id),
    'release:list': (filter) => releases.list(filter),
    'release:get': (id) => maskedDetail(id),
    // The validator caps `limit`; the clamp keeps a direct caller honest too.
    'release:events': (id, afterSeq, limit) => releases.events(id, afterSeq, Math.min(limit ?? 1000, MAX_EVENTS_PAGE)),
    'release:active': () => releases.listActive(),
    'release:latest': () => lastReleases?.() ?? [],
  }
}

function catalogDeployment(d: Omit<DeploymentMeta, 'vaultIds' | 'createdAt' | 'updatedAt'>): DeploymentMeta {
  return { ...d, vaultIds: [], createdAt: '', updatedAt: '' }
}

function catalogSettings(
  environmentId: string,
  env: { versioned: boolean; autoRollback: boolean; currentVersion: string | null },
): EnvDeploySettings {
  return { environmentId, versioned: env.versioned, autoRollback: env.autoRollback, currentVersion: env.currentVersion }
}
