import { motion } from 'framer-motion'
import { Box, Copy, Database, ExternalLink, Leaf, Pencil, Plug, RotateCw, Rocket, ScrollText, Trash2, Unplug, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppServiceMeta, DbEngine, DbServiceMeta } from '../../../../../shared/services'
import type { TunnelState } from '../../../../../shared/tunnels'
import { closeServiceTunnel, openService, openServiceTunnel, syncServiceTunnel } from '../../../deploy/store'
import { useTunnel } from '../../../tunnels/store'
import { RowMenu } from '../../../ui/common'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'
import { toast } from '../../../ui/Toaster'
import { STATE_DOT, TunnelStateWord } from '../../tunnels/TunnelCard'

export const ENGINE_ICON: Record<DbEngine, LucideIcon> = { postgres: Database, mysql: Database, mongodb: Leaf, redis: Zap, other: Database }

/** The 7-character short form of a commit. */
export const shortSha = (sha: string): string => sha.slice(0, 7)

const action =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted transition-[opacity,color,background-color] hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100'

/** The row chrome both kinds share: enters with the stagger when motion-safe, a fade otherwise. */
function Row({ name, index, dim, children, actions }: { name: string; index: number; dim?: boolean; children: ReactNode; actions: ReactNode }) {
  const motionSafe = useMotionSafe()
  return (
    <motion.li
      aria-label={name}
      initial={motionSafe ? { opacity: 0, x: -4 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, x: 0 } : { opacity: 1 }}
      transition={motionSafe ? { ...spring, delay: staggerDelay(index) } : fast}
      className="group relative flex min-h-10 items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 transition-colors hover:border-line hover:bg-white/[0.03]"
    >
      <div className={`flex min-w-0 flex-1 items-center gap-3 ${dim ? 'opacity-55' : ''}`}>{children}</div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </motion.li>
  )
}

interface RowProps<T> {
  svc: T
  index: number
  onEdit: () => void
  onDelete: () => void
}

export function ServiceRow({
  svc,
  index,
  onEdit,
  onDelete,
  onLogs,
  onDeploy,
}: RowProps<AppServiceMeta> & { onLogs?: (svc: AppServiceMeta) => void; onDeploy?: (preselect: string[]) => void }) {
  const orphan = svc.deploymentId === null
  return (
    <Row
      name={svc.name}
      index={index}
      dim={orphan}
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
          <RowMenu
            label={`${svc.name} options`}
            items={[
              { label: 'Edit', icon: Pencil, run: onEdit },
              { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
            ]}
          />
        </>
      }
    >
      <Box aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
      <span className="truncate font-mono text-[12px] text-muted">{svc.composeService}</span>
      <span className="ml-auto shrink-0 text-[12px] text-muted">
        {orphan ? (
          'No checkout; only Open works'
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

export function DbRow({ svc, index, viaLabel, routeChanged, onEdit, onDelete }: RowProps<DbServiceMeta> & { viaLabel: string | null; routeChanged: boolean }) {
  const motionSafe = useMotionSafe()
  const { runtime } = useTunnel(svc.tunnelId ?? '')
  const state: TunnelState = (svc.tunnelId && runtime?.state) || 'stopped'
  const live = LIVE.includes(state)
  const port = runtime?.boundPort ?? svc.localPort
  const address = state === 'up' && port != null ? `127.0.0.1:${port}` : null
  const Icon = ENGINE_ICON[svc.dbEngine]
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast({ title: `Copied ${text}`, tone: 'success' }))
      .catch(() => {})

  return (
    <Row
      name={svc.name}
      index={index}
      actions={
        <>
          {address && (
            <span className="flex items-center gap-1">
              <span className="font-mono text-[12px] text-fg/90 tabular-nums">{address}</span>
              <button type="button" aria-label={`Copy ${address}`} onClick={() => void copy(address)} className={action}>
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
          <RowMenu
            label={`${svc.name} options`}
            items={[
              { label: 'Edit', icon: Pencil, run: onEdit },
              { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
            ]}
          />
        </>
      }
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate text-[13px] font-medium text-fg">{svc.name}</span>
      <span className="shrink-0 text-[12px] text-muted">{svc.dbEngine}</span>
      <span className="truncate font-mono text-[12px] text-muted">{`${svc.dbAddress}:${svc.dbPort}`}</span>
      {viaLabel && <span className="truncate text-[12px] text-muted">{`via ${viaLabel}`}</span>}
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
