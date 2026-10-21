import { randomUUID } from 'node:crypto'
import Anthropic, { APIConnectionError, APIError, APIUserAbortError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages'
import { AiFailure, type AiErrorCode } from '../../shared/ai'
import type { IntegrationSettings } from '../../shared/settings'
import { redact } from '../security/redact'

/** Server-side fallback: when the configured model is unavailable the API serves the default chain. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
export const MAX_TOKENS = 16000
export const REQUEST_TIMEOUT_MS = 120_000
export const MAX_RETRIES = 2

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const AI_MESSAGES: Record<AiErrorCode, string> = {
  'no-key': 'Add an Anthropic API key in Settings → AI & integrations',
  auth: 'Anthropic rejected the API key',
  'rate-limit': 'Claude is rate-limited; try again in a minute',
  network: "Can't reach the Anthropic API",
  refused: 'Claude declined this request',
  truncated: "Claude's answer was cut off before it finished",
  'bad-output': "Claude's answer was not in the expected format",
  cancelled: 'Cancelled',
  api: 'Claude API request failed',
}

export interface ClientFactoryOptions {
  apiKey: string
  maxRetries: number
  timeout: number
  baseURL?: string
}

/** The slice of the SDK client this module uses; the tests substitute a fake. */
export interface AnthropicLike {
  beta: { messages: Pick<Anthropic['beta']['messages'], 'create' | 'stream'> }
}

export interface ClaudeClientDeps {
  settings: { get(): Pick<IntegrationSettings, 'aiModel' | 'aiApiKeySecretId'> }
  secrets: { value(id: string): string }
  vault: { isUnlocked(): boolean }
  knownSecrets?: () => readonly string[]
  factory?: (opts: ClientFactoryOptions) => AnthropicLike
}

export interface CompleteRequest {
  system: string
  user: string
  schema: Record<string, unknown>
  effort: Effort
  signal: AbortSignal
}

export interface StreamRequest {
  system: string
  user: string
  effort: Effort
  signal: AbortSignal
  onText: (delta: string) => void
}

export interface CompleteResult {
  json: unknown
  model: string
  stopReason: string | null
}

export interface StreamResult {
  text: string
  model: string
  stopReason: string | null
}

function fail(code: AiErrorCode, message = AI_MESSAGES[code]): AiFailure {
  return new AiFailure(code, message)
}

function textOf(message: BetaMessage): string {
  return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}

export class ClaudeClient {
  private readonly factory: (opts: ClientFactoryOptions) => AnthropicLike

  constructor(private readonly deps: ClaudeClientDeps) {
    this.factory = deps.factory ?? ((opts) => new Anthropic(opts))
  }

  /** One structured call: the answer is JSON matching `schema`. */
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const { client, model } = this.client()
    const params: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    }
    const message = await this.call(req.signal, () => client.beta.messages.create(params, { signal: req.signal }))
    if (message.stop_reason === 'refusal') throw fail('refused')
    if (message.stop_reason === 'max_tokens') throw fail('truncated')
    let json: unknown
    try {
      json = JSON.parse(textOf(message))
    } catch {
      throw fail('bad-output')
    }
    return { json, model: message.model, stopReason: message.stop_reason }
  }

  /** A streamed free-text call; deltas go to `onText`. A max_tokens stop returns the partial text. */
  async stream(req: StreamRequest): Promise<StreamResult> {
    const { client, model } = this.client()
    const params: BetaMessageStreamParams = {
      model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    }
    const message = await this.call(req.signal, () => {
      const s = client.beta.messages.stream(params, { signal: req.signal })
      s.on('text', (delta) => req.onText(delta))
      return s.finalMessage()
    })
    if (message.stop_reason === 'refusal') throw fail('refused')
    return { text: textOf(message), model: message.model, stopReason: message.stop_reason }
  }

  private client(): { client: AnthropicLike; model: string } {
    const s = this.deps.settings.get()
    if (!this.deps.vault.isUnlocked() || s.aiApiKeySecretId === null) throw fail('no-key')
    let apiKey: string
    try {
      apiKey = this.deps.secrets.value(s.aiApiKeySecretId)
    } catch {
      throw fail('no-key')
    }
    if (!apiKey) throw fail('no-key')
    return { client: this.factory({ apiKey, maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS }), model: s.aiModel }
  }

  private async call<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw this.map(e, signal)
    }
  }

  /** SDK error → AiFailure with a fixed text; the SDK's own message (which may echo input) is dropped. */
  private map(e: unknown, signal: AbortSignal): AiFailure {
    if (e instanceof AiFailure) return e
    let out: AiFailure
    // Most specific first: the abort and connection errors are APIError subclasses.
    if (e instanceof APIUserAbortError || signal.aborted) out = fail('cancelled')
    else if (e instanceof APIConnectionError) out = fail('network')
    else if (e instanceof AuthenticationError) out = fail('auth')
    else if (e instanceof RateLimitError) out = fail('rate-limit')
    else if (e instanceof APIError && typeof e.status === 'number') out = fail('api', `Claude API error (HTTP ${e.status})`)
    else out = fail('api')
    const known = this.deps.knownSecrets?.() ?? []
    return new AiFailure(out.code, redact(out.message, known))
  }
}

/** Live AI requests by id, so the renderer can cancel one and a vault lock can cancel all. */
export class AiRequests {
  private readonly live = new Map<string, AbortController>()

  /** Registers a request under the renderer's id (or a fresh one); a live id cannot be reused. */
  start(id: string = randomUUID()): { id: string; signal: AbortSignal } {
    if (this.live.has(id)) throw new Error('AI request already running')
    const controller = new AbortController()
    this.live.set(id, controller)
    return { id, signal: controller.signal }
  }

  cancel(id: string): void {
    this.live.get(id)?.abort()
  }

  finish(id: string): void {
    this.live.delete(id)
  }

  cancelAll(): void {
    for (const c of this.live.values()) c.abort()
    this.live.clear()
  }
}
