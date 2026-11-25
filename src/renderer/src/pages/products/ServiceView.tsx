import { Box, Boxes, Clock, ExternalLink, FolderGit2, Globe, HeartPulse, Layers, Link2, Network, Pencil, Plug, Rocket, ScrollText, Server, ShieldCheck, SquareTerminal, Trash2, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EnvironmentMeta } from '../../../../shared/inventory'
import { SERVICE_KIND_LABEL, type AppServiceMeta, type ServiceMeta } from '../../../../shared/services'
import type { TunnelState } from '../../../../shared/tunnels'
import { closeServiceTunnel, openService, openServiceTunnel, startDeploySync, useDeployments } from '../../deploy/store'
import type { InventoryData } from '../../inventory/store'
import { useConnect } from '../../terminal/connect'
import { useTunnel } from '../../tunnels/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { RowMenu } from '../../ui/common'
import { RegionChip } from '../../ui/RegionChip'
import { DeployWizard } from '../deployments/release/DeployWizard'
import { STATE_WORD } from '../tunnels/TunnelCard'
import { Default } from './EnvironmentView'
import { PaneHeader, paneLabel } from './ProductView'
import { ENGINE_ICON, copyText, shortSha } from './services/ServiceRow'
import { ServiceLogs } from './services/ServiceLogs'

interface ServiceViewProps {
  service: ServiceMeta
  env: EnvironmentMeta
  data: InventoryData
  onEdit: () => void
  onDelete: () => void
  /** Shows the environment the service is in. */
  onOpenEnvironment: () => void
}

const LIVE: TunnelState[] = ['connecting', 'up', 'retrying']
const ENGINE_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', redis: 'Redis', other: 'Other' } as const

