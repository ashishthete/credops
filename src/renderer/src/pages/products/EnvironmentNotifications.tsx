import { X } from 'lucide-react'
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import {
  EMAIL,
  GITHUB_REPO,
  GITHUB_WORKFLOW,
  MAX_EMAIL,
  MAX_GIT_REF,
  MAX_RECIPIENTS,
  NOTIFY_EVENTS,
  PROD_LIKE,
  QA_WAIT_DEFAULT_MIN,
  QA_WAIT_RANGE,
  type EnvironmentIntegrations,
  type EnvironmentIntegrationsPatch,
  type NotificationRecord,
  type NotifyEventKey,
  type NotifyStatus,
} from '../../../../shared/settings'
import { api } from '../../lib/api'
import { CHANNEL_LABEL } from '../../settings/events'
import { SecretPicker } from '../../settings/SecretPicker'
import { refreshSecrets, useIntegrations } from '../../settings/store'
import { Button } from '../../ui/Button'
import { attempt } from '../../ui/common'
import { TextField } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toaster'

export const EVENT_LABEL: Record<NotifyEventKey, string> = {
  'release.started': 'Release started',
  'release.succeeded': 'Release succeeded',
  'release.failed': 'Release failed',
  'release.rolled_back': 'Release rolled back',
  'tunnel.failed': 'Tunnel failed',
  'qa.finished': 'QA finished',
}
const STATUS_LABEL: Record<NotifyStatus, string> = { pending: 'Pending', sent: 'Sent', skipped: 'Skipped', failed: 'Failed' }
const STATUS_DOT: Record<NotifyStatus, string> = { pending: 'bg-warn', sent: 'bg-ok', skipped: 'bg-muted/50', failed: 'bg-err' }
const LOG_LIMIT = 20

const split = (text: string) => text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
const isEmail = (t: string) => t.length <= MAX_EMAIL && EMAIL.test(t)

/** Committed address chips plus the text being typed; Enter, comma or blur commits the valid part. */
function useRecipients(initial: string[]) {
  const [tokens, setTokens] = useState(initial)
  const [draft, setDraft] = useState('')
  const [touched, setTouched] = useState(false)
  useEffect(() => setTokens(initial), [initial])
  const pending = split(draft)
  const bad = pending.find((t) => !isEmail(t))
  const all = [...new Set([...tokens, ...pending.filter(isEmail)])]
  const error = touched && bad ? `${bad} isn't an email address.` : all.length > MAX_RECIPIENTS ? `Up to ${MAX_RECIPIENTS} recipients.` : undefined
  const commit = () => {
    setTouched(true)
    const good = pending.filter(isEmail)
    if (!good.length) return
    setTokens((t) => [...new Set([...t, ...good])])
    setDraft(pending.filter((t) => !isEmail(t)).join(', '))
  }
  return {
    tokens,
    draft,
    error,
    valid: !bad && all.length <= MAX_RECIPIENTS,
    value: all,
    setDraft: (v: string) => (setDraft(v), setTouched(false)),
    commit,
    remove: (t: string) => setTokens((ts) => ts.filter((x) => x !== t)),
  }
}

