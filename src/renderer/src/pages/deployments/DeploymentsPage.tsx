import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Cloud, Copy, ExternalLink, GripVertical, Pencil, Plus, Rocket, TriangleAlert, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import type { DeploymentMeta } from '../../../../shared/deploy'
import { startLatestSync, useLatestReleases } from '../../deploy/latest'
import { pickerGroups } from '../../deploy/picker'
import { deleteDeployment, loadSettings, reorderDeployments, startDeploySync, useDeploy, useDeployments } from '../../deploy/store'
import { PendingNotice } from '../hub/shared'
import { isHubActive, startHubSync, useHub } from '../../hub/store'
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
import { EnvList, EnvListFilters, NewDeploymentMenu, TEAM_GROUP, envGroups, filterGroups } from './EnvList'
import { EnvSettingsSection } from './EnvSettingsSection'
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
  const { settings, tooling, loaded, deployments: allDeployments, services: allServices } = useDeploy()
  const [params, setParams] = useSearchParams()
  const [dialog, setDialog] = useState<DeploymentRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // `all` ticks every service (Deploy on a list row); the detail view's Deploy… starts with nothing ticked.
  const [deploying, setDeploying] = useState<{ envId: string; all: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [productId, setProductId] = useState('')

  useEffect(() => startDeploySync(), [])
  useEffect(() => startHubSync(), [])
  useEffect(() => startLatestSync(), [])
  const hub = useHub()
  const latest = useLatestReleases()
  const pending = hub.status.linked && hub.status.signedIn && hub.status.user?.status === 'pending'

  const environments = inventory?.environments
  const wanted = params.get('env')
  // Team environments this machine holds no copy of (published ones that are also local show under their product).
  const teamEnvs = useMemo(() => hub.catalog.filter((c) => !environments?.some((e) => e.id === c.environment.id)), [hub.catalog, environments])
  const hubEnv = teamEnvs.find((c) => c.environment.id === wanted)
  const env = useMemo(() => (hubEnv ? undefined : environments?.find((e) => e.id === wanted)), [environments, wanted, hubEnv])
  // No environment in the URL (or one that is gone): the list.
  const envId = env?.id ?? hubEnv?.environment.id ?? null
  // An environment in the URL that may still arrive, with the inventory or the team's catalog.
  const hubPending = !hub.statusLoaded || (isHubActive(hub.status) && !hub.catalogLoaded)
  const resolving = !!wanted && !envId && (!inventory || hubPending)
  const gone = !!wanted && !envId && !resolving
  useEffect(() => {
    if (gone) setParams({}, { replace: true })
  }, [gone, setParams])
  // The environment last open: its row takes focus when the list comes back.
  const [cameFrom, setCameFrom] = useState<string | null>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!envId) return
    setCameFrom(envId)
    title.current?.focus()
  }, [envId])
  const publishedLocal = !!env && hub.catalog.some((c) => c.environment.id === env.id)
  const envName = env?.name ?? hubEnv?.environment.name ?? ''
  const envProtected = env?.protected ?? hubEnv?.environment.protected ?? false
  const productName = hubEnv ? TEAM_GROUP : (inventory?.products.find((p) => p.id === env?.productId)?.name ?? '')
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
  // Opening an environment and going back to the list are history entries, so Back and Forward move between them.
  const openEnv = useCallback((id: string | null) => setParams(id ? { env: id } : {}), [setParams])
  // `?action=deploy` (from the palette) opens the wizard once, then leaves the URL.
  const action = params.get('action')
  useEffect(() => {
    if (action !== 'deploy' || !envId) return
    setDeploying({ envId, all: false })
    setParam('action', null)
  }, [action, envId, setParam])

  const deployments = useDeployments(envId)

  const envGroupsAll = useMemo(
    () => (inventory ? envGroups(inventory, teamEnvs, allDeployments, allServices, latest) : []),
    [inventory, teamEnvs, allDeployments, allServices, latest],
  )
  const shownGroups = useMemo(() => filterGroups(envGroupsAll, query, productId), [envGroupsAll, query, productId])
  const envCount = envGroupsAll.reduce((n, g) => n + g.rows.length, 0)

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

  // Deploy from the list ticks every service, and every checkout that has none.
  const wizardPick = useMemo(() => {
    if (!deploying?.all) return { services: [], checkouts: [] }
    const mine = allDeployments.filter((d) => d.environmentId === deploying.envId)
    const { groups: picked } = pickerGroups(
      allServices.filter((s) => s.environmentId === deploying.envId),
      mine,
      new Set(),
      new Set(),
    )
    return { services: picked.flatMap((g) => g.services.map((s) => s.id)), checkouts: picked.filter((g) => !g.services.length).map((g) => g.checkout.id) }
    // Fixed when the wizard opens: a list that refreshes underneath must not change what is ticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploying])

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

  const newDeployment = (id = envId) => id && setDialog({ kind: 'new', environmentId: id })
  const currentSettings = envId ? settings[envId] : undefined
  const listLoading = !inventory || !loaded

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
        {envId ? (
          <div className="flex min-w-0 items-baseline gap-3">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
            <button
              type="button"
              onClick={() => openEnv(null)}
              className="inline-flex items-center gap-1 rounded-md font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ArrowLeft aria-hidden className="size-3.5 self-center" />
              Deployments
            </button>
            <span aria-hidden className="text-muted/60">
              ›
            </span>
            <span className="truncate text-muted">{productName}</span>
            <span aria-hidden className="text-muted/60">
              ›
            </span>
            <h1 ref={title} tabIndex={-1} aria-current="page" className="truncate text-[19px] font-semibold tracking-tight text-fg focus:outline-none">
              {envName}
            </h1>
          </nav>
            {loaded && deployments.length > 0 && <p className="shrink-0 text-[12.5px] text-muted tabular-nums">{plural(deployments.length, 'deployment')}</p>}
          </div>
        ) : resolving ? (
          <Skeleton className="h-6 w-56 rounded-md" />
        ) : (
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="text-[19px] font-semibold tracking-tight text-fg">Deployments</h1>
            {!listLoading && envCount > 0 && <p className="truncate text-[12.5px] text-muted tabular-nums">{plural(envCount, 'environment')}</p>}
          </div>
        )}
        {envId ? (
          <div className="flex items-center gap-2">
            {(publishedLocal || hubEnv) && <HubLockBadge environmentId={envId} name={envName} guarded={envProtected} />}
            <Button size="sm" variant="ghost" icon={<Rocket aria-hidden className="size-3.5" />} disabled={!deployments.length} onClick={() => setDeploying({ envId, all: false })}>
              Deploy…
            </Button>
            {env && (
              <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => newDeployment()}>
                New deployment
              </Button>
            )}
          </div>
        ) : (
          !resolving &&
          envCount > 0 && (
            <div className="flex items-center gap-2">
              <EnvListFilters products={envGroupsAll} query={query} productId={productId} onQuery={setQuery} onProduct={setProductId} />
              <NewDeploymentMenu groups={envGroupsAll} onPick={(id) => newDeployment(id)} />
            </div>
          )
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-10">
        {tooling && tooling.ansibleStatus !== 'ok' && <ToolingBanner problems={tooling.problems} missing={tooling.ansibleStatus === 'missing'} />}
        {pending && <PendingNotice />}

        {!envId && resolving ? (
          <div data-testid="environment-loading" aria-busy className="flex flex-col gap-2 pt-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-11 rounded-[12px]" />
            ))}
          </div>
        ) : !envId ? (
          listLoading ? (
            <div data-testid="deployments-loading" className="flex flex-col gap-2 pt-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-[14px]" />
              ))}
            </div>
          ) : envCount === 0 ? (
            !pending && <EmptyState icon={Rocket} title="No environments yet" text="Deployments run in an environment. Create one on the Products page first." />
          ) : (
            <EnvList
              groups={shownGroups}
              query={query}
              productId={productId}
              onQuery={setQuery}
              onProduct={setProductId}
              onOpen={(id) => openEnv(id)}
              onDeploy={(id) => setDeploying({ envId: id, all: true })}
              onAddService={(id) => newDeployment(id)}
              focusEnvId={cameFrom}
            />
          )
        ) : (
          <>
            {publishedLocal && (
              <div>
                <Badge tone="success">
                  <Cloud aria-hidden className="size-3" />
                  Published to Hub
                </Badge>
              </div>
            )}
            <div>
              <Segmented size="sm" label="View" options={TABS} value={tab} onChange={(t) => setParam('tab', t === 'checkouts' ? null : t)} />
            </div>

            {tab === 'history' ? (
              <ReleaseHistory key={envId} environmentId={envId} />
            ) : !loaded || !inventory ? (
              <div data-testid="deployments-loading" className="flex flex-col gap-2 pt-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-11 rounded-[12px]" />
                ))}
              </div>
            ) : deployments.length === 0 ? (
              <EmptyState
                icon={Rocket}
                title={`No deployments in ${envName} yet`}
                text="A deployment is a git checkout on one of this environment's hosts, brought up with Docker Compose."
                action={env ? { label: 'New deployment', run: () => newDeployment() } : undefined}
              />
            ) : (
              // Keyed by environment: switching swaps the list at once, with nothing animating out.
              <div key={envId} className="flex flex-col gap-5">
                {groups.map((g) => (
                  <section key={g.hostId} aria-label={g.label}>
                    <div className="mb-2 flex items-center gap-2.5">
                      <h2 className="text-[12.5px] font-semibold tracking-tight text-fg/90">{g.label}</h2>
                      {g.address && <span className="font-mono text-[11.5px] text-muted">{g.address}</span>}
                      <span aria-hidden className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
                    </div>
                    <ul className="flex flex-col gap-1.5">
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

            <EnvSettingsSection key={`settings-${envId}`} envId={envId} settings={currentSettings} environment={env} deployments={deployments} loaded={loaded} />
          </>
        )}
      </div>

      <DeploymentDialog request={dialog} onClose={() => setDialog(null)} />
      {deploying && (
        <DeployWizard
          key={deploying.envId}
          environmentId={deploying.envId}
          preselect={wizardPick.services}
          preselectCheckouts={wizardPick.checkouts}
          onClose={() => setDeploying(null)}
        />
      )}
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
  const pathId = useId()

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
      aria-describedby={pathId}
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
        className={`group relative flex h-11 items-center gap-2.5 rounded-[12px] border bg-surface/70 pr-2 pl-1.5 transition-colors hover:bg-surface ${
          over ? 'border-accent/60' : 'border-line'
        }`}
      >
        <button
          type="button"
          aria-label={`Reorder ${d.name}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title="Drag, or press Alt with the up or down arrow"
          disabled={(first && last) || readOnly}
          className="grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-muted/70 transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-default disabled:opacity-30"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-muted">
          <h3 title={d.repoPath} className="max-w-[40%] min-w-0 truncate text-[13px] font-semibold text-fg">
            {d.name}
          </h3>
          <span id={pathId} className="sr-only">
            {d.repoPath}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate font-mono text-fg/80">
            {d.defaultBranch} <span aria-hidden>→</span>{' '}
            <span className="sr-only">to</span> {d.deployTag}
          </span>
          <span aria-hidden>·</span>
          <span className="shrink-0">sudo {d.useSudo}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{plural(d.urls.length, 'URL')}</span>
          {d.dbBackup && <Badge tone="success">Backup</Badge>}
          {d.managedEnv && <Badge tone="info">Managed .env</Badge>}
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
