import { motion } from 'framer-motion'
import { ArrowUpDown, Boxes, CopyPlus, Database, FolderGit2, GitBranch, Pencil, Plus, Rocket, Server, Tag } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DeploymentMeta } from '../../../../../shared/deploy'
import type { EnvironmentMeta } from '../../../../../shared/inventory'
import { pickAppHost, type AppServiceMeta, type DbServiceMeta, type ServiceKind, type ServiceMeta } from '../../../../../shared/services'
import { reorderServices, useDeploy, useDeployments, useServices } from '../../../deploy/store'
import type { InventoryData } from '../../../inventory/store'
import { Button } from '../../../ui/Button'
import { ConfirmDialog, RowMenu, type ConfirmRequest } from '../../../ui/common'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'
import { DeploymentDialog, type DeploymentRequest } from '../../deployments/DeploymentDialog'
import { DbRow, ServiceRow, shortSha } from './ServiceRow'
import { ServiceDialog, deleteRequest } from './ServiceDialog'

interface ServicesSectionProps {
  env: EnvironmentMeta
  data: InventoryData
  /** The next three are wired by Tasks 9 and 10 (the logs pane, Copy to… and the deploy picker); absent, their controls are hidden. */
  onDeploy?: (preselect: string[]) => void
  onLogs?: (svc: AppServiceMeta) => void
  onCopy?: () => void
}

type Editing = { kind: ServiceKind; service?: ServiceMeta }

