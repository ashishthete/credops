// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).

import type { CommitInfo } from './deploy'

export type AiErrorCode = 'no-key' | 'auth' | 'rate-limit' | 'network' | 'refused' | 'truncated' | 'bad-output' | 'cancelled' | 'api'

export interface AiError {
  code: AiErrorCode
  /** Fixed text; never echoes a key, a prompt or a response. */
  message: string
}

/** An Error carrying an AiError's code, so it survives IPC as `message` and is matchable in main. */
export class AiFailure extends Error implements AiError {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiFailure'
  }
}

export type RedactionKind = 'secret' | 'key' | 'token' | 'env' | 'url' | 'ip' | 'host' | 'user' | 'email'

export type ExplainSubject =
  | { kind: 'release'; releaseId: string; stepId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'tunnel'; tunnelId: string }

export const COMMAND_RISKS = ['read-only', 'changes-state', 'destructive'] as const
export type CommandRisk = (typeof COMMAND_RISKS)[number]
export const CONFIDENCES = ['low', 'medium', 'high'] as const

export interface ExplainCommand {
  title: string
  command: string
  where: 'host' | 'local'
  risk: CommandRisk
}

export interface Explanation {
  requestId: string
  summary: string
  cause: string
  confidence: (typeof CONFIDENCES)[number]
  steps: string[]
  /** At most MAX_COMMANDS. */
  commands: ExplainCommand[]
  model: string
  redactions: Partial<Record<RedactionKind, number>>
  /** The exact redacted text sent to Claude. */
  sentContext: string
  target: {
    hostId: string | null
    hostLabel: string | null
    environmentId: string | null
    environmentName: string | null
    protected: boolean
  }
}

export const MAX_COMMANDS = 8
export const MAX_COMMAND = 2000
export const MAX_STEPS = 12
const MAX_SUMMARY = 2000
const MAX_CAUSE = 4000
const MAX_STEP = 1000
const MAX_TITLE = 200

/** The structured-output schema for Explain: summary, cause, confidence, steps and commands. */
export const EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'cause', 'confidence', 'steps', 'commands'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what failed.' },
    cause: { type: 'string', description: 'The most likely cause, citing the log lines that show it.' },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps to fix it.' },
    commands: {
      type: 'array',
      description: `At most ${MAX_COMMANDS} shell commands that help diagnose or fix it.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'command', 'where', 'risk'],
        properties: {
          title: { type: 'string' },
          command: { type: 'string' },
          where: { type: 'string', enum: ['host', 'local'] },
          risk: { type: 'string', enum: [...COMMAND_RISKS] },
        },
      },
    },
  },
} as const

export type ParsedExplanation = Omit<Explanation, 'requestId' | 'model' | 'redactions' | 'sentContext' | 'target'>

const bad = (): AiFailure => new AiFailure('bad-output', 'Claude returned an answer CredOps could not read')
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Characters a suggested command must not hold: C0 controls but tab (so also CR and LF), DEL, C1 controls, and the
 * zero-width and bidi-control code points that make what runs differ from what the user reads.
 */
const UNSAFE_COMMAND_CHAR = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/

/** Parses Claude's structured answer. Throws `bad-output`; caps lengths; drops commands that are too long, hold a control or invisible character, or are malformed. */
export function parseExplanation(json: string): ParsedExplanation {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw bad()
  }
  if (!isObj(raw)) throw bad()
  const { summary, cause, confidence, steps, commands } = raw
  if (typeof summary !== 'string' || typeof cause !== 'string') throw bad()
  if (!CONFIDENCES.includes(confidence as never)) throw bad()
  if (!Array.isArray(steps) || !steps.every((s) => typeof s === 'string')) throw bad()
  if (!Array.isArray(commands)) throw bad()
  const kept: ExplainCommand[] = []
  for (const c of commands) {
    if (kept.length >= MAX_COMMANDS) break
    if (!isObj(c)) continue
    const { title, command, where, risk } = c
    if (typeof title !== 'string' || typeof command !== 'string') continue
    if (command.trim().length === 0 || command.length > MAX_COMMAND || UNSAFE_COMMAND_CHAR.test(command)) continue
    if (where !== 'host' && where !== 'local') continue
    if (!COMMAND_RISKS.includes(risk as never)) continue
    kept.push({ title: cap(title, MAX_TITLE), command, where, risk: risk as CommandRisk })
  }
  return {
    summary: cap(summary, MAX_SUMMARY),
    cause: cap(cause, MAX_CAUSE),
    confidence: confidence as ParsedExplanation['confidence'],
    steps: (steps as string[]).slice(0, MAX_STEPS).map((s) => cap(s, MAX_STEP)),
    commands: kept,
  }
}

/** What release notes are written from. `author`, `date` and `sha` of each commit are never sent to Claude. */
export interface ReleaseNotesRequest {
  environmentId: string
  productName: string | null
  /** Commits are grouped under these names when there is more than one. */
  deployments: { id: string; name: string }[]
  version: string | null
  /** At most MAX_COMMITS; a subject is at most MAX_NOTES_SUBJECT chars. */
  commits: CommitInfo[]
}

export const MAX_NOTES_SUBJECT = 300

export interface ReleaseNotesResult {
  requestId: string
  text: string
  model: string | null
  source: 'claude' | 'fallback'
  /** Claude stopped at the length limit; `text` is what it wrote so far. */
  truncated: boolean
  redactions: Partial<Record<RedactionKind, number>>
  /** Why the commit-list fallback was used. */
  error?: AiError
}
