import { motion } from 'framer-motion'
import { Box, Copy, CopyPlus, Database, ExternalLink, Leaf, Link2, Pencil, Plug, RotateCw, Rocket, ScrollText, Server, ShieldCheck, SquareTerminal, Trash2, Unplug, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RegionRef } from '../../../../../shared/inventory'
import type { AppServiceMeta, BastionServiceMeta, DbEngine, DbServiceMeta } from '../../../../../shared/services'
import type { TunnelState } from '../../../../../shared/tunnels'
import { closeServiceTunnel, openService, openServiceTunnel, syncServiceTunnel } from '../../../deploy/store'
import { useTunnel } from '../../../tunnels/store'
import { ContextMenu, RowMenu, useContextMenu, type MenuItem } from '../../../ui/common'
import { RegionChip } from '../../../ui/RegionChip'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'
import { toast } from '../../../ui/Toaster'
import { STATE_DOT, TunnelStateWord } from '../../tunnels/TunnelCard'

export const ENGINE_ICON: Record<DbEngine, LucideIcon> = { postgres: Database, mysql: Database, mongodb: Leaf, redis: Zap, other: Database }

/** The 7-character short form of a commit. */
export const shortSha = (sha: string): string => sha.slice(0, 7)

const action =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted transition-[opacity,color,background-color] hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100'

/** Copies `text` and says so. */
export function copyText(text: string, what = text): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast({ title: `Copied ${what}`, tone: 'success' }))
    .catch(() => {})
}

/**
 * The row chrome both kinds share: enters with the stagger when motion-safe, a fade otherwise. `menu` is
 * both the ⋯ menu and what a right-click on the row opens.
 */
function Row({
  name,
  index,
  dim,
  children,
  actions,
  menu,
  hostLabel,
  onConnect,
}: {
  name: string
  index: number
  dim?: boolean
  children: ReactNode
  actions: ReactNode
  menu: MenuItem[]
  /** With `onConnect`, a Connect button opens a terminal on the host the service runs on. */
  hostLabel?: string | null
  onConnect?: () => void
}) {
  const motionSafe = useMotionSafe()
  const context = useContextMenu()
  return (
    <motion.li
      aria-label={name}
      onContextMenu={context.onContextMenu}
      initial={motionSafe ? { opacity: 0, x: -4 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, x: 0 } : { opacity: 1 }}
      transition={motionSafe ? { ...spring, delay: staggerDelay(index) } : fast}
      className="group relative flex min-h-10 items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 transition-colors hover:border-line hover:bg-white/[0.03]"
    >
      <div className={`flex min-w-0 flex-1 items-center gap-3 ${dim ? 'opacity-55' : ''}`}>{children}</div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onConnect && hostLabel && (
          <button type="button" aria-label={`Connect to ${hostLabel}`} title={`Open a terminal on ${hostLabel}`} onClick={onConnect} className={action}>
            <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
            Connect
          </button>
        )}
        <RowMenu label={`${name} options`} items={menu} />
      </div>
      <ContextMenu at={context.at} label={`${name} options`} items={menu} onClose={context.close} />
    </motion.li>
  )
}

interface RowProps<T> {
  svc: T
  index: number
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  /** Set only when the environment spans more than one region. */
  region?: RegionRef
  /** The label of the host the service runs on. */
  hostLabel: string | null
  /** Opens a terminal on that host, in this environment. */
  onConnect?: () => void
}

/** "Connect to <host>", when the row can. */
const connectItem = (hostLabel: string | null, onConnect?: () => void) =>
  onConnect && hostLabel ? [{ label: `Connect to ${hostLabel}`, icon: SquareTerminal, run: onConnect }] : []

