import { AnimatePresence, motion } from 'framer-motion'
import { Cloud, Copy, ExternalLink, GripVertical, Pencil, Plus, Rocket, TriangleAlert, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import type { DeploymentMeta } from '../../../../shared/deploy'
import type { HubCatalogEnv } from '../../../../shared/hub'
import { deleteDeployment, loadSettings, reorderDeployments, startDeploySync, useDeploy, useDeployments } from '../../deploy/store'
import { PendingNotice } from '../hub/shared'
import { startHubSync, useHub } from '../../hub/store'
import { useInventory } from '../../inventory/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, RowMenu, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { useMotionSafe } from '../../ui/motion'
import { Segmented } from '../../ui/Segmented'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { HubLockBadge } from './HubLockBadge'
import { DeploymentDialog, type DeploymentRequest } from './DeploymentDialog'
import { EnvDeploySettings } from './EnvDeploySettings'
import { DeployWizard } from './release/DeployWizard'
import { ReleaseHistory } from './release/ReleaseHistory'

const ANSIBLE_DOCS = 'https://docs.ansible.com/ansible/latest/installation_guide/'
const INSTALL_COMMAND = 'brew install ansible'

/** Enter 150 ms, exit 100 ms, stagger capped at 150 ms in total. */
const ENTER = 0.15
const EXIT = 0.1
const STAGGER_CAP = 0.15

type Tab = 'checkouts' | 'history'
const TABS = [
  { id: 'checkouts', label: 'Checkouts' },
  { id: 'history', label: 'History' },
] as const

interface HostGroup {
  hostId: string
  label: string
  address?: string
  items: DeploymentMeta[]
}

export function DeploymentsPage() {
  const inventory = useInventory()
  const { settings, tooling, loaded } = useDeploy()
  const [params, setParams] = useSearchParams()
  const [dialog, setDialog] = useState<DeploymentRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [deploying, setDeploying] = useState(false)

  useEffect(() => startDeploySync(), [])
  useEffect(() => startHubSync(), [])
  const hub = useHub()
  const pending = hub.status.linked && hub.status.signedIn && hub.status.user?.status === 'pending'

  const environments = inventory?.environments
  const wanted = params.get('env')
  // Team environments this machine holds no copy of (published ones that are also local show under their product).
  const teamEnvs = useMemo(() => hub.catalog.filter((c) => !environments?.some((e) => e.id === c.environment.id)), [hub.catalog, environments])
  const hubEnv = teamEnvs.find((c) => c.environment.id === wanted) ?? (environments && !environments.length ? teamEnvs[0] : undefined)
  const env = useMemo(() => {
    if (hubEnv || !environments?.length) return undefined
    return environments.find((e) => e.id === wanted) ?? environments[0]
  }, [environments, wanted, hubEnv])
  const envId = env?.id ?? hubEnv?.environment.id ?? null
  const publishedLocal = !!env && hub.catalog.some((c) => c.environment.id === env.id)
  const envName = env?.name ?? hubEnv?.environment.name ?? ''
  const envProtected = env?.protected ?? hubEnv?.environment.protected ?? false
  useEffect(() => {
    if (envId) void loadSettings(envId)
  }, [envId])
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'checkouts'
  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (p) => {
          const out = new URLSearchParams(p)
          if (value === null) out.delete(key)
          else out.set(key, value)
          return out
        },
        { replace: true },
      ),
    [setParams],
  )
  // `?action=deploy` (from the palette) opens the wizard once, then leaves the URL.
  const action = params.get('action')
  useEffect(() => {
    if (action !== 'deploy' || !envId) return
    setDeploying(true)
    setParam('action', null)
  }, [action, envId, setParam])

  const deployments = useDeployments(envId)
  const select = useCallback((id: string) => setParam('env', id), [setParam])

  const groups = useMemo<HostGroup[]>(() => {
    const hosts = new Map<string, { label: string; address?: string }>(inventory?.hosts.map((h) => [h.id, h]))
    for (const h of hubEnv?.hosts ?? []) if (!hosts.has(h.id)) hosts.set(h.id, { label: h.label })
    const byHost = new Map<string, HostGroup>()
    for (const d of deployments) {
      const h = hosts.get(d.hostId)
      const g = byHost.get(d.hostId) ?? { hostId: d.hostId, label: h?.label ?? 'Unknown host', address: h?.address, items: [] }
      byHost.set(d.hostId, g)
      g.items.push(d)
    }
    return [...byHost.values()]
  }, [deployments, inventory, hubEnv])

  const move = useCallback(
    (id: string, to: { before: string } | { step: -1 | 1 }) => {
      const ids = deployments.map((d) => d.id)
      const from = ids.indexOf(id)
      if (from < 0) return
      const next = [...ids]
      if ('step' in to) {
        // Within the host's group: swap with its neighbour there, whatever sits between them in the environment.
        const group = deployments.filter((d) => d.hostId === deployments[from].hostId).map((d) => d.id)
        const at = group.indexOf(id) + to.step
        if (at < 0 || at >= group.length) return
        const other = next.indexOf(group[at])
        ;[next[from], next[other]] = [next[other], next[from]]
      } else {
        const target = next.indexOf(to.before)
        if (target < 0 || target === from) return
        next.splice(from, 1)
        next.splice(next.indexOf(to.before), 0, id)
      }
      if (next.every((v, i) => v === ids[i])) return
      void reorderDeployments(envId!, next)
    },
    [deployments, envId],
  )

  const askDelete = useCallback(
    (d: DeploymentMeta) => {
      const guarded = envProtected ? envName : undefined
      setConfirm({
        title: `Delete ${d.name}?`,
        description: guarded
          ? `${guarded} is protected. Deleting a deployment removes its configuration and keeps its release history.`
          : 'This removes the deployment configuration and keeps its release history.',
        confirmLabel: 'Delete deployment',
        typeToConfirm: guarded,
        run: () => deleteDeployment(d.id),
      })
    },
    [envProtected, envName],
  )

  const newDeployment = () => envId && setDialog({ kind: 'new', environmentId: envId })
  const currentSettings = envId ? settings[envId] : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-fg">Deployments</h1>
          {loaded && envId && deployments.length > 0 && (
            <p className="truncate text-[12.5px] text-muted tabular-nums">{plural(deployments.length, 'deployment')}</p>
          )}
        </div>
        {envId && (
          <div className="flex items-center gap-2">
            {(publishedLocal || hubEnv) && <HubLockBadge environmentId={envId} name={envName} guarded={envProtected} />}
            <Button size="sm" variant="ghost" icon={<Rocket aria-hidden className="size-3.5" />} disabled={!deployments.length} onClick={() => setDeploying(true)}>
              Deploy…
            </Button>
            {env && (
              <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={newDeployment}>
                New deployment
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-10">
        {tooling && tooling.ansibleStatus !== 'ok' && <ToolingBanner problems={tooling.problems} missing={tooling.ansibleStatus === 'missing'} />}

        {inventory && !envId ? (
          <>
            {pending && <PendingNotice />}
            {!pending && <EmptyState icon={Rocket} title="No environments yet" text="Deployments run in an environment. Create one on the Products page first." />}
          </>
        ) : (
          <>
            {inventory && envId && <EnvPicker data={inventory} selected={envId} onSelect={select} team={teamEnvs} />}
            {pending && <PendingNotice />}
            {publishedLocal && (
              <div>
                <Badge tone="success">
                  <Cloud aria-hidden className="size-3" />
                  Published to Hub
                </Badge>
              </div>
            )}
            {envId && <EnvDeploySettings settings={currentSettings} />}
            {envId && (
              <div>
                <Segmented size="sm" label="View" options={TABS} value={tab} onChange={(t) => setParam('tab', t === 'checkouts' ? null : t)} />
              </div>
            )}

            {envId && tab === 'history' ? (
              <ReleaseHistory key={envId} environmentId={envId} />
            ) : !loaded || !inventory ? (
              <div data-testid="deployments-loading" className="flex flex-col gap-3 pt-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-[92px] rounded-[14px]" />
                ))}
              </div>
            ) : envId && deployments.length === 0 ? (
              <EmptyState
                icon={Rocket}
                title={`No deployments in ${envName} yet`}
                text="A deployment is a git checkout on one of this environment's hosts, brought up with Docker Compose."
                action={env ? { label: 'New deployment', run: newDeployment } : undefined}
              />
            ) : (
              // Keyed by environment: switching swaps the list at once, with nothing animating out.
              <div key={envId} className="flex flex-col gap-6">
                {groups.map((g) => (
                  <section key={g.hostId} aria-label={g.label}>
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <h2 className="text-[12.5px] font-semibold tracking-tight text-fg/90">{g.label}</h2>
                      {g.address && <span className="font-mono text-[11.5px] text-muted">{g.address}</span>}
                      <span aria-hidden className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
                    </div>
                    <ul className="flex flex-col gap-2">
                      <AnimatePresence initial={false}>
                        {g.items.map((d, i) => (
                          <DeploymentCard
                            key={d.id}
                            deployment={d}
                            index={i}
                            first={i === 0}
                            last={i === g.items.length - 1}
                            onMove={move}
                            readOnly={!env}
                            onEdit={() => setDialog({ kind: 'edit', id: d.id })}
                            onDelete={() => askDelete(d)}
                          />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <DeploymentDialog request={dialog} onClose={() => setDialog(null)} />
      {deploying && envId && <DeployWizard key={envId} environmentId={envId} preselect={[]} onClose={() => setDeploying(false)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function ToolingBanner({ problems, missing }: { problems: string[]; missing: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(missing ? INSTALL_COMMAND : problems.join('\n'))
      setCopied(true)
      toast({ title: 'Copied', tone: 'success' })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: "Couldn't copy", tone: 'error' })
    }
  }
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        {problems.map((p) => (
          <p key={p} className="text-[13px] leading-5 text-fg">
            {p}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Copy aria-hidden className="size-3.5" />} onClick={() => void copy()}>
          {copied ? 'Copied' : missing ? 'Copy install command' : 'Copy'}
        </Button>
        <a
          href={ANSIBLE_DOCS}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-accent hover:underline"
        >
          Docs
          <ExternalLink aria-hidden className="size-3" />
        </a>
      </div>
    </div>
  )
}

function EnvPicker({ data, selected, onSelect, team }: { data: NonNullable<ReturnType<typeof useInventory>>; selected: string; onSelect: (id: string) => void; team: HubCatalogEnv[] }) {
  const groups = useMemo(() => {
    const byId = new Map(data.environments.map((e) => [e.id, e]))
    const placed = new Set<string>()
    const out = data.products.flatMap((p) => {
      const envs = p.environmentIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      envs.forEach((e) => placed.add(e.id))
      return envs.length ? [{ id: p.id, name: p.name, envs }] : []
    })
    const loose = data.environments.filter((e) => !placed.has(e.id))
    return loose.length ? [...out, { id: 'other', name: 'No product', envs: loose }] : out
  }, [data])
  return (
    <nav aria-label="Environment" className="flex flex-wrap gap-x-6 gap-y-2">
      {groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.name} className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium text-muted">{g.name}</span>
          <div className="flex gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5">
            {g.envs.map((e) => (
              <EnvPill key={e.id} env={e} on={e.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ))}
      {team.length > 0 && (
        <div role="group" aria-label="Team (Hub)" className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[11.5px] font-medium text-muted">
            <Cloud aria-hidden className="size-3" />
            Team (Hub)
          </span>
          <div className="flex gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5">
            {team.map((c) => (
              <EnvPill key={c.environment.id} env={{ id: c.environment.id, name: c.environment.name, hub: true }} on={c.environment.id === selected} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </nav>
  )
}

function EnvPill({ env, on, onSelect }: { env: { id: string; name: string; color?: string; hub?: boolean }; on: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onSelect(env.id)}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors ${
        on ? 'bg-white/[0.08] text-fg shadow-[inset_0_0_0_1px_var(--border)]' : 'text-muted hover:text-fg'
      }`}
    >
      {env.hub ? <Cloud aria-hidden className="size-3" /> : <span aria-hidden className="size-1.5 rounded-full" style={{ background: env.color }} />}
      {env.name}
    </button>
  )
}

interface CardProps {
  deployment: DeploymentMeta
  index: number
  first: boolean
  last: boolean
  onMove: (id: string, to: { before: string } | { step: -1 | 1 }) => void
  onEdit: () => void
  onDelete: () => void
  /** Team environments are changed only where they are published from. */
  readOnly?: boolean
}

const DRAG_TYPE = 'application/x-opsdeck-deployment'

function DeploymentCard({ deployment: d, index, first, last, onMove, onEdit, onDelete, readOnly }: CardProps) {
  const motionSafe = useMotionSafe()
  const [over, setOver] = useState(false)

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    e.stopPropagation()
    onMove(d.id, { step: e.key === 'ArrowUp' ? -1 : 1 })
  }
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, d.id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const id = e.dataTransfer.getData(DRAG_TYPE)
    if (id && id !== d.id) onMove(id, { before: d.id })
  }

  // Reduced motion animates opacity only: no transform is ever set on the card.
  return (
    <motion.li
      aria-label={d.name}
      layout={motionSafe ? 'position' : false}
      initial={motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: EXIT } }}
      // The stagger delays the enter only: a reordered card's layout move starts at once.
      transition={{ duration: ENTER, opacity: { duration: ENTER, delay: Math.min(index * 0.03, STAGGER_CAP) }, y: { duration: ENTER, delay: Math.min(index * 0.03, STAGGER_CAP) } }}
    >
      {/* The native drag handlers sit on a plain element: framer-motion's own onDragStart means something else. */}
      <div
        draggable={!readOnly}
        onDragStart={onDragStart}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault()
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        className={`group relative flex items-start gap-3 rounded-[14px] border bg-surface/70 px-3 py-3 transition-colors hover:bg-surface ${
          over ? 'border-accent/60' : 'border-line'
        }`}
      >
      <button
        type="button"
        aria-label={`Reorder ${d.name}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title="Drag, or press Alt with the up or down arrow"
        disabled={(first && last) || readOnly}
        className="mt-0.5 grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-muted/70 transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-default disabled:opacity-30"
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="truncate text-[14px] font-semibold text-fg">{d.name}</h3>
          {d.composeProject && (
            <span title="Compose project" className="rounded-md bg-white/[0.05] px-1.5 font-mono text-[11.5px] leading-5 text-muted">
              {d.composeProject}
            </span>
          )}
        </div>
        <p className="mt-1 truncate font-mono text-[12px] text-muted">{d.repoPath}</p>
        <p className="mt-0.5 font-mono text-[12px] text-fg/80">
          {d.defaultBranch} <span aria-hidden>→</span> <span className="sr-only">to</span> {d.deployTag}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {d.dbBackup && <Badge tone="success">Backup</Badge>}
          {d.managedEnv && <Badge tone="info">Managed .env</Badge>}
          <Badge tone="info">sudo {d.useSudo}</Badge>
          <Badge tone="info">{plural(d.urls.length, 'URL')}</Badge>
        </div>
      </div>
      {!readOnly && (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit}>
            Edit
          </Button>
          <RowMenu label={`${d.name} options`} items={[{ label: 'Delete', icon: Trash2, run: onDelete, danger: true }]} />
        </div>
      )}
      </div>
    </motion.li>
  )
}
