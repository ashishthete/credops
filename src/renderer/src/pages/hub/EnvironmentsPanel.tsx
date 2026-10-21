import { Copy, KeyRound, Lock, Upload, Cloud } from 'lucide-react'
import { useState } from 'react'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import type { HubCatalogEnv, HubDeployKey } from '../../../../shared/hub'
import { useDeployments, useServices } from '../../deploy/store'
import { getDeployKey, publishEnvironment, unpublishEnvironment, useHub } from '../../hub/store'
import { useInventory } from '../../inventory/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../ui/Toaster'
import { byProduct } from './names'
import { ListSkeleton } from './shared'

type Entry = { id: string; env: EnvironmentMeta } | { id: string; hub: HubCatalogEnv }

const counts = (hosts: number, services: number, deployments: number) =>
  `${plural(hosts, 'host')}, ${plural(services, 'service')}, ${plural(deployments, 'deployment')}`

/** Publish local environments to the Hub, manage each one's deploy key, and see what is still missing. */
export function EnvironmentsPanel({ onOpenSecrets }: { onOpenSecrets: () => void }) {
  const { adminEnvs, adminLoaded } = useHub()
  const data = useInventory()
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  if (!adminLoaded || !data) return <ListSkeleton />
  const published = new Map(adminEnvs.map((e) => [e.environment.id, e]))
  const hubOnly = adminEnvs.filter((e) => !data.environments.some((l) => l.id === e.environment.id))
  // This machine's environments first, then the Hub's that it has no copy of; each goes under its product.
  const entries: Entry[] = [...data.environments.map((env) => ({ id: env.id, env })), ...hubOnly.map((hub) => ({ id: hub.environment.id, hub }))]
  const { groups, rest } = byProduct(entries, (e) => e.id, data, (e) => ('hub' in e ? e.hub.environment.product?.name : undefined))
  const row = (e: Entry) =>
    'env' in e ? (
      <LocalEnvRow key={e.id} env={e.env} hub={published.get(e.id) ?? null} onConfirm={setConfirm} onOpenSecrets={onOpenSecrets} />
    ) : (
      <HubOnlyRow key={e.id} hub={e.hub} onConfirm={setConfirm} onOpenSecrets={onOpenSecrets} />
    )
  if (data.environments.length === 0 && hubOnly.length === 0) {
    return <EmptyState icon={Cloud} title="No environments yet" text="Create an environment in the inventory, then publish it here for your team." />
  }
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.name} className="flex flex-col gap-3">
          <h3 className="mt-1 text-[11px] font-medium tracking-wide text-muted uppercase">{g.name}</h3>
          {g.items.map(row)}
        </section>
      ))}
      {rest.map(row)}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function LocalEnvRow({ env, hub, onConfirm, onOpenSecrets }: { env: EnvironmentMeta; hub: HubCatalogEnv | null; onConfirm: (r: ConfirmRequest) => void; onOpenSecrets: () => void }) {
  const services = useServices(env.id)
  const deployments = useDeployments(env.id)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const local = { hosts: env.hosts.length, services: services.length, deployments: deployments.length }

  const publish = async () => {
    setBusy(true)
    const out = await publishEnvironment(env.id)
    setBusy(false)
    if (out) setResult(out.missingSecrets.length ? `Published. ${plural(out.missingSecrets.length, 'secret')} still missing.` : 'Published.')
  }
  const unpublish = () =>
    onConfirm({
      title: `Unpublish ${env.name}?`,
      description: 'Your team loses access to it in the Hub. Your local environment is untouched.',
      confirmLabel: 'Unpublish',
      run: async () => {
        await unpublishEnvironment(env.id)
      },
    })

  return (
    <EnvCard name={env.name} protectedEnv={env.protected} hub={hub}>
      <p className="mt-1 text-[12.5px] text-muted">
        {hub ? `On the Hub: ${counts(hub.hosts.length, hub.services.length, hub.deployments.length)}. ` : ''}
        {`On this machine: ${counts(local.hosts, local.services, local.deployments)}.`}
      </p>
      {hub && (local.hosts !== hub.hosts.length || local.services !== hub.services.length || local.deployments !== hub.deployments.length) && (
        <p className="mt-1 text-[12.5px] text-fg">
          {`Re-publish to send ${[
            local.hosts !== hub.hosts.length && `${local.hosts - hub.hosts.length >= 0 ? '+' : ''}${local.hosts - hub.hosts.length} hosts`,
            local.services !== hub.services.length && `${local.services - hub.services.length >= 0 ? '+' : ''}${local.services - hub.services.length} services`,
            local.deployments !== hub.deployments.length && `${local.deployments - hub.deployments.length >= 0 ? '+' : ''}${local.deployments - hub.deployments.length} deployments`,
          ]
            .filter(Boolean)
            .join(', ')}.`}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy} icon={<Upload aria-hidden className="size-3.5" />} aria-label={`${hub ? 'Re-publish' : 'Publish to Hub'} ${env.name}`} onClick={() => void publish()}>
          {hub ? 'Re-publish' : 'Publish to Hub'}
        </Button>
        {hub && (
          <Button size="sm" variant="ghost" aria-label={`Unpublish ${env.name}`} onClick={unpublish}>
            Unpublish
          </Button>
        )}
        {result && <span className="text-[12.5px] text-muted">{result}</span>}
      </div>
      {hub && <DeployKeyCard env={hub} onConfirm={onConfirm} onOpenSecrets={onOpenSecrets} />}
    </EnvCard>
  )
}

function HubOnlyRow({ hub, onConfirm, onOpenSecrets }: { hub: HubCatalogEnv; onConfirm: (r: ConfirmRequest) => void; onOpenSecrets: () => void }) {
  return (
    <EnvCard name={hub.environment.name} protectedEnv={hub.environment.protected} hub={hub}>
      <p className="mt-1 text-[12.5px] text-muted">{`Published by ${hub.publishedBy}; not on this machine. ${counts(hub.hosts.length, hub.services.length, hub.deployments.length)}.`}</p>
      <div className="mt-2">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Unpublish ${hub.environment.name}`}
          onClick={() =>
            onConfirm({
              title: `Unpublish ${hub.environment.name}?`,
              description: 'Your team loses access to it in the Hub.',
              confirmLabel: 'Unpublish',
              run: async () => {
                await unpublishEnvironment(hub.environment.id)
              },
            })
          }
        >
          Unpublish
        </Button>
      </div>
      <DeployKeyCard env={hub} onConfirm={onConfirm} onOpenSecrets={onOpenSecrets} />
    </EnvCard>
  )
}

function EnvCard({ name, protectedEnv, hub, children }: { name: string; protectedEnv: boolean; hub: HubCatalogEnv | null; children: React.ReactNode }) {
  return (
    <article className="rounded-xl border border-line bg-surface/70 px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[13.5px] font-semibold text-fg">{name}</h3>
        {protectedEnv && (
          <Badge tone="warn">
            <Lock aria-hidden className="size-3" />
            Protected
          </Badge>
        )}
        {hub && <Badge tone="success">Published to Hub</Badge>}
      </div>
      {children}
    </article>
  )
}

function DeployKeyCard({ env, onConfirm, onOpenSecrets }: { env: HubCatalogEnv; onConfirm: (r: ConfirmRequest) => void; onOpenSecrets: () => void }) {
  const [key, setKey] = useState<HubDeployKey | null>(null)
  const [busy, setBusy] = useState(false)
  const name = env.environment.name
  const load = async (rotate: boolean) => {
    setBusy(true)
    const out = await getDeployKey(env.environment.id, rotate)
    setBusy(false)
    if (out) setKey(out)
  }
  const copy = async () => {
    if (!key) return
    try {
      await navigator.clipboard.writeText(key.publicKey)
      toast({ title: 'Public key copied', tone: 'success' })
    } catch {
      toast({ title: "Couldn't copy the public key", tone: 'error' })
    }
  }
  const fingerprint = key?.fingerprint ?? env.deployKey?.fingerprint ?? null
  return (
    <section aria-label={`Deploy key for ${name}`} className="mt-3 rounded-lg border border-line px-3 py-2.5">
      <h4 className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg">
        <KeyRound aria-hidden className="size-3.5" />
        Deploy key
      </h4>
      {fingerprint && <p className="mt-1 font-mono text-[12px] text-muted">{fingerprint}</p>}
      {key && <textarea readOnly aria-label={`Public key for ${name}`} className="mt-2 w-full rounded-md border border-line bg-surface-2/60 p-2 font-mono text-[11.5px] text-fg" rows={3} value={key.publicKey} />}
      <p className="mt-1 text-[12px] text-muted">
        Add this key to <code className="font-mono">authorized_keys</code> on every host and jump host of {name}.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!env.deployKey && !key ? (
          <Button size="sm" loading={busy} aria-label={`Generate deploy key for ${name}`} onClick={() => void load(false)}>
            Generate
          </Button>
        ) : (
          <>
            {!key && (
              <Button size="sm" variant="ghost" loading={busy} aria-label={`Show public key for ${name}`} onClick={() => void load(false)}>
                Show public key
              </Button>
            )}
            {key && (
              <Button size="sm" variant="ghost" icon={<Copy aria-hidden className="size-3.5" />} aria-label={`Copy public key for ${name}`} onClick={() => void copy()}>
                Copy
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rotate deploy key for ${name}`}
              onClick={() =>
                onConfirm({
                  title: `Rotate the deploy key for ${name}?`,
                  description: 'The new public key must be added to every host and jump host before the next release; until then releases cannot connect.',
                  confirmLabel: 'Rotate',
                  run: async () => {
                    await load(true)
                  },
                })
              }
            >
              Rotate
            </Button>
          </>
        )}
        {env.missingSecrets > 0 && (
          <button type="button" className="text-[12.5px] text-accent underline-offset-2 hover:underline" onClick={onOpenSecrets}>
            {`Missing secrets (${env.missingSecrets})`}
          </button>
        )}
      </div>
    </section>
  )
}
