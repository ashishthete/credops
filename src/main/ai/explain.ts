import { isIP } from 'node:net'
import type { AuditLog } from '../audit/audit-log'
import {
  AiFailure,
  EXPLANATION_SCHEMA,
  parseExplanation,
  type ExplainCommand,
  type ExplainSubject,
  type Explanation,
} from '../../shared/ai'
import { STEP_LABEL, type ReleaseDetail, type RunEvent } from '../../shared/deploy'
import type { SessionMeta, SshErrorCode } from '../../shared/ssh'
import type { TunnelMeta, TunnelRuntime } from '../../shared/tunnels'
import { AI_MESSAGES, type ClaudeClient } from './claude'
import { redactPrompt, redactPromptParts, totalRedactions, type PromptRedactionContext, type RedactionCounts } from './prompt-redact'

export const EXPLAIN_SYSTEM = [
  'You help an operator understand why a deployment step, an SSH session or a tunnel failed, and how to fix it.',
  'Give the most likely cause, citing the log lines or error that show it, and ordered steps to fix it.',
  'Suggest at most a few shell commands. Each must be copy-pasteable POSIX shell, one command per entry.',
  'Mark each command `where`: `host` when it runs on the failing host, `local` when it runs on the operator machine.',
  'Mark each command `risk`: `read-only` when it only inspects, `changes-state` when it changes something, `destructive` when it deletes data or stops services.',
  'The input has redaction placeholders such as ‹redacted›, ‹ip-1› or ‹user›.',
  'Never include placeholders like ‹redacted› inside commands unless the user must fill them; when they must, say so in the title.',
  'Say how confident you are: low, medium or high.',
].join('\n')

/** Explain thinks through logs; high effort earns its cost here. */
export const EXPLAIN_EFFORT = 'high'
/** Lines of the failed step's log sent to Claude. */
export const EXPLAIN_LOG_LINES = 200
const EVENT_PAGE = 5000
const MEMORY = 20

/** What main reads to explain a failure. The renderer sends only ids. */
export interface ExplainSources {
  release: { detail(id: string): ReleaseDetail; events(id: string, afterSeq: number, limit: number): RunEvent[] }
  sessions: { list(): SessionMeta[] }
  tunnels: { get(id: string): TunnelMeta; runtime(id: string): TunnelRuntime }
  host(hostId: string): { label: string; os: string | null } | null
  environment(environmentId: string): { name: string; protected: boolean } | null
  /** How a session dials its host. Names (identity label, username) are never read from here. */
  sessionAuth(hostId: string, environmentId: string | null): { auth: string; port: number } | null
  /** The deployment's compose environment block; null in Phase 8. */
  composeSnippet?(deploymentId: string | null): string | null
}

export interface ExplainContext {
  /** Ordered: each key renders under its label. */
  parts: Record<string, string>
  target: Explanation['target']
  /** Parts redacted as env blocks: every value goes. */
  envBlocks: Set<string>
  /** Names that are not inventory hosts but must still leave as `‹host-N›` (a tunnel's target and bind address). */
  hosts?: string[]
}

const LABEL: Record<string, string> = {
  failure: 'Failure',
  step: 'Step',
  error: 'Error',
  host: 'Host',
  environment: 'Environment',
  session: 'Session',
  route: 'Route',
  auth: 'Connection',
  knownHost: 'Known host',
  tunnel: 'Tunnel',
  bind: 'Listens on',
  target: 'Forwards to',
  health: 'Health',
  log: `Log (last ${EXPLAIN_LOG_LINES} lines of this step)`,
  compose: 'Compose environment',
}
const BLOCKS = new Set(['log', 'compose'])

const gone = (what: string): Error => new Error(`That ${what} is gone; nothing to explain`)

function envTarget(src: ExplainSources, environmentId: string | null, fallbackName: string | null = null): Pick<Explanation['target'], 'environmentId' | 'environmentName' | 'protected'> {
  const env = environmentId ? src.environment(environmentId) : null
  return { environmentId, environmentName: env?.name ?? fallbackName, protected: env?.protected ?? false }
}

function hostLine(src: ExplainSources, hostId: string | null): { label: string | null; line: string | null } {
  const h = hostId ? src.host(hostId) : null
  if (!h) return { label: null, line: null }
  return { label: h.label, line: h.os ? `${h.label} (${h.os})` : h.label }
}