/** "on <host>", muted, with a server icon. */
function OnHost({ label }: { label: string | null }) {
  if (!label) return null
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-[12px] text-muted" title={`Runs on ${label}`}>
      <Server aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

export function ServiceRow({
  svc,
  index,
  onEdit,
  onDuplicate,
  onDelete,
  region,
  hostLabel,
  onConnect,
  onLogs,
  onDeploy,
}: RowProps<AppServiceMeta> & { onLogs?: (svc: AppServiceMeta) => void; onDeploy?: (preselect: string[]) => void }) {
  const orphan = svc.deploymentId === null
  return (
    <Row
      name={svc.name}
      index={index}
      hostLabel={hostLabel}
      onConnect={onConnect}
      dim={orphan}
      menu={[
        { label: 'Edit', icon: Pencil, run: onEdit },
        { label: 'Duplicate', icon: CopyPlus, run: onDuplicate },
        { label: 'Copy name', icon: Copy, run: () => copyText(svc.name) },
        ...connectItem(hostLabel, onConnect),
        ...(svc.url ? [{ label: 'Copy URL', icon: Link2, run: () => copyText(svc.url!) }] : []),
        { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
      ]}
      actions={
        <>
          {!orphan && (
            <>
              {onLogs && (
                <button type="button" aria-label={`Logs for ${svc.name}`} onClick={() => onLogs(svc)} className={action}>
                  <ScrollText aria-hidden className="size-3.5 shrink-0" />
                  Logs
                </button>
              )}
              {onDeploy && (
                <button type="button" aria-label={`Deploy ${svc.name}`} onClick={() => onDeploy([svc.id])} className={action}>
                  <Rocket aria-hidden className="size-3.5 shrink-0" />
                  Deploy
                </button>
              )}
            </>
          )}
          {svc.url && (
            <button type="button" aria-label={`Open ${svc.name}`} title={svc.url} onClick={() => void openService(svc.id)} className={action}>
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
              Open
            </button>
          )}
        </>
      }
    >
      <Box aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
      {svc.composeService && <span className="truncate font-mono text-[12px] text-muted">{svc.composeService}</span>}
      <OnHost label={hostLabel} />
      {region && <RegionChip region={region} />}
      <span className="ml-auto shrink-0 text-[12px] text-muted">
        {orphan ? (
          'No checkout'
        ) : svc.lastDeployedCommit ? (
          <span className="font-mono tabular-nums" title={svc.lastDeployedCommit}>
            {shortSha(svc.lastDeployedCommit)}
          </span>
        ) : (
          'Never deployed'
        )}
      </span>
    </Row>
  )
}

const LIVE: TunnelState[] = ['connecting', 'up', 'retrying']

export function DbRow({ svc, index, hostLabel, onConnect, routeChanged, onEdit, onDuplicate, onDelete, region }: RowProps<DbServiceMeta> & { routeChanged: boolean }) {
  const motionSafe = useMotionSafe()
  const { runtime } = useTunnel(svc.tunnelId ?? '')
  const state: TunnelState = (svc.tunnelId && runtime?.state) || 'stopped'
  const live = LIVE.includes(state)
  const port = runtime?.boundPort ?? svc.localPort
  const address = state === 'up' && port != null ? `127.0.0.1:${port}` : null
  const Icon = ENGINE_ICON[svc.dbEngine]
  const target = `${svc.dbAddress}:${svc.dbPort}`

  return (
    <Row
      name={svc.name}
      index={index}
      hostLabel={hostLabel}
      onConnect={onConnect}
      menu={[
        { label: 'Edit', icon: Pencil, run: onEdit },
        { label: 'Duplicate', icon: CopyPlus, run: onDuplicate },
        { label: 'Copy name', icon: Copy, run: () => copyText(svc.name) },
        ...connectItem(hostLabel, onConnect),
        ...(address ? [{ label: 'Copy local address', icon: Link2, run: () => copyText(address) }] : []),
        { label: 'Copy database address', icon: Link2, run: () => copyText(target) },
        { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
      ]}
      actions={
        <>
          {address && (
            <span className="flex items-center gap-1">
              <span className="font-mono text-[12px] text-fg/90 tabular-nums">{address}</span>
              <button type="button" aria-label={`Copy ${address}`} onClick={() => copyText(address)} className={action}>
                <Copy aria-hidden className="size-3.5 shrink-0" />
              </button>
            </span>
          )}
          <span className="flex items-center gap-1.5 px-1">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full transition-colors duration-300 ${STATE_DOT[state]} ${state === 'connecting' && motionSafe ? 'od-pulse' : ''}`}
            />
            <TunnelStateWord state={state} />
          </span>
          {live ? (
            <button type="button" aria-label={`Close the ${svc.name} tunnel`} onClick={() => void closeServiceTunnel(svc.id)} className={action}>
              <Unplug aria-hidden className="size-3.5 shrink-0" />
              Close tunnel
            </button>
          ) : (
            <button type="button" aria-label={`Open the ${svc.name} tunnel`} onClick={() => void openServiceTunnel(svc.id)} className={action}>
              <Plug aria-hidden className="size-3.5 shrink-0" />
              Open tunnel
            </button>
          )}
        </>
      }
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
      <span className="shrink-0 text-[12px] text-muted">{svc.dbEngine}</span>
      <span className="truncate font-mono text-[12px] text-muted">{target}</span>
      <OnHost label={hostLabel} />
      {region && <RegionChip region={region} />}
      {routeChanged && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-warn">
          Route changed; restart to apply
          <button type="button" aria-label={`Restart the ${svc.name} tunnel`} onClick={() => void syncServiceTunnel(svc.id)} className={action}>
            <RotateCw aria-hidden className="size-3.5 shrink-0" />
            Restart
          </button>
        </span>
      )}
    </Row>
  )
}

/** A bastion: a host the environment is reached through. Nothing to run or open here. */
export function BastionRow({ svc, index, hostLabel, onConnect, onEdit, onDuplicate, onDelete, region }: RowProps<BastionServiceMeta>) {
  return (
    <Row
      name={svc.name}
      index={index}
      hostLabel={hostLabel}
      onConnect={onConnect}
      menu={[
        { label: 'Edit', icon: Pencil, run: onEdit },
        { label: 'Duplicate', icon: CopyPlus, run: onDuplicate },
        { label: 'Copy name', icon: Copy, run: () => copyText(svc.name) },
        ...connectItem(hostLabel, onConnect),
        { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
      ]}
      actions={null}
    >
      <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
      <OnHost label={hostLabel} />
      {region && <RegionChip region={region} />}
      {svc.description && <span className="ml-auto truncate text-[12px] text-muted">{svc.description}</span>}
    </Row>
  )
}
