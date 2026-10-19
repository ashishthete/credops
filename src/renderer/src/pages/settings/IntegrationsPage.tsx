import { motion } from 'framer-motion'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { AI_MODEL, DEFAULT_AI_MODEL, EMAIL, MAX_EMAIL } from '../../../../shared/settings'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { SecretPicker } from '../../settings/SecretPicker'
import { loadIntegrations, saveSettings, useIntegrations } from '../../settings/store'
import { Button } from '../../ui/Button'
import { attempt } from '../../ui/common'
import { SelectField, TextField } from '../../ui/Field'
import { fast, useMotionSafe } from '../../ui/motion'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toaster'

const MODEL_ERROR = `Use a Claude model id, like ${DEFAULT_AI_MODEL}.`
const FROM_ERROR = "That isn't an email address."

function Card({ title, configured, index, children, note }: { title: string; configured: boolean | null; index: number; children: ReactNode; note?: string }) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const label = configured === null ? 'Checking…' : configured ? 'Configured' : (note ?? 'Not configured')
  return (
    <motion.section
      aria-labelledby={id}
      initial={motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
      transition={{ ...fast, delay: motionSafe ? index * 0.05 : 0 }}
      className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface/70 p-4"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 id={id} className="text-[14px] font-semibold text-fg">
          {title}
        </h2>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
          <span aria-hidden className={`size-2 rounded-full ${configured ? 'bg-ok' : 'bg-muted/50'}`} />
          {label}
        </span>
      </header>
      {children}
    </motion.section>
  )
}

/** A text setting saved on blur or Enter, once it is valid and changed. */
function useSavedText(saved: string | null, valid: (v: string) => boolean, save: (v: string) => void) {
  const [text, setText] = useState(saved ?? '')
  const [touched, setTouched] = useState(false)
  useEffect(() => setText(saved ?? ''), [saved])
  const ok = valid(text.trim())
  const commit = () => {
    setTouched(true)
    const t = text.trim()
    if (ok && t !== (saved ?? '')) save(t)
  }
  return { text, setText: (v: string) => (setText(v), setTouched(false)), commit, error: touched && !ok }
}

export function IntegrationsPage() {
  const { settings, status, secrets } = useIntegrations()
  const inventory = useInventory()
  const environments = inventory?.environments ?? []
  const [testEnv, setTestEnv] = useState('')
  const [sending, setSending] = useState<'email' | 'macos' | null>(null)

  useEffect(() => void loadIntegrations(), [])

  const model = useSavedText(settings?.aiModel ?? null, (v) => AI_MODEL.test(v), (v) => void saveSettings({ aiModel: v }))
  const from = useSavedText(
    settings?.sendgridFrom ?? null,
    (v) => v === '' || (v.length <= MAX_EMAIL && EMAIL.test(v)),
    (v) => void saveSettings({ sendgridFrom: v || null }),
  )
  const envId = testEnv || environments[0]?.id || ''

  const test = async (kind: 'email' | 'macos') => {
    setSending(kind)
    const target = kind === 'macos' ? ({ channel: 'macos' } as const) : ({ channel: 'email', environmentId: envId } as const)
    const ok = await attempt(kind === 'macos' ? "Couldn't send the test notification" : "Couldn't send the test email", async () => {
      await api.invoke('notify:test', target)
      return true
    })
    setSending(null)
    if (ok) toast({ title: kind === 'macos' ? 'Test notification sent' : 'Test email sent', tone: 'success' })
  }

  const disabled = !settings
  return (
    <div className="h-full overflow-y-auto">
      <div className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">AI &amp; integrations</h1>
      </div>
      <div className="mx-auto grid max-w-[880px] grid-cols-1 gap-4 px-8 pb-10 lg:grid-cols-2">
        <Card title="AI" index={0} configured={status ? status.ai.configured : null}>
          <div className="flex flex-col gap-1">
            <TextField
              label="Model"
              value={model.text}
              disabled={disabled}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              error={model.error ? MODEL_ERROR : undefined}
              hint={model.error ? undefined : `Default: ${DEFAULT_AI_MODEL}`}
              onChange={(e) => model.setText(e.target.value)}
              onBlur={model.commit}
              onKeyDown={(e) => e.key === 'Enter' && model.commit()}
            />
            {settings && settings.aiModel !== DEFAULT_AI_MODEL && (
              <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => void saveSettings({ aiModel: DEFAULT_AI_MODEL })}>
                Reset to {DEFAULT_AI_MODEL}
              </button>
            )}
          </div>
          <SecretPicker
            label="API key"
            kind="api_key"
            noun="key"
            newLabel="New API key"
            defaultName="Anthropic API key"
            disabled={disabled}
            secrets={secrets}
            value={settings?.aiApiKeySecretId ?? null}
            onChange={(id) => void saveSettings({ aiApiKeySecretId: id })}
          />
        </Card>

        <Card title="SendGrid" index={1} configured={status ? status.sendgrid : null}>
          <SecretPicker
            label="SendGrid key"
            kind="api_key"
            noun="key"
            newLabel="New SendGrid key"
            defaultName="SendGrid API key"
            disabled={disabled}
            secrets={secrets}
            value={settings?.sendgridApiKeySecretId ?? null}
            onChange={(id) => void saveSettings({ sendgridApiKeySecretId: id })}
          />
          <TextField
            label="From address"
            placeholder="releases@example.com"
            value={from.text}
            disabled={disabled}
            maxLength={MAX_EMAIL}
            error={from.error ? FROM_ERROR : undefined}
            onChange={(e) => from.setText(e.target.value)}
            onBlur={from.commit}
            onKeyDown={(e) => e.key === 'Enter' && from.commit()}
          />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <SelectField label="Test environment" value={envId} onChange={(e) => setTestEnv(e.target.value)} disabled={!environments.length}>
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button variant="ghost" loading={sending === 'email'} disabled={!envId || !status?.sendgrid} onClick={() => void test('email')}>
              Send test email…
            </Button>
          </div>
        </Card>

        <Card title="GitHub" index={2} configured={status ? status.github : null}>
          <SecretPicker
            label="Token"
            kind="token"
            noun="token"
            newLabel="New GitHub token"
            defaultName="GitHub token"
            hint="Needs Actions read and write on the QA repositories."
            disabled={disabled}
            secrets={secrets}
            value={settings?.githubTokenSecretId ?? null}
            onChange={(id) => void saveSettings({ githubTokenSecretId: id })}
          />
        </Card>

        <Card
          title="macOS"
          index={3}
          configured={status && settings ? status.macosSupported && settings.macos : null}
          note={status && !status.macosSupported ? 'Not supported here' : undefined}
        >
          <div className="flex items-center justify-between gap-3 text-[13px] text-fg/90">
            <span>Notification Center alerts</span>
            <Switch label="macOS notifications" checked={!!settings?.macos} disabled={disabled} onChange={(macos) => void saveSettings({ macos })} />
          </div>
          <div className="flex items-center justify-between gap-3 text-[13px] text-fg/90">
            <span>Also for tunnels with no environment</span>
            <Switch
              label="Tunnels with no environment"
              checked={!!settings?.macosUnscoped}
              disabled={disabled || !settings?.macos}
              onChange={(macosUnscoped) => void saveSettings({ macosUnscoped })}
            />
          </div>
          <Button variant="ghost" className="self-start" loading={sending === 'macos'} disabled={!settings?.macos} onClick={() => void test('macos')}>
            Send test notification
          </Button>
        </Card>
      </div>
    </div>
  )
}
