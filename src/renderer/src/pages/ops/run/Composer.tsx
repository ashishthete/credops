import { motion } from 'framer-motion'
import { Minus, Play, Plus, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { HOST_ROLES, type HostRole } from '../../../../../shared/inventory'
import { DEFAULT_CONCURRENCY, DEFAULT_RUN_TIMEOUT_SEC, DESTRUCTIVE_PATTERN, MAX_CONCURRENCY, type RunRequest } from '../../../../../shared/ops'
import { useInventory } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { runProtection } from '../../../ops/protect'
import { loadSnippets, snippetStore } from '../../../ops/snippets'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { attempt, plural, type ConfirmRequest } from '../../../ui/common'
import { SelectField, TextAreaField, TextField } from '../../../ui/Field'
import { fast, spring, useMotionSafe } from '../../../ui/motion'
import { Segmented } from '../../../ui/Segmented'
import { isMac } from '../../../ui/shortcuts'
import { confirmFor, launch } from './launch'

type TargetMode = 'environment' | 'hosts'
type CommandMode = 'text' | 'snippet'
type Role = HostRole | 'all'

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
export function Composer({ onConfirm }: { onConfirm: (req: ConfirmRequest) => void }) {
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

  // `?hosts=a,b` (the Host view's Run… button) preselects those hosts once the inventory has them.
  const [params] = useSearchParams()
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    const q = params.get('hosts')
    if (!q || seeded.current === q || !hosts.length) return
    seeded.current = q
    const known = new Set(hosts.map((h) => h.id))
    const ids = q.split(',').filter((id) => known.has(id))
    if (!ids.length) return
    setTargetMode('hosts')
    setPicked(new Set(ids))
  }, [params, hosts])

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

  // `?snippet=<id>` (the palette, the Snippets tab) opens the snippet's mode with it picked, once it is loaded.
  const seededSnippet = useRef<string | null>(null)
  const wantedSnippet = params.get('snippet')
  useEffect(() => {
    if (!wantedSnippet || seededSnippet.current === wantedSnippet || !loaded) return
    seededSnippet.current = wantedSnippet
    if (!snippets.some((s) => s.id === wantedSnippet)) return
    setCommandMode('snippet')
    pickSnippet(wantedSnippet)
    // pickSnippet only reads the loaded snippets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedSnippet, loaded, snippets])

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
      onConfirm(confirmFor(protection.needed, targets.map((h) => h.label), (name) => launch({ ...req, confirm: name }, onConfirm)))
      return
    }
    setStarting(true)
    try {
      await launch(req, onConfirm)
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
