import { describe, expect, it, vi } from 'vitest'
import { IntegrationError, type Fetch } from '../../src/main/notify/http'
import { buildReleaseEmail, sendEmail } from '../../src/main/notify/email'
import type { NotificationFacts } from '../../src/main/notify/teams'

const facts = (over: Partial<NotificationFacts> = {}): NotificationFacts => ({
  event: 'release.succeeded',
  title: 'shop 1.4.0 deployed to uat',
  environment: { name: 'uat', color: '#f59e0b', protected: true },
  product: 'shop',
  deployment: 'web',
  hosts: ['web-1'],
  status: 'succeeded',
  version: '1.4.0',
  durationSec: 61,
  urls: ['https://shop.uat.example'],
  actor: 'ashish@mbp',
  at: '2026-10-19T10:00:00.000Z',
  ...over,
})
const addr = { from: 'credops@acme.example', to: ['qa@acme.example', 'pm@acme.example'], cc: ['lead@acme.example', 'QA@acme.example'] }
const KEY = 'SG.abcdefghijklmnop1234.qrstuvwxyz0123456789'

describe('buildReleaseEmail', () => {
  it('builds subject, recipients and both bodies', () => {
    const body = buildReleaseEmail(facts(), '## Changes\n- Adds **retries**', addr)
    expect(body.subject).toBe('[shop] uat released 1.4.0')
    expect(body.from).toEqual({ email: 'credops@acme.example', name: 'CredOps' })
    // cc never repeats a to address (SendGrid rejects duplicates).
    expect(body.personalizations).toEqual([{ to: [{ email: 'qa@acme.example' }, { email: 'pm@acme.example' }], cc: [{ email: 'lead@acme.example' }] }])
    const [text, html] = body.content
    expect(text!.type).toBe('text/plain')
    expect(html!.type).toBe('text/html')
    expect(text!.value).toContain('Environment: uat (protected)')
    expect(text!.value).toContain('- Adds retries')
    expect(html!.value).toContain('<td style="padding:4px 12px 4px 0;color:#666">Version</td><td style="padding:4px 0">1.4.0</td>')
    expect(html!.value.indexOf('Version')).toBeLessThan(html!.value.indexOf('<strong>retries</strong>'))
    expect(html!.value).toContain('<a href="https://shop.uat.example/">https://shop.uat.example/</a>')
    expect(buildReleaseEmail(facts({ version: null }), null, { ...addr, cc: [] }).subject).toBe('[shop] uat redeployed')
    expect(buildReleaseEmail(facts({ product: null }), null, { ...addr, cc: [] }).personalizations[0]).toEqual({ to: addr.to.map((email) => ({ email })) })
    expect(buildReleaseEmail(facts({ product: null }), null, addr).subject).toBe('uat released 1.4.0')
  })

  it('subject without a version: update date with commits, redeployed with none (row 41)', () => {
    const started = new Date(2026, 9, 5, 14, 30).toISOString() // local 05-Oct-2026
    const subject = (over: Partial<NotificationFacts>) => buildReleaseEmail(facts({ version: null, ...over }), null, addr).subject
    expect(subject({ commitCount: 3, startedAt: started })).toBe('[shop] uat update: 05-Oct-2026 available for testing')
    expect(subject({ commitCount: 0, startedAt: started })).toBe('[shop] uat redeployed')
    expect(subject({ commitCount: 3, startedAt: null })).toBe('[shop] uat redeployed')
    expect(subject({ commitCount: 3, startedAt: started, product: null })).toBe('uat update: 05-Oct-2026 available for testing')
    // a version still wins
    expect(buildReleaseEmail(facts({ commitCount: 3, startedAt: started }), null, addr).subject).toBe('[shop] uat released 1.4.0')
  })

  it('lists changes in both bodies, capped at 10 with "and N more", and redacts secrets', () => {
    const subjects = Array.from({ length: 13 }, (_, i) => `change ${i + 1}`)
    subjects[0] = 'use token hunter22-secret'
    const body = buildReleaseEmail(facts({ changes: [{ deployment: 'web', subjects }] }), null, { ...addr, knownSecrets: ['hunter22-secret'] })
    const [text, html] = body.content
    expect(text!.value).toContain('Changes\nweb:\n- use token ')
    expect(text!.value).toContain('- change 10')
    expect(text!.value).not.toContain('change 11')
    expect(text!.value).toContain('- and 3 more')
    expect(html!.value).toContain('<li>and 3 more</li>')
    expect(JSON.stringify(body)).not.toContain('hunter22-secret')
  })

  it('escapes facts in html', () => {
    const html = buildReleaseEmail(facts({ title: '<img src=x onerror=1>', deployment: '"web"' }), null, addr).content[1]!.value
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).toContain('&quot;web&quot;')
  })

  it('notes are redacted before sending', () => {
    const body = buildReleaseEmail(facts({ title: 'deploy hunter22-secret' }), 'Rotated **hunter22-secret** today', { ...addr, knownSecrets: ['hunter22-secret'] })
    expect(JSON.stringify(body)).not.toContain('hunter22-secret')
    expect(body.content[0]!.value).toContain('Rotated ‹redacted› today')
  })
})

describe('sendEmail', () => {
  const body = buildReleaseEmail(facts(), null, addr)

  it('posts to SendGrid with a bearer key; 202 is success', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    await sendEmail(KEY, body, { fetch: fetch as unknown as Fetch, sleep: async () => {}, knownSecrets: [] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(String(init.body)).not.toContain(KEY)
    expect(JSON.parse(String(init.body))).toEqual(body)
  })

  it('401 maps to auth with fixed text', async () => {
    const fetch = vi.fn(async () => new Response('{"errors":[{"message":"bad key"}]}', { status: 401 }))
    const err = await sendEmail(KEY, body, { fetch: fetch as unknown as Fetch, sleep: async () => {}, knownSecrets: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IntegrationError)
    expect(err).toMatchObject({ service: 'sendgrid', code: 'auth', status: 401, message: 'SendGrid rejected the API key (HTTP 401)' })
  })

  it('key never in error or body log', async () => {
    const logged: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(...a))
    const fetch = vi.fn(async () => new Response(`echo ${KEY}`, { status: 500 }))
    const err = (await sendEmail(KEY, body, { fetch: fetch as unknown as Fetch, sleep: async () => {}, knownSecrets: [] }).catch((e: unknown) => e)) as IntegrationError
    spy.mockRestore()
    expect(err.message).toBe('SendGrid request failed (HTTP 500)')
    for (const s of [err.message, String(err), JSON.stringify(err), String(err.stack), JSON.stringify(logged)]) expect(s).not.toContain(KEY)
  })
})
