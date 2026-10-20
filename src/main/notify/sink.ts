import { redact } from '../security/redact'
import type { IntegrationStore } from '../settings/integration-store'
import type { SettingsStore } from '../settings/settings-store'
import { buildReleaseEmail, sendEmail, type SendGridBody } from './email'
import { IntegrationError, type Fetch } from './http'
import type { MacNotifier } from './macos'
import { sendTeams, type NotificationFacts } from './teams'

/** Where notifications go. The dispatcher only ever sees this; tests swap in a fake. */
export interface NotificationSink {
  teams(environmentId: string, facts: NotificationFacts): Promise<void>
  email(environmentId: string, facts: NotificationFacts, notes: string | null, opts?: { subject?: string }): Promise<void>
  macos(facts: NotificationFacts, route: string): void
}

export interface LocalSinkDeps {
  secrets: { value(id: string): string }
  settings: SettingsStore
  integrations: IntegrationStore
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  notifier: MacNotifier
  knownSecrets: () => readonly string[]
}

/** Sends for real. Secret values are read at call time and live only inside the call. */
export class LocalSink implements NotificationSink {
  constructor(private readonly d: LocalSinkDeps) {}

  async teams(environmentId: string, facts: NotificationFacts): Promise<void> {
    const id = this.d.integrations.forEnvironment(environmentId).teamsWebhookSecretId
    if (!id) throw new IntegrationError('teams', 'config', `No Teams webhook set for ${facts.environment.name}`, [])
    await this.guard(() => {
      const url = this.d.secrets.value(id)
      return { secret: url, run: () => sendTeams(url, facts, this.deps()) }
    })
  }

  async email(environmentId: string, facts: NotificationFacts, notes: string | null, opts: { subject?: string } = {}): Promise<void> {
    const s = this.d.settings.get()
    const integ = this.d.integrations.forEnvironment(environmentId)
    if (!s.sendgridApiKeySecretId) throw new IntegrationError('sendgrid', 'config', 'No SendGrid API key set', [])
    if (!s.sendgridFrom) throw new IntegrationError('sendgrid', 'config', 'No SendGrid from address set', [])
    if (integ.emailTo.length === 0) throw new IntegrationError('sendgrid', 'config', `No email recipients set for ${facts.environment.name}`, [])
    const keyId = s.sendgridApiKeySecretId
    const from = s.sendgridFrom
    await this.guard(() => {
      const key = this.d.secrets.value(keyId)
      const body: SendGridBody = buildReleaseEmail(facts, notes, { from, to: integ.emailTo, cc: integ.emailCc, knownSecrets: [...this.d.knownSecrets(), key] })
      if (opts.subject) body.subject = opts.subject
      return { secret: key, run: () => sendEmail(key, body, this.deps()) }
    })
  }

  macos(facts: NotificationFacts, route: string): void {
    this.d.notifier.show(facts, route)
  }

  private deps() {
    return { fetch: this.d.fetch, sleep: this.d.sleep, knownSecrets: this.d.knownSecrets() }
  }

  /** Any non-integration error (a vault or store failure) is re-thrown with the secret and every vault value masked. */
  private async guard(prepare: () => { secret: string; run: () => Promise<void> }): Promise<void> {
    let secret = ''
    try {
      const p = prepare()
      secret = p.secret
      await p.run()
    } catch (e) {
      if (e instanceof IntegrationError) throw e
      throw new Error(redact(e instanceof Error ? e.message : String(e), [...this.d.knownSecrets(), ...(secret ? [secret] : [])]))
    }
  }
}
