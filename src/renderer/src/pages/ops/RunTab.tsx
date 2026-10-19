import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, History, Minus, Play, Plus, RotateCcw, Search, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { HOST_ROLES, type HostRole } from '../../../../shared/inventory'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RUN_TIMEOUT_SEC,
  DESTRUCTIVE_PATTERN,
  MAX_CONCURRENCY,
  MAX_RUNS_KEPT,
  type RunHostMeta,
  type RunHostState,
  type RunRequest,
  type RunSummary,
} from '../../../../shared/ops'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { HostChip, STATE_WORD, isLive } from '../../ops/HostChip'
import { OutputPane } from '../../ops/OutputPane'
import { runProtection } from '../../ops/protect'
import {
  appendOutput,
  rememberRequest,
  removeRun,
  requestFor,
  runOutputStore,
  runStore,
  selectRun,
  showRunView,
  upsertRun,
  type HostOutput,
} from '../../ops/runs'
import { loadSnippets, snippetStore } from '../../ops/snippets'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { isMac } from '../../ui/shortcuts'

type TargetMode = 'environment' | 'hosts'
type CommandMode = 'text' | 'snippet'
type Role = HostRole | 'all'
type Layout = 'grouped' | 'interleaved'

const TIMEOUTS = [
  { sec: 30, label: '30 seconds' },
  { sec: 60, label: '1 minute' },
  { sec: 300, label: '5 minutes' },
  { sec: 600, label: '10 minutes' },
  { sec: 1800, label: '30 minutes' },
  { sec: 3600, label: '1 hour' },
]
/** How long typing in a variable waits before main checks the template. */
const RENDER_DELAY_MS = 300
/** Labels a confirmation names before "and N more". */
const NAMED = 5
const CANCELLED_NOTE = 'Cancelled (the command may still be running on the host)'

const isBad = (s: RunHostState) => s === 'failed' || s === 'timeout'

/** "db-1, db-2, web-1, web-2, web-3 and 3 more" */
function namesOf(labels: readonly string[]): string {
  const shown = labels.slice(0, NAMED).join(', ')
  return labels.length > NAMED ? `${shown} and ${labels.length - NAMED} more` : shown
}

/** The typed-name confirmation for a run; `run` sends the request with the name as `confirm`. */
function confirmFor(env: string, labels: readonly string[], run: (confirm: string) => Promise<unknown>): ConfirmRequest {
  return {
    title: `Run on ${plural(labels.length, 'host')} in ${env}?`,
    description: namesOf(labels),
    confirmLabel: 'Run',
    typeToConfirm: env,
    run: () => run(env),
  }
}

/** Starts a run and shows it; main's refusal (or any failure) is a toast. */
async function launch(req: RunRequest): Promise<void> {
  const run = await attempt("Couldn't start the run", () => api.invoke('runs:start', req))
  if (!run) return
  rememberRequest(run.id, req)
  upsertRun(run)
  selectRun(run.id)
}

