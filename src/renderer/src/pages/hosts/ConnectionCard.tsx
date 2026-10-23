import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { ChevronRight, CircleAlert, Globe, KeyRound, Network, Route, Timer, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DEFAULT_KEEPALIVE_SEC } from '../../../../shared/ssh'
import type { IdentityRef, InheritConflict, ResolvedHost, ValueSource } from '../../../../shared/inventory'
import { addressSourceLabel, sourceLabel } from '../../inventory/choices'
import { useInventory, type InventoryData } from '../../inventory/store'
import { api } from '../../lib/api'
import { errorText } from '../../ui/common'
import { exitFast, fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { LoginDialog } from './LoginDialog'

const CONFLICT_NOUN: Record<InheritConflict['field'], string> = { identity: 'identity', port: 'port', jumpHost: 'jump host' }
const YOUR_KEYS = 'Your SSH keys (agent, then ~/.ssh keys)'
const AUTH_LABEL: Record<IdentityRef['auth'], string> = {
  agent: YOUR_KEYS,
  key: 'SSH key',
  password: 'Password',
  default: YOUR_KEYS,
}

/** "jump host loop: web-1 → a → b → a": b's jump host closes the loop, so b is the hop to change. */
export function errorHint(message: string): string | null {
  const loop = /^jump host loop: (.+)$/.exec(message)
  if (loop) {
    const hops = loop[1].split(' → ')
    const closer = hops[hops.length - 2]
    return closer ? `${closer} jumps back to ${hops[hops.length - 1]}. Change the jump host on ${closer}, or on its environment.` : null
  }
  if (message.startsWith('jump chain is longer')) return 'Point one of the hops straight at a bastion to shorten the route.'
  return null
}

/**
 * Everything the resolution reads: the host, its environments, every host its route can pass
 * through (with their environments) and the identities they name. A change to any of them re-resolves.
 */
function dependencyStamp(data: InventoryData | null, hostId: string): string {
  if (!data) return ''
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const envsOf = (id: string) => data.environments.filter((e) => e.hosts.some((m) => m.hostId === id))
  const seen = new Set<string>()
  for (const queue = [hostId]; queue.length; ) {
    const h = hostById.get(queue.pop()!)
    if (!h || seen.has(h.id)) continue
    seen.add(h.id)
    for (const next of [h.jumpHostId, ...envsOf(h.id).map((e) => e.defaultJumpHostId)]) if (next) queue.push(next)
  }
  const hosts = [...seen].map((id) => hostById.get(id)!)
  const envs = data.environments.filter((e) => e.hosts.some((m) => seen.has(m.hostId)))
  const identityIds = new Set([...hosts.map((h) => h.identityId), ...envs.map((e) => e.defaultIdentityId)])
  return JSON.stringify([hosts, envs, data.identities.filter((i) => identityIds.has(i.id))])
}

/** The host's own setting, or the app default it falls back to. */
const keepaliveText = (sec: number | null) =>
  sec === null ? `${DEFAULT_KEEPALIVE_SEC} s (default)` : sec === 0 ? 'off' : `${sec} s`

/** `key` is the context the result was resolved for, so a switch can tell the old answer from the new. */
type State = { kind: 'loading' } | { kind: 'ok'; key: string; value: ResolvedHost } | { kind: 'error'; key: string; message: string }

interface ConnectionCardProps {
  hostId: string
  environmentId?: string
  /** Told whenever the card looks from a different environment (null is outside any). */
  onContextChange?: (environmentId: string | null) => void
}

export function ConnectionCard({ hostId, environmentId, onContextChange }: ConnectionCardProps) {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const self = data?.hosts.find((h) => h.id === hostId)
  const memberEnvs = useMemo(
    () =>
      (self?.environments ?? [])
        .flatMap((m) => data?.environments.filter((e) => e.id === m.environmentId) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name)),
    [self, data],
  )
  const [context, setContext] = useState<string | null>(environmentId ?? null)
  useEffect(() => setContext(environmentId ?? null), [hostId, environmentId])
  // Leaving the environment the card was looking from drops back to "outside".
  const ctx = context && memberEnvs.some((e) => e.id === context) ? context : null

  const report = useRef(onContextChange)
  report.current = onContextChange
  useEffect(() => report.current?.(ctx), [ctx])

  const [state, setState] = useState<State>({ kind: 'loading' })
  const stamp = useMemo(() => dependencyStamp(data, hostId), [data, hostId])
  const key = ctx ?? ''

  useEffect(() => {
    let live = true
    api
      .invoke('host:resolve', hostId, ...(ctx ? [ctx] : []))
      .then(
        (value) =>
          live && setState(value ? { kind: 'ok', key: ctx ?? '', value } : { kind: 'error', key: ctx ?? '', message: "Couldn't work out how to reach this host." }),
      )
      .catch((err: unknown) => live && setState({ kind: 'error', key: ctx ?? '', message: errorText(err) }))
    return () => {
      live = false
    }
  }, [hostId, ctx, stamp])

  // After a context switch the old answer stays, dimmed, until the new one lands; an old error just goes.
  const stale = state.kind !== 'loading' && state.key !== key
  const error = state.kind === 'error' && !stale ? state.message : null
  const resolved = state.kind === 'ok' ? state.value : null
  // Chips name the environment the values came from, which is the one they were resolved in.
  const sourceEnv = data?.environments.find((e) => e.id === resolved?.environmentId)
  const chip = (source: ValueSource | null) => (
    <SourceChip source={source} label={sourceLabel(source, sourceEnv?.name)} color={source === 'environment' ? sourceEnv?.color : undefined} />
  )
  const route = resolved ? [...resolved.chain.map((h) => h.label), self?.label ?? resolved.address] : []
  const [changing, setChanging] = useState(false)
  const fromSshConfig = resolved?.identity.source === 'global' && resolved.identity.userSource === 'ssh-config'

  return (
    <section aria-label="Connection" aria-busy={state.kind === 'loading' || stale || undefined} className="overflow-hidden rounded-xl border border-line bg-surface/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5">
        <h3 className="text-[12.5px] font-semibold text-fg/90">How CredOps connects</h3>
        <LayoutGroup id={`ctx-${hostId}`}>
          <div role="radiogroup" aria-label="Context" className="flex flex-wrap gap-0.5 rounded-lg bg-canvas/60 p-0.5">
            <Segment checked={!ctx} onSelect={() => setContext(null)} label="Outside any environment" />
            {memberEnvs.map((e) => (
              <Segment key={e.id} checked={ctx === e.id} onSelect={() => setContext(e.id)} label={e.name} color={e.color} />
            ))}
          </div>
        </LayoutGroup>
      </div>

      {error ? (
        <div role="alert" className="flex items-start gap-3 px-4 py-4">
          <span className="tone-soft inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium" style={{ '--tone': 'var(--err)' } as CSSProperties}>
            <CircleAlert aria-hidden className="size-3.5" />
            Can't resolve
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="font-mono text-[12.5px] break-words text-fg/90">{error}</p>
            {errorHint(error) && <p className="mt-1 text-[12px] text-muted">{errorHint(error)}</p>}
          </div>
        </div>
      ) : (
        <dl className={`divide-y divide-line/60 transition-opacity duration-150 ${stale ? 'opacity-55' : ''}`}>
          <Row
            icon={Globe}
            term="Address"
            loading={!resolved}
            chip={
              resolved && (
                <SourceChip
                  source={resolved.addressSource === 'domain' ? 'environment' : 'host'}
                  label={addressSourceLabel(resolved.addressSource, sourceEnv?.name)}
                  color={resolved.addressSource === 'domain' ? sourceEnv?.color : undefined}
                />
              )
            }
          >
            {resolved && (
              <Value id={`a:${resolved.address}`}>
                <span className="font-mono text-fg">{resolved.address}</span>
              </Value>
            )}
          </Row>
          <Row
            icon={UserRound}
            term="User"
            loading={!resolved}
            chip={resolved && (fromSshConfig ? <SourceChip source="global" label="From ~/.ssh/config" /> : chip(resolved.identity.source))}
            action={
              resolved &&
              self && (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => setChanging(true)}
                  className="rounded-md px-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10"
                >
                  Change
                </button>
              )
            }
          >
            {resolved && (
              <Value id={`u:${resolved.identity.username}:${resolved.identity.source}`}>
                <span className="font-mono text-fg">{resolved.identity.username}</span>
                <span className="ml-2 inline-flex items-center gap-1 text-[12px] text-muted">
                  <KeyRound aria-hidden className="size-3" />
                  {resolved.identity.source === 'global' ? '' : `${resolved.identity.label}, `}
                  {AUTH_LABEL[resolved.identity.auth]}
                </span>
              </Value>
            )}
          </Row>
          <Row icon={Network} term="Port" loading={!resolved} chip={resolved && chip(resolved.port.source)}>
            {resolved && (
              <Value id={`p:${resolved.port.value}`}>
                <span className="font-mono text-fg tabular-nums">{resolved.port.value}</span>
              </Value>
            )}
          </Row>
          <Row icon={Route} term="Jump via" loading={!resolved} chip={resolved && (resolved.chain.length ? chip(resolved.jump.source) : null)}>
            {resolved && (
              <Value id={`j:${route.join('>')}`}>
                {resolved.chain.length === 0 ? (
                  <span className="text-muted">Direct, no jump host</span>
                ) : (
                  <ol aria-label={route.join(' → ')} className="flex flex-wrap items-center gap-1">
                    {route.map((label, i) => (
                      <motion.li
                        key={`${i}:${label}`}
                        initial={motionSafe ? { opacity: 0, x: -6 } : { opacity: 0 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={motionSafe ? { ...spring, delay: staggerDelay(i, 0.04) } : fast}
                        className="flex items-center gap-1"
                      >
                        {i > 0 && <ChevronRight aria-hidden className="size-3 text-muted" />}
                        <span
                          className={`rounded-md px-1.5 font-mono text-[12px] leading-5 ${
                            i === route.length - 1 ? 'bg-accent/14 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_40%,transparent)]' : 'bg-white/[0.05] text-fg/85'
                          }`}
                        >
                          {label}
                        </span>
                      </motion.li>
                    ))}
                  </ol>
                )}
              </Value>
            )}
          </Row>
          {self && (
            <Row icon={Timer} term="Keepalive" loading={false} chip={null}>
              <Value id={`k:${self.keepaliveSec}`}>
                <span className="font-mono text-fg tabular-nums">{keepaliveText(self.keepaliveSec)}</span>
              </Value>
            </Row>
          )}
        </dl>
      )}

      <AnimatePresence initial={false}>
        {resolved?.conflicts.map((c) => (
          <motion.p
            key={c.field}
            initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fast}
            className="flex items-center gap-2 border-t border-warn/25 bg-warn/[0.07] px-4 py-2 text-[12.5px] text-warn"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {`Environments disagree on the ${CONFLICT_NOUN[c.field]}. Set it on this host.`}
          </motion.p>
        ))}
      </AnimatePresence>
      {self && resolved && (
        <LoginDialog
          open={changing}
          host={self}
          current={resolved.identity}
          inheritedFrom={resolved.identity.source === 'environment' ? sourceEnv?.name : undefined}
          onClose={() => setChanging(false)}
        />
      )}
    </section>
  )
}

