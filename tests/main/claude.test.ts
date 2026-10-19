import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import Anthropic, { APIConnectionError, APIError, APIUserAbortError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AiRequests, ClaudeClient, type AnthropicLike, type ClientFactoryOptions } from '../../src/main/ai/claude'
import { createAiHandlers } from '../../src/main/ipc/handlers/ai'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { AiFailure } from '../../src/shared/ai'

const KEY = 'sk-ant-api03-fakeKeyValue0123456789'
const SCHEMA = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"a":1}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
    ...over,
  }
}

interface Fake {
  create: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
  opts: ClientFactoryOptions[]
}

function setup(o: { key?: string | null; unlocked?: boolean; model?: string; fake?: Partial<Pick<Fake, 'create' | 'stream'>> } = {}) {
  const fake: Fake = {
    create: o.fake?.create ?? vi.fn(async () => message()),
    stream: o.fake?.stream ?? vi.fn(),
    opts: [],
  }
  const settings = { get: () => ({ aiModel: o.model ?? 'claude-opus-5-5', aiApiKeySecretId: o.key === null ? null : 'sec-1' }) }
  const secrets = { value: (id: string) => (id === 'sec-1' ? (o.key ?? KEY) : '') }
  const client = new ClaudeClient({
    settings,
    secrets,
    vault: { isUnlocked: () => o.unlocked ?? true },
    knownSecrets: () => [],
    factory: (opts) => {
      fake.opts.push(opts)
      return { beta: { messages: { create: fake.create, stream: fake.stream } } } as unknown as AnthropicLike
    },
  })
  return { client, fake }
}

const ask = { system: 'sys', user: 'hello', schema: SCHEMA, effort: 'high' as const }

async function failure(p: Promise<unknown>): Promise<AiFailure> {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(AiFailure)
  return e as AiFailure
}

describe('ClaudeClient.complete', () => {
  it('builds the request with model, effort, adaptive thinking and fallbacks', async () => {
    const { client, fake } = setup()
    const signal = new AbortController().signal
    const res = await client.complete({ ...ask, signal })
    expect(res).toEqual({ json: { a: 1 }, model: 'claude-opus-5-5', stopReason: 'end_turn' })
    expect(fake.create).toHaveBeenCalledTimes(1)
    const [params, options] = fake.create.mock.calls[0]!
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    expect(options).toEqual({ signal })
    expect(fake.opts[0]).toMatchObject({ apiKey: KEY })
  })

  it('uses the configured model and reports the model that answered', async () => {
    const { client, fake } = setup({ model: 'claude-sonnet-5-5', fake: { create: vi.fn(async () => message({ model: 'claude-opus-5' })) } })
    const res = await client.complete({ ...ask, signal: new AbortController().signal })
    expect(fake.create.mock.calls[0]![0].model).toBe('claude-sonnet-5-5')
    expect(res.model).toBe('claude-opus-5')
  })

  it('no key → no-key error without calling the SDK', async () => {
    for (const s of [setup({ key: null }), setup({ unlocked: false })]) {
      const e = await failure(s.client.complete({ ...ask, signal: new AbortController().signal }))
      expect(e.code).toBe('no-key')
      expect(e.message).toBe('Add an Anthropic API key in Settings → AI & integrations')
      expect(s.fake.create).not.toHaveBeenCalled()
      expect(s.fake.opts).toEqual([])
    }
  })

  it('maps SDK errors to AiError', async () => {
    const h = new Headers()
    const cases: [unknown, string, string][] = [
      [new AuthenticationError(401, { error: { message: `bad ${KEY}` } }, `401 bad ${KEY}`, h), 'auth', 'Anthropic rejected the API key'],
      [new RateLimitError(429, {}, '429', h), 'rate-limit', 'Claude is rate-limited; try again in a minute'],
      [new APIConnectionError({ message: 'connect ECONNREFUSED' }), 'network', "Can't reach the Anthropic API"],
      [new APIUserAbortError(), 'cancelled', 'Cancelled'],
      [APIError.generate(500, {}, 'overloaded', h), 'api', 'Claude API error (HTTP 500)'],
      [new Error(`weird ${KEY}`), 'api', 'Claude API request failed'],
    ]
    for (const [err, code, text] of cases) {
      const { client } = setup({ fake: { create: vi.fn(async () => Promise.reject(err)) } })
      const e = await failure(client.complete({ ...ask, signal: new AbortController().signal }))
      expect([e.code, e.message]).toEqual([code, text])
    }
  })

  it('refusal stop_reason → refused', async () => {
    const { client } = setup({ fake: { create: vi.fn(async () => message({ stop_reason: 'refusal', content: [] })) } })
    const e = await failure(client.complete({ ...ask, signal: new AbortController().signal }))
    expect([e.code, e.message]).toEqual(['refused', 'Claude declined this request'])
  })

  it('non-JSON output → bad-output; max_tokens → truncated', async () => {
    const a = setup({ fake: { create: vi.fn(async () => message({ content: [{ type: 'text', text: 'not json' }] })) } })
    expect((await failure(a.client.complete({ ...ask, signal: new AbortController().signal }))).code).toBe('bad-output')
    const b = setup({ fake: { create: vi.fn(async () => message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] })) } })
    expect((await failure(b.client.complete({ ...ask, signal: new AbortController().signal }))).code).toBe('truncated')
  })

  it('a failed call never echoes the key', async () => {
    const errs = [
      new AuthenticationError(401, {}, `401 ${KEY}`, new Headers()),
      APIError.generate(400, {}, `400 ${KEY}`, new Headers()),
      new Error(`boom x-api-key: ${KEY}`),
    ]
    for (const err of errs) {
      const { client } = setup({ fake: { create: vi.fn(async () => Promise.reject(err)) } })
      const e = await failure(client.complete({ ...ask, signal: new AbortController().signal }))
      expect(e.message).not.toContain(KEY)
      expect(String(e.stack)).not.toContain(KEY)
    }
  })
})