/** Ticks every second while `live`, for elapsed timers. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  return now
}

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(s / 60)
  if (mm === 0) return `${s}s`
  const pad = (n: number) => String(n).padStart(2, '0')
  return mm < 60 ? `${mm}:${pad(s % 60)}` : `${Math.floor(mm / 60)}:${pad(mm % 60)}:${pad(s % 60)}`
}

/** The Run tab: targets, a command and options on the left; the selected run on the right. */
export function RunTab() {
  useEffect(() => showRunView(), [])
  const { runs, selectedId } = useSyncExternalStore(runStore.subscribe, runStore.get)
  const selected = runs.find((r) => r.id === selectedId)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const again = (run: RunSummary) => {
    const req = requestFor(run.id)
    if (!req) return
    if (!req.confirm) return void launch(req)
    setConfirm(confirmFor(req.confirm, run.hosts.map((h) => h.label), (name) => launch({ ...req, confirm: name })))
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-line">
        <Composer onConfirm={setConfirm} />
        <RecentRuns runs={runs} selectedId={selectedId} />
      </aside>
      <section aria-label="Run" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {selected ? (
          <RunView key={selected.id} run={selected} onAgain={requestFor(selected.id) ? () => again(selected) : undefined} />
        ) : (
          <div className="flex flex-1 items-center justify-center pb-16">
            <EmptyState icon={Play} title="Run a command on many hosts" text="Pick an environment or hosts, write a command, and watch each host answer here." />
          </div>
        )}
      </section>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

/** A segmented radio group; the arrow keys move the choice. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
}: {
  label: string
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({})
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = options.findIndex((o) => o.id === value)
    const next = options[(i + step + options.length) % options.length].id
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5"
    >
      {options.map((o) => {
        const checked = o.id === value
        return (
          <motion.button
            key={o.id}
            ref={(el: HTMLButtonElement | null) => {
              refs.current[o.id] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.id)}
            whileTap={motionSafe ? { scale: 0.95 } : undefined}
            transition={spring}
            className={`relative flex items-center justify-center rounded-md px-2.5 font-medium transition-colors ${
              size === 'sm' ? 'h-6 text-[12px]' : 'h-7 text-[12.5px]'
            } ${checked ? 'text-fg' : 'text-muted hover:text-fg'}`}
          >
            {checked && (
              <motion.span
                layoutId={motionSafe ? `${id}-seg` : undefined}
                transition={spring}
                className="absolute inset-0 rounded-md bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
              />
            )}
            <span className="relative">{o.label}</span>
          </motion.button>
        )
      })}
    </div>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line/70 px-5 py-4">
      <div className="flex h-7 items-center justify-between gap-2">
        <h2 className="text-[11.5px] font-semibold tracking-[0.06em] text-muted uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Targets, the command and options, and the Run button with its protection checks. */
function Composer({ onConfirm }: { onConfirm: (req: ConfirmRequest) => void }) {
  const inv = useInventory()
  const hosts = useMemo(() => inv?.hosts ?? [], [inv])
  const environments = useMemo(() => inv?.environments ?? [], [inv])
  const { snippets, loaded } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  useEffect(() => {
    if (!loaded) void loadSnippets()
  }, [loaded])

  // Targets.
  const [targetMode, setTargetMode] = useState<TargetMode>('environment')
  const [envId, setEnvId] = useState('')
  const [role, setRole] = useState<Role>('all')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [contextId, setContextId] = useState('')

  const env = environments.find((e) => e.id === envId)
  const roleCounts = useMemo(() => {
    const known = new Set(hosts.map((h) => h.id))
    const members = env?.hosts.filter((m) => known.has(m.hostId)) ?? []
    return Object.fromEntries([['all', members.length], ...HOST_ROLES.map((r) => [r, members.filter((m) => m.role === r).length])]) as Record<Role, number>
  }, [env, hosts])

  // Main resolves targets in host order (by label), as the inventory lists them.
  const targets = useMemo(() => {
    if (targetMode === 'environment') {
      if (!env) return []
      const members = new Set(env.hosts.filter((m) => role === 'all' || m.role === role).map((m) => m.hostId))
      return hosts.filter((h) => members.has(h.id))
    }
    return hosts.filter((h) => picked.has(h.id))
  }, [targetMode, env, role, hosts, picked])
  const context = targetMode === 'environment' ? (env ?? null) : (environments.find((e) => e.id === contextId) ?? null)

  // Command.
  const [commandMode, setCommandMode] = useState<CommandMode>('text')
  const [text, setText] = useState('')
  const [snippetId, setSnippetId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const snippet = snippets.find((s) => s.id === snippetId)
  // Blank fields are left out, so main uses the default or says what is missing.
  const filled = useMemo(() => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), [values])
  const renderKey = snippet ? JSON.stringify([snippet.id, snippet.updatedAt, filled]) : ''
  const [rendered, setRendered] = useState<{ key: string; text: string | null; error: string | null }>({ key: '', text: null, error: null })
  const renderSeq = useRef(0)
  useEffect(() => {
    if (commandMode !== 'snippet' || !snippet) return
    const seq = ++renderSeq.current
    const key = renderKey
    const t = setTimeout(async () => {
      let error: string | null = null
      // A template error is the snippet's: shown under its fields, never toasted.
      const out = await attempt("Couldn't check the snippet", () => api.invoke('snippets:render', snippet.id, filled), (m) => (error = m))
      if (seq === renderSeq.current) setRendered({ key, text: out ?? null, error: out === undefined ? (error ?? 'Couldn’t check the snippet') : null })
    }, RENDER_DELAY_MS)
    return () => clearTimeout(t)
    // renderKey stands for snippet and filled.
  }, [commandMode, renderKey])
  const checking = commandMode === 'snippet' && !!snippet && rendered.key !== renderKey
  const templateError = commandMode === 'snippet' && rendered.key === renderKey ? rendered.error : null

  const pickSnippet = (id: string) => {
    setSnippetId(id)
    const s = snippets.find((x) => x.id === id)
    setValues(Object.fromEntries((s?.variables ?? []).map((v) => [v.name, v.default ?? ''])))
  }

  // Options.
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)
  const [timeoutSec, setTimeoutSec] = useState(DEFAULT_RUN_TIMEOUT_SEC)

  const commandText = commandMode === 'text' ? text : rendered.key === renderKey ? (rendered.text ?? '') : ''
  const destructive = (commandMode === 'snippet' && !!snippet?.destructive) || DESTRUCTIVE_PATTERN.test(commandText)
  const protection = runProtection(
    context,
    environments,
    targets.map((h) => h.id),
    targets.length,
    destructive,
  )
  const hasCommand = commandMode === 'text' ? text.trim() !== '' : !!snippet && !checking && !templateError
  const ready = targets.length > 0 && hasCommand && !protection.refused

  const request = (): RunRequest => ({
    target:
      targetMode === 'environment'
        ? { kind: 'environment', environmentId: envId, ...(role !== 'all' && { role }) }
        : { kind: 'hosts', hostIds: targets.map((h) => h.id), ...(contextId && { environmentId: contextId }) },
    command: commandMode === 'text' ? { kind: 'text', text } : { kind: 'snippet', snippetId, values: filled },
    concurrency,
    timeoutSec,
  })
  const [starting, setStarting] = useState(false)
  const run = async () => {
    if (!ready || starting) return
    const req = request()
    if (protection.needed) {
      onConfirm(confirmFor(protection.needed, targets.map((h) => h.label), (name) => launch({ ...req, confirm: name })))
      return
    }
    setStarting(true)
    try {
      await launch(req)
    } finally {
      setStarting(false)
    }
  }

  return (
    <form
      aria-label="New run"
      onSubmit={(e) => {
        e.preventDefault()
        void run()
      }}
    >
      <Section
        title="Targets"
        aside={
          <Segmented
            label="Target by"
            size="sm"
            value={targetMode}
            onChange={setTargetMode}
            options={[
              { id: 'environment', label: 'Environment' },
              { id: 'hosts', label: 'Hosts' },
            ]}
          />
        }
      >
        {targetMode === 'environment' ? (
          <>
            <SelectField label="Environment" value={envId} onChange={(e) => setEnvId(e.target.value)}>
              <option value="">Choose an environment</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.protected ? ' (protected)' : ''}
                </option>
              ))}
            </SelectField>
            {env && <RoleChips value={role} counts={roleCounts} onChange={setRole} />}
          </>
        ) : (
          <HostChecklist hosts={hosts} picked={picked} onChange={setPicked} />
        )}
        {targetMode === 'hosts' && (
          <SelectField label="Environment context" hint="Optional: run as part of an environment" value={contextId} onChange={(e) => setContextId(e.target.value)}>
            <option value="">None</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectField>
        )}
        <TargetPreview labels={targets.map((h) => h.label)} protectedEnv={protection.env?.protected ? protection.env.name : null} />
        {protection.refused && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-err/10 px-3 py-2 text-[12px] leading-4 text-err">
            <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{protection.refused}</span>
          </p>
        )}
      </Section>

      <Section
        title="Command"
        aside={
          <Segmented
            label="Command from"
            size="sm"
            value={commandMode}
            onChange={setCommandMode}
            options={[
              { id: 'text', label: 'Command' },
              { id: 'snippet', label: 'Snippet' },
            ]}
          />
        }
      >
        {commandMode === 'text' ? (
          <TextAreaField
            label="Command"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void run()
              }
            }}
            placeholder="uptime"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[12.5px]"
            hint={`${isMac() ? '⌘' : 'Ctrl'}+Enter runs it`}
          />
        ) : (
          <>
            <SelectField label="Snippet" value={snippetId} onChange={(e) => pickSnippet(e.target.value)}>
              <option value="">{snippets.length ? 'Choose a snippet' : 'No snippets yet'}</option>
              {snippets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </SelectField>
            {snippet?.variables.map((v) => (
              <TextField
                key={v.name}
                label={v.name}
                value={values[v.name] ?? ''}
                placeholder={v.default === null ? 'Required' : `Default: ${v.default}`}
                onChange={(e) => setValues((cur) => ({ ...cur, [v.name]: e.target.value }))}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[12.5px]"
              />
            ))}
            {snippet &&
              (templateError ? (
                  <motion.p
                    key="error"
                    role="alert"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={fast}
                    className="rounded-lg bg-err/10 px-3 py-2 text-[12px] leading-4 text-err"
                  >
                    {templateError}
                  </motion.p>
                ) : (
                  <motion.pre
                    key="preview"
                    aria-label="Command to run"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: checking ? 0.5 : 1 }}
                    transition={fast}
                    className="max-h-28 overflow-auto rounded-lg border border-line/70 bg-canvas/70 px-3 py-2 font-mono text-[12px] break-all whitespace-pre-wrap text-fg/85"
                  >
                    {rendered.text ?? ' '}
                  </motion.pre>
                ))}
          </>
        )}
      </Section>

      <Section title="Options">
        <div className="flex items-end gap-3">
          <Stepper value={concurrency} onChange={setConcurrency} />
          <div className="flex-1">
            <SelectField label="Timeout" value={String(timeoutSec)} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
              {TIMEOUTS.map((t) => (
                <option key={t.sec} value={String(t.sec)}>
                  {t.label}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
      </Section>

      <div className="px-5 py-4">
        <Button
          type="submit"
          className="w-full"
          variant={protection.needed ? 'danger' : 'primary'}
          disabled={!ready}
          loading={starting}
          icon={protection.needed ? <ShieldCheck aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
        >
          {`Run on ${plural(targets.length, 'host')}${protection.needed ? '…' : ''}`}
        </Button>
      </div>
    </form>
  )
}

function RoleChips({ value, counts, onChange }: { value: Role; counts: Record<Role, number>; onChange: (r: Role) => void }) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const roles: Role[] = ['all', ...HOST_ROLES]
  return (
    <div role="group" aria-label="Role" className="flex flex-wrap gap-1">
      {roles.map((r) => {
        const on = r === value
        const name = r === 'all' ? 'All' : r
        return (
          <motion.button
            key={r}
            type="button"
            aria-pressed={on}
            aria-label={`${name} ${counts[r]}`}
            onClick={() => onChange(r)}
            whileTap={motionSafe ? { scale: 0.94 } : undefined}
            transition={spring}
            className={`relative flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors ${
              on ? 'border-transparent text-fg' : 'border-line/70 text-muted hover:text-fg'
            } ${counts[r] === 0 && !on ? 'opacity-50' : ''}`}
          >
            {on &&
              (motionSafe ? (
                <motion.span layoutId={`${id}-role`} transition={spring} className="absolute inset-0 rounded-md bg-white/[0.07] shadow-[inset_0_0_0_1px_var(--border)]" />
              ) : (
                <span className="absolute inset-0 rounded-md bg-white/[0.07] shadow-[inset_0_0_0_1px_var(--border)]" />
              ))}
            <span className="relative">{name}</span>
            <span className="relative min-w-4 rounded bg-white/[0.05] px-1 text-center text-[11px] text-muted tabular-nums">{counts[r]}</span>
          </motion.button>
        )
      })}
    </div>
  )
}

function HostChecklist({
  hosts,
  picked,
  onChange,
}: {
  hosts: readonly { id: string; label: string; tags: string[] }[]
  picked: ReadonlySet<string>
  onChange: (s: ReadonlySet<string>) => void
}) {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const tags = useMemo(() => [...new Set(hosts.flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b)), [hosts])
  const q = query.trim().toLowerCase()
  const shown = hosts.filter((h) => (!tag || h.tags.includes(tag)) && (!q || h.label.toLowerCase().includes(q)))
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label="Search hosts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hosts"
            className="h-8 w-full rounded-lg border border-line bg-surface/60 pr-2 pl-8 text-[12.5px] text-fg placeholder:text-muted/70 focus:border-accent/50 focus:outline-none"
          />
        </label>
        <select
          aria-label="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="h-8 max-w-28 rounded-lg border border-line bg-surface/60 px-2 text-[12.5px] text-fg focus:border-accent/50 focus:outline-none"
        >
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div role="group" aria-label="Hosts to run on" className="flex max-h-52 flex-col overflow-y-auto rounded-lg border border-line/70 bg-surface/40 py-1">
        {shown.length === 0 && <p className="px-3 py-2 text-[12px] text-muted">No hosts match</p>}
        {shown.map((h) => (
          <label key={h.id} className="flex h-7 shrink-0 cursor-pointer items-center gap-2.5 px-3 text-[12.5px] text-fg/90 hover:bg-white/[0.03]">
            <input type="checkbox" checked={picked.has(h.id)} onChange={() => toggle(h.id)} className="size-3.5 accent-(--accent)" />
            <span className="truncate">{h.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/** The hosts a run would reach right now, in the order main runs them. */
function TargetPreview({ labels, protectedEnv }: { labels: string[]; protectedEnv: string | null }) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <motion.span
          key={labels.length}
          initial={motionSafe ? { opacity: 0.4, y: -2 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={motionSafe ? spring : fast}
          className="text-[12.5px] font-medium text-fg/90 tabular-nums"
        >
          {plural(labels.length, 'host')}
        </motion.span>
        {protectedEnv && (
          <Badge tone="warn">
            <ShieldCheck aria-hidden className="size-3" />
            Protected
          </Badge>
        )}
      </div>
      {/* Hosts pop in as they join; one that leaves goes at once, so the list is always the real target. */}
      <ul aria-label="Target hosts" className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {labels.map((l) => (
          <motion.li
            key={l}
            layout={motionSafe ? 'position' : false}
            initial={motionSafe ? { opacity: 0, scale: 0.85 } : { opacity: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={motionSafe ? spring : fast}
            className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-muted"
          >
            {l}
          </motion.li>
        ))}
      </ul>
    </div>
  )
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-[12.5px] font-medium text-fg/90">
        At once
      </span>
      <div role="group" aria-labelledby={id} className="flex h-9 items-center rounded-lg border border-line bg-surface/60">
        <button
          type="button"
          aria-label="Fewer hosts at once"
          disabled={value <= 1}
          onClick={() => onChange(Math.max(1, value - 1))}
          className="grid h-full w-8 place-items-center text-muted hover:text-fg disabled:opacity-40"
        >
          <Minus aria-hidden className="size-3.5" />
        </button>
        <output aria-live="polite" className="w-7 text-center text-[13px] font-medium text-fg tabular-nums">
          {value}
        </output>
        <button
          type="button"
          aria-label="More hosts at once"
          disabled={value >= MAX_CONCURRENCY}
          onClick={() => onChange(Math.min(MAX_CONCURRENCY, value + 1))}
          className="grid h-full w-8 place-items-center text-muted hover:text-fg disabled:opacity-40"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** The last runs, newest first: open one, or dismiss a finished one. */
function RecentRuns({ runs, selectedId }: { runs: RunSummary[]; selectedId: string | null }) {
  const motionSafe = useMotionSafe()
  const dismiss = async (id: string) => {
    const done = await attempt("Couldn't dismiss the run", async () => {
      await api.invoke('runs:dismiss', id)
      return true
    })
    if (done) removeRun(id)
  }
  return (
    <section className="flex flex-col gap-2 px-5 py-4">
      <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-muted uppercase">
        <History aria-hidden className="size-3.5" />
        Recent runs
      </h2>
      {runs.length === 0 && <p className="text-[12px] text-muted">Runs you start show up here.</p>}
      <ul aria-label="Recent runs" className="flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {runs.slice(0, MAX_RUNS_KEPT).map((r) => {
            const bad = r.hosts.filter((h) => isBad(h.state)).length
            return (
              <motion.li
                key={r.id}
                layout={motionSafe ? 'position' : false}
                initial={motionSafe ? { opacity: 0, x: -8 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: fast }}
                transition={motionSafe ? spring : fast}
                className={`group flex items-center rounded-lg transition-colors ${r.id === selectedId ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
              >
                <button
                  type="button"
                  aria-current={r.id === selectedId || undefined}
                  onClick={() => selectRun(r.id)}
                  className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1.5 text-left"
                >
                  <span className="w-full truncate font-mono text-[12px] text-fg/90">{r.title}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${r.state === 'running' ? `bg-accent ${motionSafe ? 'od-pulse' : ''}` : bad ? 'bg-err' : r.state === 'cancelled' ? 'bg-muted' : 'bg-ok'}`}
                    />
                    {plural(r.hosts.length, 'host')}
                    {r.environmentName ? ` · ${r.environmentName}` : ''}
                    {r.state === 'running' ? ' · running' : bad ? ` · ${bad} failed` : r.state === 'cancelled' ? ' · cancelled' : ''}
                  </span>
                </button>
                {r.state !== 'running' && (
                  <button
                    type="button"
                    aria-label={`Dismiss ${r.title}`}
                    title="Dismiss"
                    onClick={() => void dismiss(r.id)}
                    className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </section>
  )
}

const SEGMENTS = [
  { state: 'ok', label: 'ok', bar: 'bg-ok' },
  { state: 'failed', label: 'failed', bar: 'bg-err' },
  { state: 'timeout', label: 'timed out', bar: 'bg-warn' },
  { state: 'cancelled', label: 'cancelled', bar: 'bg-muted/60' },
] as const

/** "1 running · 4 queued", then "3 ok · 1 failed · 1 cancelled" */
function countsText(hosts: RunHostMeta[]): string {
  const n = (f: (s: RunHostState) => boolean) => hosts.filter((h) => f(h.state)).length
  return [
    [n(isLive), 'running'],
    [n((s) => s === 'queued'), 'queued'],
    ...SEGMENTS.map((s) => [n((x) => x === s.state), s.label] as const),
  ]
    .filter(([c]) => c)
    .map(([c, l]) => `${c} ${l}`)
    .join(' · ')
}

function SummaryBar({ hosts }: { hosts: RunHostMeta[] }) {
  const motionSafe = useMotionSafe()
  const total = Math.max(1, hosts.length)
  const live = hosts.filter((h) => isLive(h.state)).length
  return (
    <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      {SEGMENTS.map((s) => (
        <motion.span
          key={s.state}
          className={`h-full ${s.bar}`}
          initial={false}
          animate={{ width: `${(hosts.filter((h) => h.state === s.state).length / total) * 100}%` }}
          transition={motionSafe ? spring : { duration: 0 }}
        />
      ))}
      <motion.span
        className={`h-full bg-accent/60 ${live && motionSafe ? 'od-pulse' : ''}`}
        initial={false}
        animate={{ width: `${(live / total) * 100}%` }}
        transition={motionSafe ? spring : { duration: 0 }}
      />
    </div>
  )
}

/** The selected run: header, host chips, and each host's output. */
function RunView({ run, onAgain }: { run: RunSummary; onAgain?: () => void }) {
  const running = run.state === 'running'
  const now = useNow(running)
  const started = Date.parse(run.startedAt)
  const ended = run.endedAt ? Date.parse(run.endedAt) : now
  const outputs = useSyncExternalStore(runOutputStore.subscribe, () => runOutputStore.get()[run.id])
  const [layout, setLayout] = useState<Layout>('grouped')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [cancelling, setCancelling] = useState(false)
  const paneRefs = useRef<Record<string, HTMLElement | null>>({})

  const isOpen = (h: RunHostMeta) => open[h.hostId] ?? (run.hosts.length === 1 || isBad(h.state))
  // Failed hosts first, the rest in run order.
  const ordered = [...run.hosts.filter((h) => isBad(h.state)), ...run.hosts.filter((h) => !isBad(h.state))]

  const focusHost = (hostId: string) => {
    setLayout('grouped')
    setOpen((o) => ({ ...o, [hostId]: true }))
    requestAnimationFrame(() => paneRefs.current[hostId]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }))
  }
  const cancel = async () => {
    setCancelling(true)
    await attempt("Couldn't cancel the run", () => api.invoke('runs:cancel', run.id))
    setCancelling(false)
  }

  return (
    <div className="flex flex-col gap-5 px-8 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="truncate font-mono text-[15px] font-semibold text-fg">{run.title}</h2>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              {run.environmentName && <Badge tone="info">{run.environmentName}</Badge>}
              <span className="tabular-nums" title="Elapsed">
                {elapsedText(ended - started)}
              </span>
              <span aria-hidden>·</span>
              <span>{plural(run.concurrency, 'host')} at once</span>
            </div>
          </div>
          {running ? (
              <motion.div key="cancel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fast}>
                <Button variant="ghost" size="sm" loading={cancelling} onClick={() => void cancel()} icon={<Square aria-hidden className="size-3" />}>
                  Cancel
                </Button>
              </motion.div>
            ) : onAgain ? (
              <motion.div key="again" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fast}>
                <Button variant="ghost" size="sm" onClick={onAgain} icon={<RotateCcw aria-hidden className="size-3.5" />}>
                  Run again
                </Button>
              </motion.div>
            ) : null}
        </div>
        <SummaryBar hosts={run.hosts} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-fg/80 tabular-nums">{countsText(run.hosts)}</span>
          {run.state === 'cancelled' && <span className="text-muted">{CANCELLED_NOTE}</span>}
          {run.outputDropped && <span className="text-muted">Older output was dropped to save memory</span>}
        </div>
      </header>

      <ul aria-label="Hosts" className="flex flex-wrap gap-1.5">
        {run.hosts.map((h) => (
          <HostChip key={h.hostId} host={h} active={layout === 'grouped' && isOpen(h)} onSelect={focusHost} />
        ))}
      </ul>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[12.5px] font-medium text-fg/90">Output</h3>
          <Segmented
            label="Show output"
            size="sm"
            value={layout}
            onChange={setLayout}
            options={[
              { id: 'grouped', label: 'Grouped' },
              { id: 'interleaved', label: 'Interleaved' },
            ]}
          />
        </div>
        {layout === 'grouped' ? (
          <ul className="flex flex-col gap-2">
            {ordered.map((h) => (
              <HostPane
                key={h.hostId}
                host={h}
                output={outputs?.[h.hostId]}
                open={isOpen(h)}
                onToggle={() => setOpen((o) => ({ ...o, [h.hostId]: !isOpen(h) }))}
                paneRef={(el) => {
                  paneRefs.current[h.hostId] = el
                }}
              />
            ))}
          </ul>
        ) : (
          <Interleaved runId={run.id} hosts={run.hosts} outputs={outputs} />
        )}
      </div>
    </div>
  )
}

function HostPane({
  host,
  output,
  open,
  onToggle,
  paneRef,
}: {
  host: RunHostMeta
  output: HostOutput | undefined
  open: boolean
  onToggle: () => void
  paneRef: (el: HTMLElement | null) => void
}) {
  const motionSafe = useMotionSafe()
  const code = host.exitCode !== null ? `exit ${host.exitCode}` : host.signal
  return (
    <motion.li
      ref={paneRef}
      layout={motionSafe ? 'position' : false}
      transition={motionSafe ? spring : fast}
      className={`overflow-hidden rounded-xl border bg-surface/50 ${isBad(host.state) ? 'border-err/30' : 'border-line/70'}`}
    >
      <button
        type="button"
        aria-label={`${host.label} output`}
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-10 w-full items-center gap-2.5 px-3.5 text-left text-[12.5px] transition-colors hover:bg-white/[0.025]"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={motionSafe ? spring : { duration: 0 }} className="grid text-muted">
          <ChevronRight aria-hidden className="size-3.5" />
        </motion.span>
        <span className="font-medium text-fg">{host.label}</span>
        <span className={`text-[11.5px] ${isBad(host.state) ? 'text-err' : host.state === 'ok' ? 'text-ok' : 'text-muted'}`}>{STATE_WORD[host.state]}</span>
        {code && <span className="font-mono text-[11px] text-muted tabular-nums">{code}</span>}
        {host.truncated && <span className="ml-auto text-[11px] text-muted">Output trimmed</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={motionSafe ? { height: 0, opacity: 0 } : { opacity: 0 }}
            animate={motionSafe ? { height: 'auto', opacity: 1 } : { opacity: 1 }}
            exit={motionSafe ? { height: 0, opacity: 0, transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
          >
            <div className="flex flex-col gap-2 px-3.5 pb-3.5">
              {host.error && <p className="text-[12px] text-err">{host.error.message}</p>}
              {host.state === 'cancelled' && <p className="text-[12px] text-muted">{CANCELLED_NOTE}</p>}
              <OutputPane output={output} label={host.label} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  )
}

/** Where the interleaved stream has got to for one host. */
interface Cursor {
  total: number
  /** The current line so far, as [text, stderr] pieces; it is written out once its newline arrives. */
  line: [string, boolean][]
}

interface Merged {
  runId: string
  sources: Record<string, HostOutput> | undefined
  cursors: Record<string, Cursor>
  out: HostOutput | undefined
}

/** The pieces of `out.text` from `from` on, split where stderr starts and stops. */
function piecesFrom(out: HostOutput, from: number): [string, boolean][] {
  const pieces: [string, boolean][] = []
  let at = from
  for (const [a, b] of out.errRanges) {
    if (b <= at) continue
    if (a > at) pieces.push([out.text.slice(at, a), false])
    pieces.push([out.text.slice(Math.max(a, at), b), true])
    at = b
  }
  if (at < out.text.length) pieces.push([out.text.slice(at), false])
  return pieces
}

/**
 * Folds new output from every host into one stream of whole lines, each under its host's label, in the
 * order they arrive. A host that went back (a reload) or skipped what the text holds starts over.
 */
function interleave(prev: Merged, runId: string, sources: Record<string, HostOutput> | undefined, hosts: RunHostMeta[]): Merged {
  const fresh = prev.runId !== runId
  const cursors: Record<string, Cursor> = fresh ? {} : { ...prev.cursors }
  let out = fresh ? undefined : prev.out
  const write = (label: string, line: [string, boolean][]) => {
    out = appendOutput(out, `${label} │ `, false)
    for (const [t, err] of line) out = appendOutput(out, t, err)
  }
  for (const h of hosts) {
    const src = sources?.[h.hostId]
    let cur = cursors[h.hostId] ?? { total: 0, line: [] }
    if (src) {
      let delta = src.total - cur.total
      if (delta < 0 || delta > src.text.length) {
        cur = { total: 0, line: [] }
        delta = Math.min(src.total, src.text.length)
      }
      if (delta > 0) {
        const line = [...cur.line]
        for (const [text, err] of piecesFrom(src, src.text.length - delta)) {
          const parts = text.split('\n')
          parts.forEach((p, i) => {
            if (p) line.push([p, err])
            if (i < parts.length - 1) {
              line.push(['\n', err])
              write(h.label, line)
              line.length = 0
            }
          })
        }
        cur = { total: src.total, line }
      }
    }
    // A finished host's last line has no newline coming.
    if (!isLive(h.state) && h.state !== 'queued' && cur.line.length) {
      write(h.label, [...cur.line, ['\n', false]])
      cur = { ...cur, line: [] }
    }
    cursors[h.hostId] = cur
  }
  return { runId, sources, cursors, out }
}

function Interleaved({ runId, hosts, outputs }: { runId: string; hosts: RunHostMeta[]; outputs: Record<string, HostOutput> | undefined }) {
  const merged = useRef<Merged>({ runId: '', sources: undefined, cursors: {}, out: undefined })
  const states = hosts.map((h) => h.state).join()
  const seen = useRef('')
  if (merged.current.runId !== runId || merged.current.sources !== outputs || seen.current !== states) {
    merged.current = interleave(merged.current, runId, outputs, hosts)
    seen.current = states
  }
  return <OutputPane output={merged.current.out} label="all hosts" className="max-h-[32rem]" />
}