/** The services of an environment, grouped by checkout, with the databases last. */
export function ServicesSection({ env, data, onDeploy, onLogs, onCopy }: ServicesSectionProps) {
  const services = useServices(env.id)
  const checkouts = useDeployments(env.id)
  const { routeChanged } = useDeploy()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [checkout, setCheckout] = useState<DeploymentRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [ordering, setOrdering] = useState<string[] | null>(null)

  const hostLabel = useMemo(() => new Map(data.hosts.map((h) => [h.id, h.label])), [data.hosts])
  const defaultVia = useMemo(
    () =>
      pickAppHost(
        env.hosts.map((m) => ({ hostId: m.hostId, role: m.role, label: hostLabel.get(m.hostId) ?? '' })),
        checkouts.map((d) => d.hostId),
      ),
    [env.hosts, hostLabel, checkouts],
  )

  const groups = useMemo(() => {
    const apps = services.filter((s): s is AppServiceMeta => s.kind === 'service')
    const known = new Set(checkouts.map((d) => d.id))
    return {
      checkouts: checkouts
        .map((d) => ({ checkout: d, items: apps.filter((s) => s.deploymentId === d.id) }))
        .filter((g) => g.items.length > 0),
      orphans: apps.filter((s) => s.deploymentId === null || !known.has(s.deploymentId)),
      dbs: services.filter((s): s is DbServiceMeta => s.kind === 'db'),
    }
  }, [services, checkouts])

  const ask = (svc: ServiceMeta) => setConfirm(deleteRequest(env, svc))
  const edit = (svc: ServiceMeta) => setEditing({ kind: svc.kind, service: svc })
  const add = (kind: ServiceKind) => setEditing({ kind })

  // One running index across the groups, so the cascade reads top to bottom.
  let index = 0
  const appRow = (s: AppServiceMeta) => (
    <ServiceRow key={s.id} svc={s} index={index++} onEdit={() => edit(s)} onDelete={() => ask(s)} onLogs={onLogs} onDeploy={onDeploy} />
  )

  return (
    <section aria-label="Services" className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-fg/90">
          Services
          <span className="min-w-5 rounded-full bg-white/[0.05] px-1.5 text-center text-[11px] leading-[18px] font-medium text-muted tabular-nums">
            {services.length}
          </span>
        </h3>
        <div className="ml-auto flex items-center gap-1">
          {onDeploy && (
            <Button size="sm" variant="ghost" icon={<Rocket aria-hidden className="size-3.5" />} onClick={() => onDeploy([])}>
              Deploy…
            </Button>
          )}
          <RowMenu
            label="Services options"
            items={[
              { label: 'Add service', icon: Plus, run: () => add('service') },
              { label: 'Add database', icon: Database, run: () => add('db') },
              ...(onCopy ? [{ label: 'Copy to…', icon: CopyPlus, run: onCopy }] : []),
              { label: 'New checkout', icon: FolderGit2, run: () => setCheckout({ kind: 'new', environmentId: env.id }) },
              ...(services.length > 1 ? [{ label: 'Reorder', icon: ArrowUpDown, run: () => setOrdering(services.map((s) => s.id)) }] : []),
            ]}
          />
        </div>
      </div>

      {ordering ? (
        <Reorder
          ids={ordering}
          names={new Map(services.map((s) => [s.id, s.name]))}
          onChange={setOrdering}
          onCancel={() => setOrdering(null)}
          onSave={(ids) => {
            setOrdering(null)
            void reorderServices(env.id, ids)
          }}
        />
      ) : services.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-8 text-center">
          <Boxes aria-hidden className="size-5 text-muted" strokeWidth={1.8} />
          <p className="text-[13px] font-medium text-fg">No services yet</p>
          <p className="text-[12.5px] text-muted">A service runs from a checkout; a database is reached through a tunnel.</p>
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => add('service')}>
              Add service
            </Button>
            <Button size="sm" variant="ghost" icon={<Database aria-hidden className="size-3.5" />} onClick={() => add('db')}>
              Add database
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.checkouts.map(({ checkout: d, items }) => (
            <section key={d.id} aria-label={d.name} className="rounded-xl border border-line bg-surface/70 p-1.5">
              <CheckoutHeader checkout={d} items={items} host={hostLabel.get(d.hostId) ?? 'Unknown host'} onEdit={() => setCheckout({ kind: 'edit', id: d.id })} />
              <ul className="flex flex-col gap-0.5">{items.map(appRow)}</ul>
            </section>
          ))}
          {groups.orphans.length > 0 && (
            <section aria-label="No checkout" className="rounded-xl border border-dashed border-line p-1.5">
              <GroupTitle>No checkout</GroupTitle>
              <ul className="flex flex-col gap-0.5">{groups.orphans.map(appRow)}</ul>
            </section>
          )}
          {groups.dbs.length > 0 && (
            <section aria-label="Databases" className="rounded-xl border border-line bg-surface/70 p-1.5">
              <GroupTitle>Databases</GroupTitle>
              <ul className="flex flex-col gap-0.5">
                {groups.dbs.map((s) => {
                  const via = s.viaHostId && env.hosts.some((m) => m.hostId === s.viaHostId) ? s.viaHostId : defaultVia
                  return (
                    <DbRow
                      key={s.id}
                      svc={s}
                      index={index++}
                      viaLabel={via ? (hostLabel.get(via) ?? null) : null}
                      routeChanged={!!routeChanged[s.id]}
                      onEdit={() => edit(s)}
                      onDelete={() => ask(s)}
                    />
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      {editing && <ServiceDialog env={env} kind={editing.kind} service={editing.service} onClose={() => setEditing(null)} />}
      <DeploymentDialog request={checkout} onClose={() => setCheckout(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}

function GroupTitle({ children }: { children: string }) {
  return <h4 className="px-2.5 pt-1.5 pb-1 text-[12px] font-semibold text-fg/80">{children}</h4>
}

function CheckoutHeader({ checkout: d, items, host, onEdit }: { checkout: DeploymentMeta; items: AppServiceMeta[]; host: string; onEdit: () => void }) {
  // Release ids are UUIDv7, so the greatest is the newest.
  const newest = items.reduce<AppServiceMeta | null>(
    (best, s) => (s.lastDeployedCommit && s.lastReleaseId && (!best || s.lastReleaseId > best.lastReleaseId!) ? s : best),
    null,
  )
  const meta = 'flex min-w-0 items-center gap-1 text-[12px] text-muted'
  return (
    <div className="group flex items-center gap-3 px-2.5 pt-1.5 pb-1">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="truncate text-[12.5px] font-semibold text-fg">{d.name}</h4>
          <span className="truncate font-mono text-[11.5px] text-muted">{d.repoUrl ?? d.repoPath}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className={meta}>
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="font-mono">{d.defaultBranch}</span>
          </span>
          {d.repoUrl && <span className="truncate font-mono text-[12px] text-muted">{d.repoPath}</span>}
          <span className={meta}>
            <Server aria-hidden className="size-3 shrink-0" />
            {host}
          </span>
          {newest && (
            <span data-testid="checkout-commit" title={newest.lastDeployedCommit!} className="font-mono text-[12px] text-fg/80 tabular-nums">
              {shortSha(newest.lastDeployedCommit!)}
            </span>
          )}
          <span className={meta}>
            <Tag aria-hidden className="size-3 shrink-0" />
            <span className="font-mono">{d.deployTag}</span>
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label={`Edit checkout ${d.name}`}
        title="Edit checkout"
        onClick={onEdit}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
      >
        <Pencil aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

/** Keyboard reorder: up and down move the focused service, enter saves, escape leaves it as it was. */
function Reorder({
  ids,
  names,
  onChange,
  onSave,
  onCancel,
}: {
  ids: string[]
  names: Map<string, string>
  onChange: (ids: string[]) => void
  onSave: (ids: string[]) => void
  onCancel: () => void
}) {
  const motionSafe = useMotionSafe()
  const refs = useRef(new Map<string, HTMLLIElement | null>())
  const onKeyDown = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      return onSave(ids)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      return onCancel()
    }
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!step) return
    e.preventDefault()
    const from = ids.indexOf(id)
    const to = from + step
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    ;[next[from], next[to]] = [next[to], next[from]]
    onChange(next)
    // Focus stays on the moved service.
    requestAnimationFrame(() => refs.current.get(id)?.focus())
  }
  return (
    <div className="rounded-xl border border-line bg-surface/70 p-1.5">
      <p className="px-2.5 pt-1 pb-1.5 text-[12px] text-muted">Up and down move the selected service; enter saves.</p>
      <ul role="listbox" aria-label="Service order" className="flex flex-col gap-0.5">
        {ids.map((id, i) => (
          <motion.li
            key={id}
            ref={(el: HTMLLIElement | null) => {
              refs.current.set(id, el)
            }}
            role="option"
            aria-selected={false}
            tabIndex={0}
            layout={motionSafe ? 'position' : false}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={motionSafe ? { ...spring, delay: staggerDelay(i) } : fast}
            onKeyDown={(e) => onKeyDown(e, id)}
            className="flex h-9 cursor-grab items-center rounded-lg px-3 text-[13px] text-fg outline-none focus-visible:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
          >
            {names.get(id)}
          </motion.li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 px-1 pt-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSave(ids)}>
          Save order
        </Button>
      </div>
    </div>
  )
}
