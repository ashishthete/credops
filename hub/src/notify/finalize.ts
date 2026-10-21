import type { AuditAppender } from '../../../src/main/audit/audit-log'
import { AI_MESSAGES, ClaudeClient, type AnthropicLike, type ClientFactoryOptions } from '../../../src/main/ai/claude'
import { promptContext } from '../../../src/main/ai/prompt-redact'
import { releaseNotesFinalizeStep } from '../../../src/main/ai/release-notes'
import type { FinalizeSteps, ReleaseRunMeta } from '../../../src/main/deploy/finalize'
import { NotificationDispatcher } from '../../../src/main/notify/dispatcher'
import { buildReleaseEmail, sendEmail, type SendGridBody } from '../../../src/main/notify/email'
import { createFinalizeSteps } from '../../../src/main/notify/finalize'
import { IntegrationError, type Fetch } from '../../../src/main/notify/http'
import { QaDispatcher, qaFinalizeStep } from '../../../src/main/notify/qa'
import type { NotificationSink } from '../../../src/main/notify/sink'
import { sendTeams, type NotificationFacts } from '../../../src/main/notify/teams'
import { redact } from '../../../src/main/security/redact'
import { AiFailure } from '../../../src/shared/ai'
import type { AuditInput } from '../../../src/shared/audit'
import type { ReleaseStatus } from '../../../src/shared/deploy'
import { HUB_AUDIT_ACTIONS, type HubAuditAction, type HubSecretKind } from '../../../src/shared/hub'
import {
  DEFAULT_AI_MODEL,
  GITHUB_REPO,
  GITHUB_WORKFLOW,
  MAX_GIT_REF,
  NOTIFY_EVENTS,
  type EnvironmentIntegrations,
  type IntegrationSettings,
  type QaWorkflow,
} from '../../../src/shared/settings'
import type { HubAudit } from '../audit'
import type { HubDb } from '../db'
import type { Registry } from '../registry'
import type { SecretStore } from '../secrets/store'

export interface HubFinalizeDeps {
  db: HubDb
  secrets: Pick<SecretStore, 'integration'>
  registry: Pick<Registry, 'get' | 'nameOf'>
  audit: Pick<HubAudit, 'append'>
  /** The Hub's own ReleaseService (late-bound: it is built with these steps). */
  runMeta: (releaseId: string, status?: ReleaseStatus) => ReleaseRunMeta
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  /** The From address on release emails (`sendgridFrom` in the Hub config). */
  sendgridFrom?: string
  /** Tests stand in for the Anthropic SDK client. */
  claudeFactory?: (o: ClientFactoryOptions) => AnthropicLike
  /** The Hub's other known secrets (run secrets, deploy keys). */
  knownSecrets?: () => readonly string[]
  now?: () => Date
}

export interface HubNotify {
  finalize: FinalizeSteps
  dispatcher: NotificationDispatcher
  qa: QaDispatcher
  /** Integration secrets in use right now; they join the Hub's known secrets while a send is in flight. */
  held(): string[]
}

const AUDIT_ACTIONS: ReadonlySet<string> = new Set(HUB_AUDIT_ACTIONS)

function validQa(raw: unknown): QaWorkflow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const ok = typeof q.repo === 'string' && GITHUB_REPO.test(q.repo) && typeof q.workflow === 'string' && GITHUB_WORKFLOW.test(q.workflow) && typeof q.ref === 'string' && q.ref.length > 0 && q.ref.length <= MAX_GIT_REF
  return ok ? { repo: q.repo as string, workflow: q.workflow as string, ref: q.ref as string } : null
}

/**
 * Phase 9's dispatcher, Teams, SendGrid, QA and release-notes steps on Hub secrets. The Hub never queues for a vault
 * unlock, never alerts through macOS and keeps its idempotency in its own `notification_log`.
 */