function Segment({ checked, onSelect, label, color }: { checked: boolean; onSelect: () => void; label: string; color?: string }) {
  const motionSafe = useMotionSafe()
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`relative flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${checked ? 'text-fg' : 'text-muted hover:text-fg'}`}
    >
      {checked && (
        <motion.span
          layoutId={motionSafe ? 'ctx-pill' : undefined}
          transition={spring}
          className="absolute inset-0 rounded-md bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]"
        />
      )}
      {color && <span aria-hidden className="relative size-1.5 rounded-full" style={{ background: color, boxShadow: checked ? `0 0 8px ${color}` : undefined }} />}
      <span className="relative">{label}</span>
    </button>
  )
}

function Row({
  icon: Icon,
  term,
  loading,
  chip,
  action,
  children,
}: {
  icon: LucideIcon
  term: string
  loading: boolean
  chip: ReactNode
  /** A small action after the chip, e.g. "Change". */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={term} className="grid grid-cols-[104px_1fr_auto] items-center gap-3 px-4 py-2.5">
      <dt className="flex items-center gap-1.5 text-[12px] text-muted">
        <Icon aria-hidden className="size-3.5" />
        {term}
      </dt>
      <dd className="relative min-w-0 text-[13px]">
        {loading ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            {children}
          </AnimatePresence>
        )}
      </dd>
      <dd className="flex items-center justify-end gap-2">
        <AnimatePresence mode="popLayout" initial={false}>
          {chip}
        </AnimatePresence>
        {action}
      </dd>
    </div>
  )
}

