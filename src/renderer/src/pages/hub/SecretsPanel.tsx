import { ShieldCheck, Upload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { HubCatalogEnv, HubSecretKind, HubSecretList, HubSecretMeta } from '../../../../shared/hub'
import type { SecretMeta } from '../../../../shared/vault'
import { api } from '../../lib/api'
import { loadSecrets, setIntegrationSecret, uploadSecrets, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ListSkeleton } from './shared'

const GLOBAL: { kind: HubSecretKind; label: string }[] = [
  { kind: 'sendgrid_api_key', label: 'SendGrid API key' },
  { kind: 'github_token', label: 'GitHub token' },
  { kind: 'anthropic_api_key', label: 'Anthropic API key' },
]
const select = 'h-7 rounded-md border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg'
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Hub secrets: write-only. Names, kinds and timestamps are all that ever comes back; values go up from the vault. */
export function SecretsPanel() {
  const { adminEnvs, adminLoaded } = useHub()
  const [vault, setVault] = useState<SecretMeta[]>([])
  useEffect(() => {
    void api.invoke('secret:list').then((l) => setVault(l ?? []), () => setVault([]))
  }, [])
  if (!adminLoaded) return <ListSkeleton />
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <GlobalIntegrations vault={vault} />
      {adminEnvs.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No published environments" text="Publish an environment first; its required secrets are listed here." />
      ) : (
        adminEnvs.map((env) => <EnvSecrets key={env.environment.id} env={env} vault={vault} />)
      )}
    </div>
  )
}

function VaultPick({ label, vault, onPick }: { label: string; vault: SecretMeta[]; onPick: (id: string) => void | Promise<unknown> }) {
  const [id, setId] = useState('')
  return (
    <div className="flex items-center gap-2">
      <select aria-label={label} className={select} value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Pick a vault secret…</option>
        {vault.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={!id}
        aria-label={`Set ${label}`}
        onClick={async () => {
          await onPick(id)
          setId('')
        }}
      >
        Set
      </Button>
    </div>
  )
}

function useList(envId: string | null) {
  const [list, setList] = useState<HubSecretList | null>(null)
  const reload = useCallback(async () => setList((await loadSecrets(envId)) ?? null), [envId])
  useEffect(() => void reload(), [reload])
  return [list, reload] as const
}

function GlobalIntegrations({ vault }: { vault: SecretMeta[] }) {
  const [list, reload] = useList(null)
  const meta = (k: HubSecretKind): HubSecretMeta | undefined => list?.secrets.find((s) => s.kind === k)
  return (
    <section aria-label="Integrations" className="rounded-xl border border-line bg-surface/70 px-4 py-3">
      <h3 className="text-[13.5px] font-semibold text-fg">Integrations</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {GLOBAL.map(({ kind, label }) => {
          const m = meta(kind)
          return (
            <li key={kind} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2 text-fg">
                {label}
                {m ? <Badge tone="success">{`Set · ${m.updatedBy} · ${when(m.updatedAt)}`}</Badge> : <Badge tone="warn">Missing</Badge>}
              </span>
              <VaultPick
                label={label}
                vault={vault}
                onPick={async (id) => {
                  await setIntegrationSecret(null, kind, id)
                  await reload()
                }}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function EnvSecrets({ env, vault }: { env: HubCatalogEnv; vault: SecretMeta[] }) {
  const id = env.environment.id
  const name = env.environment.name
  const [list, reload] = useList(id)
  const [busy, setBusy] = useState(false)
  const missing = list?.missing[id] ?? []
  // The Hub lists the global integration secrets with every environment's; only this environment's own belong here.
  const own = (list?.secrets ?? []).filter((s) => s.environmentId === id)
  const set = own.filter((s) => s.kind === 'env' || s.kind === 'become')
  const teams = own.find((s) => s.kind === 'teams_webhook')

  const upload = async (secretIds?: string[]) => {
    setBusy(true)
    await uploadSecrets(id, secretIds)
    await reload()
    setBusy(false)
  }
  return (
    <section aria-label={`Secrets for ${name}`} className="rounded-xl border border-line bg-surface/70 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-fg">{name}</h3>
        <Button size="sm" loading={busy} icon={<Upload aria-hidden className="size-3.5" />} aria-label={`Upload all from vault for ${name}`} onClick={() => void upload()}>
          Upload from vault
        </Button>
      </div>
      {!list ? (
        <ListSkeleton />
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {set.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-[13px] text-fg">
              <span>{s.name}</span>
              <Badge tone="success">{`Set · ${s.updatedBy} · ${when(s.updatedAt)}`}</Badge>
            </li>
          ))}
          {missing.map((m) => (
            <li key={m.secretId} className="flex items-center justify-between text-[13px] text-fg">
              <span>{m.name}</span>
              <span className="flex items-center gap-2">
                <Badge tone="warn">Missing</Badge>
                <Button size="sm" variant="ghost" aria-label={`Upload ${m.name} from vault`} onClick={() => void upload([m.secretId])}>
                  Upload from vault
                </Button>
              </span>
            </li>
          ))}
          {set.length === 0 && missing.length === 0 && <li className="text-[12.5px] text-muted">No secrets required.</li>}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="flex items-center gap-2 text-fg">
          Teams webhook
          {teams ? <Badge tone="success">{`Set · ${teams.updatedBy} · ${when(teams.updatedAt)}`}</Badge> : <Badge tone="warn">Missing</Badge>}
        </span>
        <VaultPick
          label={`Teams webhook for ${name}`}
          vault={vault}
          onPick={async (secretId) => {
            await setIntegrationSecret(id, 'teams_webhook', secretId)
            await reload()
          }}
        />
      </div>
    </section>
  )
}
