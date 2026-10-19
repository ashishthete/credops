import { motion } from 'framer-motion'
import { ExternalLink, Globe, KeyRound, Link2, Lock, Network, Pencil, Plus, Route, Server, SquareTerminal, Trash2, Unlink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { DEFAULT_SSH_PORT, type EnvironmentMeta } from '../../../../shared/inventory'
import type { AppServiceMeta } from '../../../../shared/services'
import { startDeploySync } from '../../deploy/store'
import { sourceLabel } from '../../inventory/choices'
import { openEnvironmentDomain, type InventoryData } from '../../inventory/store'
import type { NodeKey } from '../../inventory/tree'
import { showEnvironmentOnMapPath } from '../../map/commands'
import { useConnect } from '../../terminal/connect'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { RowMenu } from '../../ui/common'
import { fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { GlowDot, PaneHeader, ROLE_LABEL, ROLE_ORDER } from './ProductView'
import { DeployWizard } from '../deployments/release/DeployWizard'
import { CopyServicesDialog } from './services/CopyServicesDialog'
import { ServiceLogs } from './services/ServiceLogs'
import { ServicesSection } from './services/ServicesSection'

interface EnvironmentViewProps {
  env: EnvironmentMeta
  envKey: NodeKey
  data: InventoryData
  onSelect: (key: NodeKey) => void
  onRemoveHost: (hostId: string) => void
  onNewHost: () => void
  onEdit: () => void
  onDelete: () => void
  /** Set when viewed under a product: takes the environment out of that product only. */
  removeFrom?: { productName: string; run: () => void }
}

export function EnvironmentView({ env, envKey, data, onSelect, onRemoveHost, onNewHost, onEdit, onDelete, removeFrom }: EnvironmentViewProps) {
  const motionSafe = useMotionSafe()
  const { connect } = useConnect()
  const navigate = useNavigate()
  // The services and checkouts the Services section shows.
  useEffect(() => startDeploySync(), [])
  const [logsOf, setLogsOf] = useState<AppServiceMeta | null>(null)
  const [copyFrom, setCopyFrom] = useState<EnvironmentMeta | null>(null)
  // The services the deploy wizard starts with ticked; null while it is closed.
  const [deployPick, setDeployPick] = useState<string[] | null>(null)
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const identity = env.defaultIdentityId ? data.identities.find((i) => i.id === env.defaultIdentityId) : undefined
  const jump = env.defaultJumpHostId ? hostById.get(env.defaultJumpHostId) : undefined
  const inherited = sourceLabel('environment', env.name)
  const appDefault = sourceLabel('global')

  const groups = ROLE_ORDER.map((role) => ({
    role,
    hosts: env.hosts
      .filter((m) => m.role === role)
      .flatMap((m) => (hostById.has(m.hostId) ? [hostById.get(m.hostId)!] : []))
      .sort((a, b) => a.label.localeCompare(b.label)),
  })).filter((g) => g.hosts.length)

  return (
    <>
      <PaneHeader
        lead={<GlowDot color={env.color} />}
        title={env.name}
        badges={
          <>
            {env.protected && (
              <Badge tone="warn">
                <Lock aria-hidden className="size-3" />
                Protected
              </Badge>
            )}
            {env.productIds.length > 1 && (
              <Badge tone="info">
                <Link2 aria-hidden className="size-3" />
                Shared
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={onNewHost}>
              New host
            </Button>
            <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon={<Network aria-hidden className="size-3.5" />} onClick={() => navigate(showEnvironmentOnMapPath(env.id))}>
              Show on map
            </Button>
            <RowMenu
              label={`${env.name} options`}
              items={[
                ...(removeFrom ? [{ label: `Remove from ${removeFrom.productName}`, icon: Unlink, run: removeFrom.run }] : []),
                { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
              ]}
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8">
        <dl className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <Default
            icon={KeyRound}
            term="Identity"
            value={identity ? `${identity.label} (${identity.username})` : 'Your SSH keys (agent, then ~/.ssh keys)'}
            source={env.defaultIdentityId ? inherited : appDefault}
          />
          <Default
            icon={Network}
            term="Port"
            value={String(env.defaultPort ?? DEFAULT_SSH_PORT)}
            mono
            source={env.defaultPort != null ? inherited : appDefault}
          />
          <Default
            icon={Route}
            term="Jump host"
            value={jump?.label ?? 'Direct'}
            source={env.defaultJumpHostId ? inherited : appDefault}
          />
          <Default
            icon={Globe}
            term="Domain or URL"
            value={env.domain ?? 'None'}
            mono={env.domain !== null}
            source={env.domain !== null ? 'Used for bare host names' : 'Not set'}
            action={
              env.domain !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ExternalLink aria-hidden className="size-3.5" />}
                  aria-label={`Open ${env.domain} in your browser`}
                  onClick={() => void openEnvironmentDomain(env.id)}
                >
                  Open
                </Button>
              )
            }
          />
        </dl>

        <ServicesSection env={env} data={data} onDeploy={setDeployPick} onLogs={setLogsOf} onCopy={() => setCopyFrom(env)} />

        {groups.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center">
            <Server aria-hidden className="size-5 text-muted" strokeWidth={1.8} />
            <p className="text-[13px] font-medium text-fg">No hosts in this environment yet</p>
            <p className="text-[12.5px] text-muted">Create one with New host, or drag a host onto {env.name} in the tree.</p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.role} className="mt-6">
              <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-fg/90">
                {ROLE_LABEL[g.role]}
                <span className="min-w-5 rounded-full bg-white/[0.05] px-1.5 text-center text-[11px] leading-[18px] font-medium text-muted tabular-nums">
                  {g.hosts.length}
                </span>
              </h3>
              <ul className="flex flex-col gap-1">
                {g.hosts.map((h, i) => (
                  <motion.li
                    key={h.id}
                    initial={motionSafe ? { opacity: 0, x: -4 } : { opacity: 0 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={motionSafe ? { ...spring, delay: staggerDelay(i) } : fast}
                    className="group relative"
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(`${envKey}/h:${h.id}`)}
                      className="flex h-10 w-full items-center gap-3 rounded-lg border border-transparent px-3 pr-28 text-left transition-colors hover:border-line hover:bg-white/[0.03]"
                    >
                      <Server aria-hidden className="size-3.5 shrink-0 text-muted" />
                      <span className="truncate text-[13px] font-medium text-fg">{h.label}</span>
                      <span className="truncate font-mono text-[12px] text-muted">
                        {h.address}
                        {h.port != null ? `:${h.port}` : ''}
                      </span>
                      {h.environments.length > 1 && (
                        <Link2 aria-label="Shared" className="ml-auto size-3 shrink-0 text-muted" strokeWidth={2.2} />
                      )}
                    </button>
                    <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Connect to ${h.label}`}
                        title={`Connect to ${h.label} in ${env.name}`}
                        onClick={() => void connect(h.id, env.id)}
                        className="grid size-6 place-items-center rounded-md text-muted opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
                      >
                        <SquareTerminal aria-hidden className="size-3.5" />
                      </button>
                      {/* Always shown and labelled, so removing a host is findable without hovering. */}
                      <button
                        type="button"
                        aria-label={`Remove ${h.label} from ${env.name}`}
                        title={`Remove from ${env.name}`}
                        onClick={() => onRemoveHost(h.id)}
                        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted opacity-60 transition-[opacity,color,background-color] group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
                      >
                        <Unlink aria-hidden className="size-3.5 shrink-0" />
                        <span className="whitespace-nowrap">Remove</span>
                      </button>
                    </div>
                  </motion.li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <ServiceLogs service={logsOf} onClose={() => setLogsOf(null)} />
      <CopyServicesDialog source={copyFrom} onClose={() => setCopyFrom(null)} />
      {deployPick && <DeployWizard key={env.id} environmentId={env.id} preselect={deployPick} onClose={() => setDeployPick(null)} />}
    </>
  )
}

function Default({
  icon: Icon,
  term,
  value,
  source,
  mono,
  action,
}: {
  icon: LucideIcon
  term: string
  value: string
  source: string
  mono?: boolean
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface/70 px-4 py-3">
      <dt className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <Icon aria-hidden className="size-3" />
        {term}
      </dt>
      <dd className={`truncate text-[13px] font-medium text-fg ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</dd>
      <dd className="flex items-center justify-between gap-2 text-[11.5px] text-muted">
        <span className="truncate">{source}</span>
        {action}
      </dd>
    </div>
  )
}