function releaseContext(s: Extract<ExplainSubject, { kind: 'release' }>, src: ExplainSources): ExplainContext {
  const detail = src.release.detail(s.releaseId)
  let started: Extract<RunEvent, { type: 'step.started' }> | null = null
  let failed: Extract<RunEvent, { type: 'step.failed' }> | null = null
  const log: string[] = []
  let after = 0
  for (;;) {
    const page = src.release.events(s.releaseId, after, EVENT_PAGE)
    if (page.length === 0) break
    for (const e of page) {
      if (e.type === 'step.started' && e.stepId === s.stepId) started = e
      else if (e.type === 'step.failed' && e.stepId === s.stepId) failed = e
      else if (e.type === 'log' && e.stepId === s.stepId) {
        log.push(e.line)
        if (log.length > EXPLAIN_LOG_LINES) log.shift()
      }
    }
    after = page[page.length - 1].seq
  }
  if (!started) throw gone('step')
  const host = hostLine(src, started.hostId)
  const env = envTarget(src, detail.environmentId, detail.environmentName)
  const parts: Record<string, string> = {
    failure: 'a release step',
    step: `${STEP_LABEL[started.kind] ?? started.kind}: ${started.name}`,
  }
  if (failed) parts.error = failed.error
  if (host.line) parts.host = host.line
  if (env.environmentName) parts.environment = env.protected ? `${env.environmentName} (protected)` : env.environmentName
  parts.log = log.join('\n')
  const envBlocks = new Set<string>()
  if (src.composeSnippet) {
    const runId = started.deploymentRunId
    const deploymentId = runId ? (detail.runs?.find((r) => r.id === runId)?.deploymentId ?? null) : null
    const compose = src.composeSnippet(deploymentId)
    if (compose) {
      parts.compose = compose
      envBlocks.add('compose')
    }
  }
  return { parts, target: { hostId: started.hostId, hostLabel: host.label, ...env }, envBlocks }
}

const KNOWN_HOST: Partial<Record<SshErrorCode, string>> = {
  'host-key-changed': 'the host key changed since it was trusted',
  'host-key-revoked': 'the host key is revoked',
  'host-key-rejected': 'the host key was rejected',
}

function sessionContext(s: Extract<ExplainSubject, { kind: 'session' }>, src: ExplainSources): ExplainContext {
  const meta = src.sessions.list().find((m) => m.id === s.sessionId)
  if (!meta) throw gone('session')
  const host = hostLine(src, meta.hostId)
  const env = envTarget(src, meta.environmentId)
  const parts: Record<string, string> = { failure: meta.kind === 'ssh' ? 'an SSH session' : 'a local shell', session: `state: ${meta.state}` }
  if (meta.error) parts.error = `${meta.error.code}: ${meta.error.message}`
  if (meta.hops.length > 0) parts.route = meta.hops.map((h) => h.label).join(' → ')
  if (host.line) parts.host = host.line
  if (env.environmentName) parts.environment = env.protected ? `${env.environmentName} (protected)` : env.environmentName
  const auth = meta.hostId ? src.sessionAuth(meta.hostId, meta.environmentId) : null
  if (auth) parts.auth = `auth: ${auth.auth}, port: ${auth.port}`
  if (meta.kind === 'ssh') {
    const code = meta.error?.code
    parts.knownHost = (code && KNOWN_HOST[code]) ?? (meta.readyAt ? 'trusted (the session connected before)' : 'not known to have connected')
  }
  return { parts, target: { hostId: meta.hostId, hostLabel: host.label, ...env }, envBlocks: new Set() }
}

const TUNNEL_TYPE = { L: 'local forward', R: 'remote forward', D: 'SOCKS proxy' } as const

function tunnelContext(s: Extract<ExplainSubject, { kind: 'tunnel' }>, src: ExplainSources): ExplainContext {
  let meta: TunnelMeta
  try {
    meta = src.tunnels.get(s.tunnelId)
  } catch {
    throw gone('tunnel')
  }
  const rt = src.tunnels.runtime(s.tunnelId)
  const host = hostLine(src, meta.hostId)
  const env = envTarget(src, meta.environmentId)
  const parts: Record<string, string> = { failure: 'an SSH tunnel', tunnel: `${meta.type} (${TUNNEL_TYPE[meta.type]})`, bind: `${meta.bindAddress}:${meta.bindPort}` }
  if (meta.targetHost !== null) parts.target = `${meta.targetHost}:${meta.targetPort}`
  if (rt.error) parts.error = `${rt.error.code}: ${rt.error.message}`
  parts.health = `state: ${rt.state}, failures: ${rt.failures}, liveness: ${rt.liveness}`
  if (host.line) parts.host = host.line
  if (env.environmentName) parts.environment = env.protected ? `${env.environmentName} (protected)` : env.environmentName
  // IPs are already placeholders; names (an RDS endpoint) are not inventory hosts, so name them here. Loopback stays.
  const hosts = [meta.targetHost, meta.bindAddress].filter((h): h is string => h !== null && !isIP(h) && h.toLowerCase() !== 'localhost')
  return { parts, target: { hostId: meta.hostId, hostLabel: host.label, ...env }, envBlocks: new Set(), hosts }
}

/** The facts Explain sends, read from main's own state. */
export function buildContext(subject: ExplainSubject, src: ExplainSources): ExplainContext {
  if (subject.kind === 'release') return releaseContext(subject, src)
  if (subject.kind === 'session') return sessionContext(subject, src)
  return tunnelContext(subject, src)
}