/** One service's page: what it is, where it runs, and the things you can do with it. */
export function ServiceView({ service: svc, env, data, onEdit, onDelete, onOpenEnvironment }: ServiceViewProps) {
  const { connect } = useConnect()
  useEffect(() => startDeploySync(), [])
  const checkouts = useDeployments(env.id)
  const [logsOf, setLogsOf] = useState<AppServiceMeta | null>(null)
  const [deploying, setDeploying] = useState(false)
  const host = data.hosts.find((h) => h.id === svc.hostId)
  const region = host && data.regions.find((r) => r.id === host.regionId)
  const tunnelId = svc.kind === 'db' ? svc.tunnelId : null
  const { runtime } = useTunnel(tunnelId ?? '')
  const state: TunnelState = (tunnelId && runtime?.state) || 'stopped'
  const checkout = svc.kind === 'service' && svc.deploymentId ? checkouts.find((d) => d.id === svc.deploymentId) : undefined
  const deployable = svc.kind === 'service' && svc.deploymentId !== null
  const Icon = svc.kind === 'db' ? ENGINE_ICON[svc.dbEngine] : svc.kind === 'bastion' ? ShieldCheck : Box
  const open = (
    <Button size="sm" variant="ghost" icon={<SquareTerminal aria-hidden className="size-3.5" />} aria-label={`Connect to ${host?.label ?? 'the host'}`} onClick={() => void connect(svc.hostId, env.id)}>
      Connect
    </Button>
  )

  return (
    <>
      <PaneHeader
        lead={<Icon aria-hidden className="size-4 text-muted" />}
        title={svc.name}
        badges={
          <>
            <Badge tone={svc.kind === 'db' ? 'warn' : 'info'}>{SERVICE_KIND_LABEL[svc.kind]}</Badge>
            {region && <RegionChip region={region} />}
          </>
        }
        actions={
          <>
            {deployable && (
              <Button size="sm" icon={<Rocket aria-hidden className="size-3.5" />} onClick={() => setDeploying(true)}>
                Deploy
              </Button>
            )}
            {svc.kind === 'db' &&
              (LIVE.includes(state) ? (
                <Button size="sm" icon={<Unplug aria-hidden className="size-3.5" />} onClick={() => void closeServiceTunnel(svc.id)}>
                  Close tunnel
                </Button>
              ) : (
                <Button size="sm" icon={<Plug aria-hidden className="size-3.5" />} onClick={() => void openServiceTunnel(svc.id)}>
                  Open tunnel
                </Button>
              ))}
            {deployable && (
              <Button size="sm" variant="ghost" icon={<ScrollText aria-hidden className="size-3.5" />} onClick={() => setLogsOf(svc as AppServiceMeta)} {...paneLabel('Logs')} />
            )}
            <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit} {...paneLabel('Edit')} />
            <RowMenu
              label={`${svc.name} options`}
              items={[
                { label: 'Copy name', icon: Link2, run: () => copyText(svc.name) },
                { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
              ]}
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8">
        {svc.description && <p className="mb-3 text-[13px] text-muted">{svc.description}</p>}
        <dl aria-label="Service details" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line @3xl:grid-cols-4">
          <Default
            icon={Layers}
            term="Environment"
            value={env.name}
            source={env.protected ? 'Protected' : 'Where it belongs'}
            action={
              <Button size="sm" variant="ghost" aria-label={`Show ${env.name}`} onClick={onOpenEnvironment}>
                Show
              </Button>
            }
          />
          <Default icon={Server} term="Host" value={host?.label ?? 'Unknown'} source={host?.address ?? ''} action={host && open} />
          {svc.kind === 'service' && (
            <>
              <Default
                icon={FolderGit2}
                term="Checkout"
                value={checkout?.name ?? (svc.deploymentId ? 'Loading…' : 'None')}
                source={checkout ? checkout.repoPath : 'Not deployed from here'}
                mono={false}
              />
              <Default icon={Boxes} term="Compose service" value={svc.composeService || 'None'} mono={svc.composeService !== ''} source={svc.deploymentId ? 'In the checkout’s compose file' : 'Only with a checkout'} />
              <Default
                icon={Globe}
                term="URL"
                value={svc.url ?? 'None'}
                mono={svc.url !== null}
                source={svc.url ? 'Opens in your browser' : 'Not set'}
                action={
                  svc.url && (
                    <Button size="sm" variant="ghost" icon={<ExternalLink aria-hidden className="size-3.5" />} aria-label={`Open ${svc.name}`} onClick={() => void openService(svc.id)}>
                      Open
                    </Button>
                  )
                }
              />
              <Default icon={HeartPulse} term="Health check" value={svc.urlCheckFrom === 'mac' ? 'From this Mac' : 'From the host'} source={svc.url ? 'After a deploy' : 'Needs a URL'} />
              <Default
                icon={Clock}
                term="Last deployed"
                value={svc.lastDeployedCommit ? shortSha(svc.lastDeployedCommit) : svc.deploymentId ? 'Never' : 'No checkout'}
                mono={svc.lastDeployedCommit !== null}
                source={svc.skipUnchanged ? 'Skipped when no new commits' : 'Deploys on every release'}
              />
            </>
          )}
          {svc.kind === 'db' && (
            <>
              <Default icon={ENGINE_ICON[svc.dbEngine]} term="Engine" value={ENGINE_LABEL[svc.dbEngine]} source="Database" />
              <Default
                icon={Network}
                term="Address"
                value={`${svc.dbAddress}:${svc.dbPort}`}
                mono
                source="As seen from the host"
                action={
                  <Button size="sm" variant="ghost" aria-label="Copy database address" onClick={() => copyText(`${svc.dbAddress}:${svc.dbPort}`)}>
                    Copy
                  </Button>
                }
              />
              <Default
                icon={Plug}
                term="Tunnel"
                value={STATE_WORD[state]}
                source={svc.localPort != null ? `127.0.0.1:${runtime?.boundPort ?? svc.localPort} on this Mac` : 'Local port picked on first open'}
                action={
                  state === 'up' &&
                  svc.localPort != null && (
                    <Button size="sm" variant="ghost" aria-label="Copy local address" onClick={() => copyText(`127.0.0.1:${runtime?.boundPort ?? svc.localPort}`)}>
                      Copy
                    </Button>
                  )
                }
              />
            </>
          )}
        </dl>
        {svc.kind === 'bastion' && <p className="mt-4 text-[13px] text-muted">A bastion is a host {env.name} is reached through. There is nothing to deploy or open here.</p>}
        {svc.kind === 'service' && !svc.deploymentId && (
          <p className="mt-4 text-[13px] text-muted">This app has no checkout, so it can't be deployed. Edit it to pick one.</p>
        )}
      </div>
      <ServiceLogs service={logsOf} onClose={() => setLogsOf(null)} />
      {deploying && <DeployWizard key={svc.id} environmentId={env.id} preselect={[svc.id]} onClose={() => setDeploying(false)} />}
    </>
  )
}
