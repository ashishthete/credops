import { describe, expect, it } from 'vitest'
import { promptContext, redactPrompt, redactPromptParts, type PromptRedactionContext } from '../../src/main/ai/prompt-redact'

const ctx = (over: Partial<PromptRedactionContext> = {}): PromptRedactionContext => ({
  knownSecrets: ['hunter22-vault-value'],
  usernames: ['ashish', 'deploy'],
  hostAddresses: ['db.internal.example'],
  ...over,
})

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'

const RAW = {
  vault: 'hunter22-vault-value',
  bearer: 'abcDEF123tokenvalue',
  sk: 'sk-ant-api03-AbCdEf0123456789xyz',
  ghp: 'ghp_0123456789abcdefghijABCDEFGHIJ',
  slack: 'xoxb-1234567890-abcdefghij',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  sendgrid: 'SG.abcdefghijklmnop1234.qrstuvwxyz0123456789',
  hex: '0123456789abcdef0123456789abcdef',
  dbPass: 's3cr3t-db',
  urlPass: 'p4ssw0rd',
  sig: 'deadbeefsig',
  email: 'ops@example.com',
  host: 'db.internal.example',
}

const LOG = [
  PEM,
  CERT,
  `vault value ${RAW.vault} leaked`,
  `Authorization: Bearer ${RAW.bearer}`,
  `jwt ${JWT}`,
  `anthropic ${RAW.sk} github ${RAW.ghp} slack ${RAW.slack}`,
  `aws ${RAW.aws} sendgrid ${RAW.sendgrid} digest ${RAW.hex}`,
  `DB_PASSWORD=${RAW.dbPass}`,
  `GET https://admin:${RAW.urlPass}@registry.example/v2?sig=${RAW.sig}&page=2`,
  `mail from ${RAW.email}`,
  `connect ${RAW.host}:5432 refused`,
  'web 10.0.0.4 refused; retry 10.0.0.4; peer 10.0.0.9',
  'listening on 127.0.0.1:5432 and 0.0.0.0:80',
  'home /Users/ashish/app and /home/runner/work',
  'ssh deploy@10.0.0.9',
].join('\n')

describe('redactPrompt', () => {
  it('redacts every secret shape and keeps diagnosis', () => {
    const { text, counts } = redactPrompt(LOG, ctx())
    for (const raw of [...Object.values(RAW), 'b3BlbnNzaC1rZXktdjEAAAAA', 'MIIBszCCAVmgAwIBAgIU', JWT, '10.0.0.4', '10.0.0.9', 'ashish', 'runner']) {
      expect(text, raw).not.toContain(raw)
    }
    expect(text).toContain('127.0.0.1:5432')
    expect(text).toContain('0.0.0.0:80')
    expect(text).toContain('web ‹ip-1› refused; retry ‹ip-1›; peer ‹ip-2›')
    expect(text).toContain('connect ‹host-1›:5432 refused')
    expect(text).toContain('https://‹redacted›@registry.example/v2?sig=‹redacted›&page=2')
    expect(text).toContain('DB_PASSWORD=‹redacted›')
    expect(text).toContain('/Users/‹user›/app and /home/‹user›/work')
    expect(text).toContain('ssh ‹user›@‹ip-2›')
    expect(text).toContain('mail from ‹email›')
    expect(counts).toEqual({ key: 2, secret: 1, url: 2, token: 8, env: 2, email: 1, user: 3, host: 1, ip: 4 })
  })

  it('compose environment block redacts every value', () => {
    const compose = [
      'services:',
      '  web:',
      '    image: acme/web:1.2',
      '    environment:',
      '      - FOO=bar',
      '      BAZ: qux',
      '    ports:',
      '      - "8080:80"',
    ].join('\n')
    const { text, counts } = redactPrompt(compose, ctx())
    expect(text).toContain('- FOO=‹redacted›')
    expect(text).toContain('BAZ: ‹redacted›')
    expect(text).toContain('image: acme/web:1.2')
    expect(text).toContain('- "8080:80"')
    expect(counts).toEqual({ env: 2 })
    // An env file: every assignment, whatever the name.
    expect(redactPrompt('PORT=8080\nGREETING=hello', ctx({ envBlocks: true })).text).toBe('PORT=‹redacted›\nGREETING=‹redacted›')
    // Outside a block only sensitive names lose their value.
    expect(redactPrompt('PORT=8080 API_KEY=abc', ctx()).text).toBe('PORT=8080 API_KEY=‹redacted›')
  })

  it('short known secrets only at word boundaries', () => {
    const { text, counts } = redactPrompt('pin 4321 and 943210 and x4321y', ctx({ knownSecrets: ['4321'] }))
    expect(text).toBe('pin ‹redacted› and 943210 and x4321y')
    expect(counts).toEqual({ secret: 1 })
  })

  it('usernames in paths and user@host', () => {
    const { text } = redactPrompt('/Users/ashish/x then deploy@10.0.0.4 as ashish', ctx({ hostAddresses: ['10.0.0.4'] }))
    expect(text).toBe('/Users/‹user›/x then ‹user›@‹host-1› as ‹user›')
  })

  it('IPv6 literals and bracketed forms', () => {
    const { text, counts } = redactPrompt('dial [fe80::1]:22 and 2001:db8::7 failed; ::1 ok; bind :: ok; at 12:30:45', ctx())
    expect(text).toBe('dial [‹ip-1›]:22 and ‹ip-2› failed; ::1 ok; bind :: ok; at 12:30:45')
    expect(counts).toEqual({ ip: 2 })
  })

  it('idempotent', () => {
    const once = redactPrompt(LOG, ctx())
    const twice = redactPrompt(once.text, ctx())
    expect(twice.text).toBe(once.text)
    expect(twice.counts).toEqual({})
  })

  it('parts share placeholders', () => {
    const { parts, counts } = redactPromptParts({ log: 'refused by 10.0.0.4 and 10.0.0.7', compose: 'DB_HOST=10.0.0.7' }, ctx())
    expect(parts).toEqual({ log: 'refused by ‹ip-1› and ‹ip-2›', compose: 'DB_HOST=‹ip-2›' })
    expect(counts).toEqual({ ip: 3 })
  })

  it('a hostile log cannot smuggle a placeholder', () => {
    const { text } = redactPrompt('peer ‹ip-1› said hi; real 10.0.0.4; fake ‹host-2› and ‹raw-0›', ctx())
    expect(text).toBe('peer <ip-1> said hi; real ‹ip-1›; fake <host-2> and <raw-0>')
  })

  it('placeholders are never re-matched by a username', () => {
    const { text } = redactPrompt('user at /home/user/x on host-1', ctx({ usernames: ['user', 'host', 'redacted'], hostAddresses: [] }))
    expect(text).toBe('‹user› at /home/‹user›/x on host-1')
  })
})

describe('promptContext', () => {
  it('reads live values each call', () => {
    let secrets = ['a-secret-1']
    const c = promptContext({
      knownSecrets: () => secrets,
      identities: { list: () => [{ username: 'deploy' }] },
      hosts: { list: () => [{ address: '10.0.0.4' }, { address: 'db.example' }] },
      osUser: () => 'ashish',
    })
    expect(c).toEqual({ knownSecrets: ['a-secret-1'], usernames: ['ashish', 'deploy'], hostAddresses: ['10.0.0.4', 'db.example'] })
    secrets = []
    expect(promptContext({ knownSecrets: () => secrets, identities: { list: () => [] }, hosts: { list: () => [] }, osUser: () => 'x' }).knownSecrets).toEqual([])
  })
})