function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const out: RedactionCounts = { ...a }
  for (const [k, n] of Object.entries(b) as [keyof RedactionCounts, number][]) out[k] = (out[k] ?? 0) + n
  return out
}

/** Redacts the parts (one placeholder map; env blocks wholesale) and renders the user turn. */
export function renderContext(c: ExplainContext, redaction: PromptRedactionContext): { user: string; counts: RedactionCounts } {
  if (c.hosts?.length) redaction = { ...redaction, hostAddresses: [...redaction.hostAddresses, ...c.hosts] }
  const plain = Object.fromEntries(Object.entries(c.parts).filter(([k]) => !c.envBlocks.has(k)))
  const { parts, counts: base } = redactPromptParts(plain, redaction)
  let counts = base
  const out: Record<string, string> = { ...parts }
  for (const k of c.envBlocks) {
    const r = redactPrompt(c.parts[k], { ...redaction, envBlocks: true })
    out[k] = r.text
    counts = addCounts(counts, r.counts)
  }
  const lines: string[] = []
  for (const k of Object.keys(c.parts)) {
    const label = LABEL[k] ?? k
    if (BLOCKS.has(k)) lines.push('', `${label}:`, out[k] === '' ? '(empty)' : out[k])
    else lines.push(`${label}: ${out[k]}`)
  }
  return { user: lines.join('\n'), counts }
}

export interface ExplainDeps {
  claude: Pick<ClaudeClient, 'complete'>
  audit: Pick<AuditLog, 'append'>
  redaction: () => PromptRedactionContext
  sources: ExplainSources
  signal: AbortSignal
}

const subjectTarget = (s: ExplainSubject): { targetType: string; targetId: string } =>
  s.kind === 'release' ? { targetType: 'release', targetId: s.releaseId } : s.kind === 'session' ? { targetType: 'session', targetId: s.sessionId } : { targetType: 'tunnel', targetId: s.tunnelId }

/** Asks Claude why `subject` failed. Throws an AiFailure; audits `ai.explain` with counts, never content. */
export async function explain(requestId: string, subject: ExplainSubject, d: ExplainDeps): Promise<Explanation> {
  const ctx = buildContext(subject, d.sources)
  const { user, counts } = renderContext(ctx, d.redaction())
  const audit = (outcome: 'success' | 'failure', details: Record<string, unknown>): void => {
    d.audit.append({ action: 'ai.explain', outcome, ...subjectTarget(subject), details: { subject: subject.kind, redactions: totalRedactions(counts), ...details } })
  }
  try {
    const res = await d.claude.complete({ system: EXPLAIN_SYSTEM, user, schema: EXPLANATION_SCHEMA, effort: EXPLAIN_EFFORT, signal: d.signal })
    const parsed = parseExplanation(JSON.stringify(res.json))
    audit('success', { model: res.model, confidence: parsed.confidence, commands: parsed.commands.length })
    return { requestId, ...parsed, model: res.model, redactions: counts, sentContext: user, target: ctx.target }
  } catch (e) {
    const failure = e instanceof AiFailure ? e : new AiFailure('api', AI_MESSAGES.api)
    audit('failure', { code: failure.code })
    throw failure
  }
}

/** The last explanations main sent, so `ai:command` audits what Claude wrote, not what the renderer says. */
export class ExplainMemory {
  private readonly items = new Map<string, Explanation>()

  remember(e: Explanation): void {
    this.items.delete(e.requestId)
    this.items.set(e.requestId, e)
    while (this.items.size > MEMORY) this.items.delete(this.items.keys().next().value as string)
  }

  get(requestId: string): Explanation | null {
    return this.items.get(requestId) ?? null
  }
}

export interface CommandDeps {
  memory: ExplainMemory
  audit: Pick<AuditLog, 'append'>
  redaction: () => PromptRedactionContext
}

const MAX_AUDITED_COMMAND = 500

/** Audits a copy or a run of suggestion `index`; the command comes from main's copy, redacted. */
export function recordCommand(d: CommandDeps, requestId: string, index: number, mode: 'copy' | 'run'): ExplainCommand {
  const e = d.memory.get(requestId)
  const cmd = e?.commands[index]
  if (!e || !cmd) throw new Error('That suggestion is no longer available; explain the failure again')
  const onHost = cmd.where === 'host' && e.target.hostId !== null
  d.audit.append({
    action: 'ai.command',
    outcome: 'success',
    ...(onHost ? { targetType: 'host', targetId: e.target.hostId as string, targetLabel: e.target.hostLabel ?? undefined } : {}),
    details: {
      mode,
      where: cmd.where,
      risk: cmd.risk,
      command: redactPrompt(cmd.command, d.redaction()).text.slice(0, MAX_AUDITED_COMMAND),
    },
  })
  return cmd
}