describe('ClaudeClient.stream', () => {
  function fakeStream(deltas: string[], final: ReturnType<typeof message>) {
    return vi.fn(() => {
      const listeners: ((d: string) => void)[] = []
      return {
        on(ev: string, fn: (d: string) => void) {
          if (ev === 'text') listeners.push(fn)
          return this
        },
        async finalMessage() {
          for (const d of deltas) for (const l of listeners) l(d)
          return final
        },
      }
    })
  }

  it('stream forwards deltas and returns final text', async () => {
    const stream = fakeStream(['Hel', 'lo'], message({ content: [{ type: 'text', text: 'Hello' }] }))
    const { client } = setup({ fake: { stream } })
    const got: string[] = []
    const signal = new AbortController().signal
    const res = await client.stream({ system: 's', user: 'u', effort: 'medium', signal, onText: (t) => void got.push(t) })
    expect(got).toEqual(['Hel', 'lo'])
    expect(res).toEqual({ text: 'Hello', model: 'claude-opus-5-5', stopReason: 'end_turn' })
    const [params, options] = stream.mock.calls[0]! as unknown as [Record<string, unknown>, unknown]
    expect(params).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] })
    expect((params['output_config'] as Record<string, unknown>)['format']).toBeUndefined()
    expect(options).toEqual({ signal })
  })

  it('max_tokens returns the partial text with its stop reason', async () => {
    const stream = fakeStream(['part'], message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part' }] }))
    const { client } = setup({ fake: { stream } })
    const res = await client.stream({ system: 's', user: 'u', effort: 'low', signal: new AbortController().signal, onText: () => {} })
    expect(res).toEqual({ text: 'part', model: 'claude-opus-5-5', stopReason: 'max_tokens' })
  })
})

describe('AiRequests', () => {
  it('cancel aborts the request', async () => {
    const reqs = new AiRequests()
    let seen: AbortSignal | undefined
    const create = vi.fn((_p: unknown, o: { signal: AbortSignal }) => {
      seen = o.signal
      return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new APIUserAbortError())))
    })
    const { client } = setup({ fake: { create } })
    const { id, signal } = reqs.start()
    const p = client.complete({ ...ask, signal })
    await vi.waitFor(() => expect(seen).toBeDefined())
    reqs.cancel(id)
    expect((await failure(p)).code).toBe('cancelled')
    reqs.finish(id)
    expect(() => reqs.cancel(id)).not.toThrow()
  })

  it('cancelAll aborts every live request', () => {
    const reqs = new AiRequests()
    const a = reqs.start()
    const b = reqs.start()
    reqs.cancelAll()
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, true])
  })
})

describe('ai handlers', () => {
  it('status and cancel', async () => {
    const reqs = new AiRequests()
    const h = createAiHandlers({
      settings: { status: () => ({ ai: { configured: true, model: 'claude-opus-5-5' } }) as never },
      requests: reqs,
      notes: {} as never,
      onDelta: () => {},
    })
    expect(await h['ai:status']()).toEqual({ configured: true, model: 'claude-opus-5-5' })
    const r = reqs.start()
    await h['ai:cancel'](r.id)
    expect(r.signal.aborted).toBe(true)
    expect(() => VALIDATORS['ai:cancel']([5])).toThrow()
  })
})

describe('real SDK', () => {
  it('real SDK against a localhost server sends the expected request', async () => {
    let seen: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> } | null = null
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(message()))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    try {
      const client = new ClaudeClient({
        settings: { get: () => ({ aiModel: 'claude-opus-5-5', aiApiKeySecretId: 'sec-1' }) },
        secrets: { value: () => KEY },
        vault: { isUnlocked: () => true },
        factory: (opts) => new Anthropic({ ...opts, maxRetries: 0, baseURL: `http://127.0.0.1:${port}` }),
      })
      const res = await client.complete({ ...ask, signal: new AbortController().signal })
      expect(res.json).toEqual({ a: 1 })
      expect(seen).not.toBeNull()
      const s = seen!
      expect(s.url).toContain('/v1/messages')
      expect(String(s.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
      expect(s.headers['x-api-key']).toBe(KEY)
      expect(s.body['model']).toBe('claude-opus-5-5')
      expect(s.body['fallbacks']).toBe('default')
      expect(s.body['betas']).toBeUndefined()
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