function RecipientsField({ label, r }: { label: string; r: ReturnType<typeof useRecipients> }) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      r.commit()
    } else if (e.key === 'Backspace' && !r.draft && r.tokens.length) r.remove(r.tokens[r.tokens.length - 1])
  }
  return (
    <div className="flex flex-col gap-1.5">
      {r.tokens.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label={`${label} recipients`}>
          {r.tokens.map((t) => (
            <span key={t} className="inline-flex h-6 items-center gap-1 rounded-full bg-fg/5 pr-1 pl-2 font-mono text-[11.5px] text-fg/90">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => r.remove(t)} className="grid size-4 place-items-center rounded-full text-muted hover:text-fg">
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <TextField
        label={label}
        placeholder="name@example.com"
        value={r.draft}
        error={r.error}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => r.setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={r.commit}
      />
    </div>
  )
}

function EventChip({ label, pressed, onToggle }: { label: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex h-7 items-center rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,box-shadow,color] ${
        pressed ? 'bg-accent/15 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]' : 'text-muted shadow-[inset_0_0_0_1px_var(--border)] hover:text-fg'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Per-environment notification events, Teams and email recipients, and the QA workflow. Lives inside
 * EnvironmentDialog for an existing environment, and saves on its own through integration:update.
 */
export function EnvironmentNotifications({ environment }: { environment: EnvironmentMeta }) {
  const headingId = useId()
  const { secrets } = useIntegrations()
  const prodLike = PROD_LIKE.test(environment.name)
  const [saved, setSaved] = useState<EnvironmentIntegrations | null>(null)
  const [log, setLog] = useState<NotificationRecord[] | null>(null)
  const [events, setEvents] = useState<NotifyEventKey[]>([])
  const [webhook, setWebhook] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [workflow, setWorkflow] = useState('')
  const [ref, setRef] = useState('')
  const [qaOnDeploy, setQaOnDeploy] = useState(false)
  const [qaWait, setQaWait] = useState(false)
  const [waitMinutes, setWaitMinutes] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const to = useRecipients(saved?.emailTo ?? EMPTY)
  const cc = useRecipients(saved?.emailCc ?? EMPTY)

  useEffect(() => {
    let live = true
    void refreshSecrets()
    void attempt("Couldn't load the environment's notifications", () => api.invoke('integration:get', environment.id)).then((s) => live && s && setSaved(s))
    api.invoke('notify:log', { environmentId: environment.id, limit: LOG_LIMIT }).then(
      (rows) => live && setLog(rows ?? []),
      () => live && setLog([]),
    )
    return () => {
      live = false
    }
  }, [environment.id])

  useEffect(() => {
    if (!saved) return
    setEvents(saved.notifyEvents)
    setWebhook(saved.teamsWebhookSecretId)
    setRepo(saved.qa?.repo ?? '')
    setWorkflow(saved.qa?.workflow ?? '')
    setRef(saved.qa?.ref ?? '')
    // Never set up: QA after deploy starts on, except on prod-like environments.
    setQaOnDeploy(saved.qa === null && saved.updatedAt === null ? !prodLike : saved.qaOnDeploy)
    setQaWait(saved.qaWait)
    setWaitMinutes(saved.qa?.waitMinutes === undefined ? '' : String(saved.qa.waitMinutes))
  }, [saved, prodLike])

  const qaBlank = !repo.trim() && !workflow.trim() && !ref.trim()
  const repoError = repo.trim() && !GITHUB_REPO.test(repo.trim()) ? 'Use owner/name.' : !qaBlank && !repo.trim() ? 'Needed for QA.' : undefined
  const workflowError =
    workflow.trim() && !GITHUB_WORKFLOW.test(workflow.trim()) ? 'A workflow file (qa.yml) or a numeric id.' : !qaBlank && !workflow.trim() ? 'Needed for QA.' : undefined
  const refError = ref.trim().length > MAX_GIT_REF ? 'That ref is too long.' : !qaBlank && !ref.trim() ? 'Needed for QA.' : undefined
  const waitText = waitMinutes.trim()
  const waitValue = waitText === '' ? undefined : Number(waitText)
  const waitError =
    waitValue !== undefined && (!Number.isInteger(waitValue) || waitValue < QA_WAIT_RANGE[0] || waitValue > QA_WAIT_RANGE[1])
      ? `Whole minutes, ${QA_WAIT_RANGE[0]} to ${QA_WAIT_RANGE[1]}.`
      : undefined
  // A disabled field has no effect: its bad value neither blocks Save nor gets saved.
  const waitDisabled = !saved || !qaWait || qaBlank
  const waitSaved = waitError ? (waitDisabled ? undefined : waitValue) : waitValue
  const valid = !!saved && to.valid && cc.valid && !repoError && !workflowError && !refError && !(waitError && !waitDisabled)

  const toggle = (k: NotifyEventKey) => setEvents((ev) => (ev.includes(k) ? ev.filter((x) => x !== k) : [...ev, k]))

  const save = async () => {
    if (!valid) return
    setBusy('save')
    const patch: EnvironmentIntegrationsPatch = {
      notifyEvents: NOTIFY_EVENTS.filter((k) => events.includes(k)),
      teamsWebhookSecretId: webhook,
      emailTo: to.value,
      emailCc: cc.value,
      qa: qaBlank ? null : { repo: repo.trim(), workflow: workflow.trim(), ref: ref.trim(), ...(waitSaved !== undefined ? { waitMinutes: waitSaved } : {}) },
      qaOnDeploy,
      qaWait,
    }
    const next = await attempt("Couldn't save notifications", () => api.invoke('integration:update', environment.id, patch))
    setBusy(null)
    if (!next) return
    setSaved(next)
    toast({ title: `Notifications saved for ${environment.name}`, tone: 'success' })
  }

  const sendTest = async () => {
    setBusy('test')
    const ok = await attempt(`Couldn't send a test card to ${environment.name}`, async () => {
      await api.invoke('notify:test', { channel: 'teams', environmentId: environment.id })
      return true
    })
    setBusy(null)
    if (ok) toast({ title: `Test card sent to ${environment.name}`, tone: 'success' })
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3.5 border-t border-line pt-4">
      <h3 id={headingId} className="text-[13px] font-semibold text-fg">
        Notifications and QA
      </h3>
      <div role="group" aria-label="Events" className="flex flex-wrap gap-1.5">
        {NOTIFY_EVENTS.map((k) => (
          <EventChip key={k} label={EVENT_LABEL[k]} pressed={events.includes(k)} onToggle={() => toggle(k)} />
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <SecretPicker
            label="Teams webhook"
            kind="webhook"
            noun="webhook"
            newLabel="New webhook URL"
            defaultName={`Teams: ${environment.name}`}
            secrets={secrets}
            value={webhook}
            onChange={setWebhook}
            disabled={!saved}
          />
        </div>
        <Button variant="ghost" loading={busy === 'test'} disabled={!saved?.teamsWebhookSecretId} onClick={() => void sendTest()}>
          Send test card
        </Button>
      </div>
      <RecipientsField label="Email to" r={to} />
      <RecipientsField label="Email cc" r={cc} />
      <div className="grid grid-cols-[1fr_1fr_96px] gap-2">
        <TextField label="QA repository" placeholder="owner/qa" value={repo} error={repoError} spellCheck={false} onChange={(e) => setRepo(e.target.value)} className="font-mono" />
        <TextField label="Workflow" placeholder="qa.yml" value={workflow} error={workflowError} spellCheck={false} onChange={(e) => setWorkflow(e.target.value)} className="font-mono" />
        <TextField label="Ref" placeholder="main" value={ref} error={refError} spellCheck={false} maxLength={MAX_GIT_REF + 1} onChange={(e) => setRef(e.target.value)} className="font-mono" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3 text-[13px] text-fg/90">
          <span>Run QA after deploy</span>
          <Switch label="Run QA after deploy" checked={qaOnDeploy} onChange={setQaOnDeploy} disabled={!saved} />
        </div>
        {prodLike && <p className="text-[12px] text-muted">QA stays off on prod-like environments unless you turn it on here.</p>}
      </div>
      <div className="flex items-center justify-between gap-3 text-[13px] text-fg/90">
        <span>Wait for the QA result before finishing</span>
        <Switch label="Wait for result" checked={qaWait} onChange={setQaWait} disabled={!saved || !qaOnDeploy} />
      </div>
      <TextField
        label="Wait up to (minutes)"
        placeholder={String(QA_WAIT_DEFAULT_MIN)}
        value={waitMinutes}
        error={waitError}
        disabled={waitDisabled}
        inputMode="numeric"
        spellCheck={false}
        onChange={(e) => setWaitMinutes(e.target.value)}
        className="font-mono"
      />
      <div className="flex justify-end">
        <Button size="sm" loading={busy === 'save'} disabled={!valid} onClick={() => void save()}>
          Save notifications
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-fg/90">Recent</span>
        {log === null ? (
          <span className="text-[12px] text-muted">Loading…</span>
        ) : log.length === 0 ? (
          <span className="text-[12px] text-muted">Nothing sent yet.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {log.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-[12px] text-fg/90">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} />
                <span className="w-12 shrink-0 text-muted">{CHANNEL_LABEL[r.channel]}</span>
                <span className="min-w-0 truncate">{EVENT_LABEL[r.event as NotifyEventKey] ?? r.event}</span>
                <span className="shrink-0 text-muted">{STATUS_LABEL[r.status]}</span>
                {r.detail && <span className="min-w-0 truncate text-muted">{r.detail}</span>}
                <time dateTime={r.at} className="ml-auto shrink-0 text-muted tabular-nums">
                  {new Date(r.at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

const EMPTY: string[] = []