export function createHubNotify(d: HubFinalizeDeps): HubNotify {
  const heldCounts = new Map<string, number>()
  const held = (): string[] => [...heldCounts.keys()]
  const known = (): readonly string[] => [...(d.knownSecrets?.() ?? []), ...held()]
  /** Masks a secret until the returned function is called (once). */
  const hold = (value: string): (() => void) => {
    heldCounts.set(value, (heldCounts.get(value) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (heldCounts.get(value) ?? 1) - 1
      if (n <= 0) heldCounts.delete(value)
      else heldCounts.set(value, n)
    }
  }
  /** Reads one integration secret; it is masked everywhere while `run` is in flight. */
  async function using<T>(environmentId: string | null, kind: HubSecretKind, run: (value: string) => Promise<T>, missing: () => Error): Promise<T> {
    const value = d.secrets.integration(environmentId, kind)
    if (value === null) throw missing()
    const release = hold(value)
    try {
      return await run(value)
    } catch (e) {
      if (e instanceof IntegrationError || e instanceof AiFailure) throw e
      throw new Error(redact(e instanceof Error ? e.message : String(e), [...known(), value]))
    } finally {
      release()
    }
  }
  const has = (kind: HubSecretKind): boolean => d.secrets.integration(null, kind) !== null
  const deps = () => ({ fetch: d.fetch, sleep: d.sleep, knownSecrets: known() })

  const sink: NotificationSink = {
    teams: (environmentId: string, facts: NotificationFacts) =>
      using(environmentId, 'teams_webhook', (url) => sendTeams(url, facts, deps()), () => new IntegrationError('teams', 'config', `No Teams webhook set for ${facts.environment.name}`, [])),
    email: async (environmentId, facts, notes, opts = {}) => {
      const from = d.sendgridFrom
      if (!from) throw new IntegrationError('sendgrid', 'config', 'No SendGrid from address set', [])
      const to = d.registry.get(environmentId).integrations
      if (to.emailTo.length === 0) throw new IntegrationError('sendgrid', 'config', `No email recipients set for ${facts.environment.name}`, [])
      await using(
        null,
        'sendgrid_api_key',
        (key) => {
          const body: SendGridBody = buildReleaseEmail(facts, notes, { from, to: to.emailTo, cc: to.emailCc, knownSecrets: [...known(), key] })
          if (opts.subject) body.subject = opts.subject
          return sendEmail(key, body, deps())
        },
        () => new IntegrationError('sendgrid', 'config', 'No SendGrid API key set', []),
      )
    },
    // Clients alert through the live feed; the Hub has no desktop to notify.
    macos: () => undefined,
  }

  const integrations = {
    forEnvironment(id: string): EnvironmentIntegrations {
      const i = d.registry.get(id).integrations
      return {
        environmentId: id,
        notifyEvents: NOTIFY_EVENTS.filter((k) => i.notifyEvents.includes(k)),
        teamsWebhookSecretId: d.secrets.integration(id, 'teams_webhook') !== null ? 'teams_webhook' : null,
        emailTo: i.emailTo,
        emailCc: i.emailCc,
        qaOnDeploy: i.qaOnDeploy,
        qa: validQa(i.qa),
        qaWait: i.qaWait,
        updatedAt: null,
      }
    },
    environmentName(id: string): string {
      const name = d.registry.nameOf(id)
      if (name === null) throw new Error('environment not found')
      return name
    },
  }
  const settings = {
    get: (): IntegrationSettings => ({
      aiModel: DEFAULT_AI_MODEL,
      aiApiKeySecretId: has('anthropic_api_key') ? 'anthropic_api_key' : null,
      sendgridApiKeySecretId: has('sendgrid_api_key') ? 'sendgrid_api_key' : null,
      sendgridFrom: d.sendgridFrom ?? null,
      githubTokenSecretId: has('github_token') ? 'github_token' : null,
      macos: false,
      macosUnscoped: false,
    }),
  }

  const audit: AuditAppender = {
    append(input: AuditInput): void {
      let action: string = input.action
      let details = input.details ?? {}
      let outcome = input.outcome
      let targetId = input.targetId
      if (input.action === 'notify.send') {
        const x = (input.details ?? {}) as { channel?: string; status?: string }
        if (x.status !== 'sent' && x.status !== 'failed') return
        action = x.status === 'sent' ? 'notify.sent' : 'notify.failed'
        details = { channel: x.channel, releaseId: targetId }
      }
      if (!AUDIT_ACTIONS.has(action)) return
      // QA stopped waiting without a conclusion: the Hub audit has no `info`, so it is a success with no conclusion.
      if (outcome === 'info') {
        outcome = 'success'
        details = { ...details, conclusion: 'unknown' }
      }
      d.audit.append({
        action: action as HubAuditAction,
        outcome,
        actor: null,
        targetType: input.targetType ?? null,
        targetId: targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        details,
      })
    },
  }

  const dispatcher = new NotificationDispatcher({
    db: d.db,
    sink,
    integrations,
    settings,
    vault: { isUnlocked: () => true },
    audit,
    runs: { runMeta: (id, status) => d.runMeta(id, status) },
    tunnels: {
      get: () => {
        throw new Error('The Hub has no tunnels')
      },
    },
    environment: (id, fallback) => {
      const name = d.registry.nameOf(id)
      return { name: name ?? fallback ?? 'Unknown environment', color: '', protected: name !== null && d.registry.get(id).environment.protected }
    },
    knownSecrets: known,
    ...(d.now ? { now: d.now } : {}),
  })

  const qa = new QaDispatcher({
    secrets: { value: () => d.secrets.integration(null, 'github_token') ?? '' },
    settings,
    integrations,
    fetch: d.fetch,
    sleep: d.sleep,
    audit,
    dispatcher,
    runs: { runMeta: (id) => d.runMeta(id) },
    knownSecrets: known,
    ...(d.now ? { now: d.now } : {}),
  })

  // Claude is built per call so its key is read, and masked, only while the stream runs.
  const claude = {
    async stream(req: Parameters<ClaudeClient['stream']>[0]) {
      return using(
        null,
        'anthropic_api_key',
        (key) =>
          new ClaudeClient({
            settings: { get: () => ({ aiModel: DEFAULT_AI_MODEL, aiApiKeySecretId: 'anthropic_api_key' }) },
            secrets: { value: () => key },
            vault: { isUnlocked: () => true },
            knownSecrets: () => [...known(), key],
            ...(d.claudeFactory ? { factory: d.claudeFactory } : {}),
          }).stream(req),
        // No key: the notes step falls back to the commit list.
        () => new AiFailure('no-key', AI_MESSAGES['no-key']),
      )
    },
  }

  // The GitHub token is read inside QaDispatcher on every call; it is masked while a dispatch runs and while its
  // background wait can still poll (2 min to find the run, then 30 min), so errors and the live feed never carry it.
  const QA_WAIT_MS = 33 * 60_000
  const heldQa: Pick<QaDispatcher, 'dispatch' | 'watch'> = {
    async dispatch(environmentId, o) {
      const token = d.secrets.integration(null, 'github_token')
      const release = token === null ? () => undefined : hold(token)
      try {
        return await qa.dispatch(environmentId, o)
      } finally {
        release()
      }
    },
    watch(item) {
      const token = d.secrets.integration(null, 'github_token')
      if (token !== null) setTimeout(hold(token), QA_WAIT_MS).unref()
      qa.watch(item)
    },
  }

  const finalize = createFinalizeSteps({
    dispatcher,
    notes: releaseNotesFinalizeStep({
      claude,
      audit,
      redaction: () => {
        const rows = d.db.prepare('SELECT address, username FROM hosts').all() as { address: string; username: string }[]
        return promptContext({
          knownSecrets: known,
          identities: { list: () => rows.map((r) => ({ username: r.username })) },
          hosts: { list: () => rows.map((r) => ({ address: r.address })) },
          osUser: () => 'hub',
        })
      },
      environmentName: integrations.environmentName,
    }),
    qa: qaFinalizeStep({ qa: heldQa, integrations }),
  })
  return { finalize, dispatcher, qa, held }
}

/** Phase 9's finalize steps on Hub-backed dependencies. */
export const hubFinalize = (deps: HubFinalizeDeps): FinalizeSteps => createHubNotify(deps).finalize
