import { describe, expect, it, vi } from 'vitest'
import { IntegrationError, type Fetch } from '../../src/main/notify/http'
import { buildTeamsCard, sendTeams, type NotificationFacts } from '../../src/main/notify/teams'

const facts = (over: Partial<NotificationFacts> = {}): NotificationFacts => ({
  event: 'release.succeeded',
  title: 'shop 1.4.0 deployed to staging',
  environment: { name: 'staging', color: '#22c55e', protected: false },
  product: 'shop',
  deployment: 'web, worker',
  hosts: ['web-1', 'web-2'],
  status: 'succeeded',
  version: '1.4.0',
  durationSec: 125,
  urls: ['https://shop.staging.example', 'http://insecure.example', 'https://grafana.example/d/1', 'https://a.example', 'https://b.example'],
  actor: 'ashish@mbp',
  at: '2026-10-19T10:00:00.000Z',
  notesExcerpt: 'Adds checkout retries.',
  ...over,
})

const content = (card: object) => (card as { attachments: { content: Record<string, unknown> }[] }).attachments[0]!.content

describe('buildTeamsCard', () => {
  it('builds a succeeded card with facts and links', () => {
    expect(buildTeamsCard(facts())).toMatchSnapshot()
  })

  it('failed card is attention-coloured and has no notes', () => {
    const c = content(buildTeamsCard(facts({ event: 'release.failed', status: 'failed', notesExcerpt: 'should not show' })))
    const json = JSON.stringify(c)
    expect((c.body as { style?: string }[])[0]!.style).toBe('attention')
    expect(json).not.toContain('should not show')
  })

  it('drops non-https URLs from actions', () => {
    const actions = content(buildTeamsCard(facts())).actions as { type: string; url: string }[]
    expect(actions.map((a) => a.url)).toEqual(['https://shop.staging.example/', 'https://grafana.example/d/1', 'https://a.example/'])
    expect(actions.every((a) => a.type === 'Action.OpenUrl')).toBe(true)
    expect(content(buildTeamsCard(facts({ urls: ['javascript:alert(1)', 'ftp://x', 'garbage'] }))).actions).toEqual([])
  })

  it('card never contains addresses or log text', () => {
    const meta = { label: 'web-1', address: '10.1.2.3' }
    const f = { ...facts({ hosts: [meta.label] }), address: meta.address, log: 'ERROR at 10.1.2.3 stack', command: 'rm -rf /' } as NotificationFacts
    const json = JSON.stringify(buildTeamsCard(f))
    expect(json).not.toContain('10.1.2.3')
    expect(json).not.toContain('stack')
    expect(json).not.toContain('rm -rf')
    expect(json).toContain('web-1')
  })

  it('redacts known secrets in every string and caps the notes', () => {
    const json = JSON.stringify(buildTeamsCard(facts({ title: 'deploy hunter22-secret', notesExcerpt: 'n'.repeat(900) }), ['hunter22-secret']))
    expect(json).not.toContain('hunter22-secret')
    expect(json).toContain('‹redacted›')
    expect(json).not.toContain('n'.repeat(601))
  })
})

describe('sendTeams', () => {
  const HOOK = 'https://x.webhook.office.com/abc/SECRETPATH'

  it('posts the card to the webhook', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    await sendTeams(HOOK, facts(), { fetch: fetch as unknown as Fetch, sleep: async () => {}, knownSecrets: [] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(HOOK)
    expect(JSON.parse(String(init.body)).type).toBe('message')
  })

  it('errors never contain the webhook URL or key', async () => {
    const fetch = vi.fn(async () => new Response('bad SECRETPATH', { status: 500 }))
    const err = await sendTeams(HOOK, facts(), { fetch: fetch as unknown as Fetch, sleep: async () => {}, knownSecrets: ['sk-ant-key-value'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IntegrationError)
    const e = err as IntegrationError
    expect(e.message).toBe('Teams webhook failed (HTTP 500)')
    for (const s of [e.message, String(e), JSON.stringify(e), String(e.stack)]) {
      expect(s).not.toContain('SECRETPATH')
      expect(s).not.toContain('webhook.office.com')
    }
  })
})
