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

describe('buildTeamsCard changes (row 42)', () => {
  type Block = { type: string; text?: string; spacing?: string; inlines?: { type: string; text: string }[] }
  const blocks = (card: object) => content(card).body as Block[]
  const runs = (b: Block) => (b.inlines ?? []).map((i) => i.text)
  const deploymentBlock = (card: object, name: string) => blocks(card).find((b) => b.type === 'RichTextBlock' && runs(b)[0] === name)!
  /** The deployment's subject lines: one RichTextBlock each, with no spacing, right after its name. */
  const linesOf = (card: object, name: string) => {
    const all = blocks(card)
    const out: Block[] = []
    for (const b of all.slice(all.indexOf(deploymentBlock(card, name)) + 1)) {
      if (b.spacing !== 'None') break
      out.push(b)
    }
    for (const b of out) expect(b.type).toBe('RichTextBlock')
    return out.map((b) => runs(b))
  }
  it('adds a Changes section: up to 10 subjects per deployment, then "and N more"', () => {
    const subjects = Array.from({ length: 12 }, (_, i) => `change ${i + 1}`)
    const card = buildTeamsCard(facts({ changes: [{ deployment: 'web', subjects }, { deployment: 'worker', subjects: ['one'] }] }))
    expect(blocks(card).map((b) => b.text)).toContain('Changes')
    expect(runs(deploymentBlock(card, 'web'))).toEqual(['web'])
    const web = linesOf(card, 'web')
    expect(web).toHaveLength(10 + 1)
    expect(web[9]).toEqual(['• change 10'])
    expect(web.flat().join('')).not.toContain('change 11')
    expect(web[10]).toEqual(['• and 2 more'])
    expect(linesOf(card, 'worker')).toEqual([['• one']])
    // No line relies on a newline inside a TextRun.
    expect(JSON.stringify(content(card).body)).not.toContain('\\n')
  })
  it('has no Changes section without commits', () => {
    expect(blocks(buildTeamsCard(facts())).map((b) => b.text)).not.toContain('Changes')
    expect(blocks(buildTeamsCard(facts({ changes: [{ deployment: 'web', subjects: [] }] }))).map((b) => b.text)).not.toContain('Changes')
  })
  it('subjects are plain text: never a markdown-rendering TextBlock', () => {
    const card = buildTeamsCard(facts({ changes: [{ deployment: 'web', subjects: ['[Release notes](https://evil.example) **bold**'] }] }))
    const hostile = JSON.stringify(blocks(card).filter((b) => (b.inlines ?? []).some((i) => i.text.includes('evil.example'))))
    expect(hostile).toContain('"type":"RichTextBlock"')
    // no TextBlock (which renders markdown) carries the subject
    expect(blocks(card).filter((b) => b.type === 'TextBlock').some((b) => (b.text ?? '').includes('evil.example'))).toBe(false)
  })
  it('truncates subjects to 120 chars and redacts secrets first', () => {
    const long = 'x'.repeat(200)
    const secret = 'hunter22-secret'
    const json = JSON.stringify(buildTeamsCard(facts({ changes: [{ deployment: 'web', subjects: [long, `${'y'.repeat(105)} ${secret}`] }] }), [secret]))
    expect(json).not.toContain(secret)
    expect(json).not.toContain('x'.repeat(121))
    expect(json).toContain(`${'x'.repeat(119)}…`)
  })
})

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

describe('buildTeamsCard operation summary', () => {
  it('an operation card is its title and one summary line: no facts, hosts, changes, notes or links', () => {
    const summary = 'Restart api on staging succeeded · 2 services'
    const card = buildTeamsCard(facts({ title: 'Operation Restart api on staging', summary, changes: [{ deployment: 'web', subjects: ['x'] }] }))
    const c = content(card)
    expect(c.body).toEqual([
      expect.objectContaining({ type: 'Container', items: [expect.objectContaining({ text: 'Operation Restart api on staging' })] }),
      { type: 'TextBlock', text: summary, wrap: true },
    ])
    expect(c.actions).toEqual([])
    const json = JSON.stringify(card)
    for (const leak of ['web-1', 'web, worker', 'grafana', 'Adds checkout', 'ashish@mbp']) expect(json).not.toContain(leak)
  })
})