/** One value; a new `id` cross-fades in over the old one. */
function Value({ id, children }: { id: string; children: ReactNode }) {
  const motionSafe = useMotionSafe()
  return (
    <motion.div
      key={id}
      data-value
      initial={motionSafe ? { opacity: 0, y: 6 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
      exit={motionSafe ? { opacity: 0, y: -6, transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      className="flex min-w-0 flex-wrap items-center"
    >
      {children}
    </motion.div>
  )
}

/** Where a value came from: this host in accent, an environment in its own color, the app default muted. */
export function SourceChip({ source, label, color }: { source: ValueSource | null; label: string; color?: string }) {
  const motionSafe = useMotionSafe()
  const tone = source === 'host' ? 'var(--accent)' : source === 'environment' ? (color ?? 'var(--accent)') : 'var(--muted)'
  return (
    <motion.span
      key={`${source}:${label}`}
      initial={motionSafe ? { opacity: 0, scale: 0.9 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, scale: 1 } : { opacity: 1 }}
      exit={{ opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      style={{ '--tone': tone } as CSSProperties}
      className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11.5px] leading-none font-medium whitespace-nowrap ${
        source === 'global' || source === null ? 'bg-white/[0.05] text-muted' : 'tone-soft'
      }`}
    >
      {source === 'environment' && <span aria-hidden className="size-1.5 rounded-full bg-(--tone)" />}
      {label}
    </motion.span>
  )
}
