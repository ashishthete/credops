import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, describe, expect, it, vi } from 'vitest'
import type { AuthenticationType } from 'ssh2'
import type { IdentityRef } from '../../src/shared/inventory'
import { answerKeyboard, authHandler, authPlan } from '../../src/main/ssh/auth'
import { generateKey } from './ssh-server'
import type { AuthPlan } from '../../src/main/ssh/auth'

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'opsdeck-auth-'))
  onTestFinished(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, '.ssh'))
  return home
}
const keyText = (type: 'ed25519' | 'rsa', opts: object = {}): string => generateKey(type, opts).private
const noIdentities = { resolve: async () => { throw new Error('unused') } }
const globalId: IdentityRef = { source: 'global', username: 'ops', auth: 'default' }
const hostId = (auth: 'agent' | 'key' | 'password'): IdentityRef => ({
  source: 'host', identityId: 'i1', label: 'My identity', username: 'ops', auth, vaultId: 'v1',
})

describe('authPlan', () => {
  it('identity with agent auth uses SSH_AUTH_SOCK', async () => {
    const home = tmpHome()
    const sock = join(home, 'agent.sock')
    writeFileSync(sock, '')
    const identities = { resolve: async () => ({ username: 'ops', auth: 'agent' as const }) }
    const plan = await authPlan(hostId('agent'), { identities, env: { SSH_AUTH_SOCK: sock }, home })
    expect(plan.methods).toEqual([{ type: 'agent', agent: sock }])
    const none = await authPlan(hostId('agent'), { identities, env: {}, home })
    expect(none.methods).toEqual([])
    expect(none.notes).toContain("ssh-agent isn't running (SSH_AUTH_SOCK is not set)")
  })

  it('identity with key auth carries key and passphrase', async () => {
    const identities = { resolve: async () => ({ username: 'ops', auth: 'key' as const, privateKey: 'K', passphrase: 'P' }) }
    const plan = await authPlan(hostId('key'), { identities, env: {}, home: tmpHome() })
    expect(plan.methods).toEqual([{ type: 'publickey', label: 'My identity', key: 'K', passphrase: 'P' }])
  })

  it('identity with password auth', async () => {
    const identities = { resolve: async () => ({ username: 'ops', auth: 'password' as const, password: 'pw' }) }
    const plan = await authPlan(hostId('password'), { identities, env: {}, home: tmpHome() })
    expect(plan.methods).toEqual([{ type: 'password', password: 'pw' }])
    expect(plan.kind).toBe('password')
  })

  it('global default: agent, then id_ed25519, then id_rsa', async () => {
    const home = tmpHome()
    const sock = join(home, 'agent.sock')
    writeFileSync(sock, '')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), keyText('ed25519'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), keyText('rsa', { bits: 2048 }))
    const plan = await authPlan(globalId, { identities: noIdentities, env: { SSH_AUTH_SOCK: sock }, home })
    expect(plan.methods.map((m) => m.type)).toEqual(['agent', 'publickey', 'publickey'])
    expect(plan.methods.flatMap((m) => (m.type === 'publickey' ? [m.label] : []))).toEqual([
      '~/.ssh/id_ed25519',
      '~/.ssh/id_rsa',
    ])
    expect(plan.username).toBe('ops')
    expect(plan.kind).toBe('default')
  })

  it('global default skips encrypted, symlinked, oversize and missing keys with notes', async () => {
    const home = tmpHome()
    writeFileSync(join(home, '.ssh', 'id_ed25519'), keyText('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr' }))
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'x'.repeat(20000))
    const plan = await authPlan(globalId, { identities: noIdentities, env: {}, home })
    expect(plan.methods).toEqual([])
    expect(plan.notes).toEqual([
      "ssh-agent isn't running (SSH_AUTH_SOCK is not set)",
      '~/.ssh/id_ed25519 needs a passphrase: add it to ssh-agent (ssh-add) or link it in a vault',
      '~/.ssh/id_rsa is too large to be a key',
    ])
    expect(JSON.stringify(plan.notes)).not.toContain('secret')

    const other = tmpHome()
    writeFileSync(join(other, 'real'), keyText('ed25519'))
    symlinkSync(join(other, 'real'), join(other, '.ssh', 'id_ed25519'))
    const linked = await authPlan(globalId, { identities: noIdentities, env: {}, home: other })
    expect(linked.methods).toEqual([])
    expect(linked.notes).toEqual(["ssh-agent isn't running (SSH_AUTH_SOCK is not set)", '~/.ssh/id_ed25519 is a symlink, so it was skipped'])
  })
})

describe('authPlan: your SSH keys chain', () => {
  const agentId = hostId('agent')
  const agentIdentity = { resolve: async () => ({ username: 'ops', auth: 'agent' as const }) }
  const fakeSock = (home: string): string => {
    const sock = join(home, 'agent.sock')
    writeFileSync(sock, '')
    return sock
  }
  const labels = (plan: AuthPlan) => plan.methods.map((m) => (m.type === 'publickey' ? m.label : m.type))

  it('an agent identity with an empty agent falls back to ~/.ssh/id_ed25519 and id_rsa', async () => {
    const home = tmpHome()
    const sock = fakeSock(home)
    writeFileSync(join(home, '.ssh', 'id_ed25519'), keyText('ed25519'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), keyText('rsa', { bits: 2048 }))
    const agentKeys = vi.fn(async () => 0)
    const plan = await authPlan(agentId, { identities: agentIdentity, env: { SSH_AUTH_SOCK: sock }, home, agentKeys })
    expect(agentKeys).toHaveBeenCalledWith(sock)
    expect(labels(plan)).toEqual(['~/.ssh/id_ed25519', '~/.ssh/id_rsa'])
    expect(plan.tried).toEqual(['ssh-agent (no keys loaded)', '~/.ssh/id_ed25519', '~/.ssh/id_rsa'])
    expect(plan).toMatchObject({ username: 'ops', kind: 'agent', missing: [] })
  })

  it('an agent identity with no agent at all still tries the key files, and lists the missing ones', async () => {
    const home = tmpHome()
    writeFileSync(join(home, '.ssh', 'id_rsa'), keyText('rsa', { bits: 2048 }))
    const plan = await authPlan(agentId, { identities: agentIdentity, env: {}, home })
    expect(labels(plan)).toEqual(['~/.ssh/id_rsa'])
    expect(plan.tried).toEqual(['~/.ssh/id_rsa'])
    expect(plan.missing).toEqual(['~/.ssh/id_ed25519'])
    expect(plan.notes).toContain("ssh-agent isn't running (SSH_AUTH_SOCK is not set)")
  })

  it('an agent with keys goes first', async () => {
    const home = tmpHome()
    const sock = fakeSock(home)
    writeFileSync(join(home, '.ssh', 'id_rsa'), keyText('rsa', { bits: 2048 }))
    const plan = await authPlan(agentId, { identities: agentIdentity, env: { SSH_AUTH_SOCK: sock }, home, agentKeys: async () => 2 })
    expect(labels(plan)).toEqual(['agent', '~/.ssh/id_rsa'])
    expect(plan.tried).toEqual(['ssh-agent', '~/.ssh/id_rsa'])
  })

  it('an agent that cannot be asked is still offered', async () => {
    const home = tmpHome()
    const sock = fakeSock(home)
    const plan = await authPlan(agentId, { identities: agentIdentity, env: { SSH_AUTH_SOCK: sock }, home, agentKeys: async () => null })
    expect(plan.methods).toEqual([{ type: 'agent', agent: sock }])
  })

  it('~/.ssh/config IdentityFiles come before the default keys, once each, with the same checks', async () => {
    const home = tmpHome()
    const outside = tmpHome()
    writeFileSync(join(home, '.ssh', 'alpha_key'), keyText('ed25519'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), keyText('rsa', { bits: 2048 }))
    writeFileSync(join(outside, 'work_key'), keyText('ed25519'))
    symlinkSync(join(outside, 'work_key'), join(outside, 'linked_key'))
    writeFileSync(join(home, '.ssh', 'locked_key'), keyText('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr' }))
    const sshConfig = vi.fn(() => ({
      user: 'ubuntu',
      identityFiles: [
        join(home, '.ssh', 'alpha_key'),
        join(outside, 'work_key'),
        join(outside, 'linked_key'),
        join(home, '.ssh', 'locked_key'),
        join(home, '.ssh', 'gone_key'),
        join(home, '.ssh', 'id_rsa'),
      ],
    }))
    const target = { label: 'alpha', address: '203.0.113.23' }
    const plan = await authPlan(globalId, { identities: noIdentities, env: {}, home, sshConfig }, target)
    expect(sshConfig).toHaveBeenCalledWith(target)
    expect(labels(plan)).toEqual(['~/.ssh/alpha_key', join(outside, 'work_key'), '~/.ssh/id_rsa'])
    expect(plan.missing).toEqual(['~/.ssh/gone_key', '~/.ssh/id_ed25519'])
    expect(plan.notes).toEqual([
      "ssh-agent isn't running (SSH_AUTH_SOCK is not set)",
      `${join(outside, 'linked_key')} is a symlink, so it was skipped`,
      '~/.ssh/locked_key needs a passphrase: add it to ssh-agent (ssh-add) or link it in a vault',
    ])
    expect(JSON.stringify([plan.notes, plan.tried, plan.missing])).not.toContain('secret')
  })

  it('a missing or failing ~/.ssh/config lookup just skips that step', async () => {
    const home = tmpHome()
    writeFileSync(join(home, '.ssh', 'id_ed25519'), keyText('ed25519'))
    const throwing = () => {
      throw new Error('boom')
    }
    const plan = await authPlan(agentId, { identities: agentIdentity, env: {}, home, sshConfig: throwing }, { label: 'a', address: 'a' })
    expect(labels(plan)).toEqual(['~/.ssh/id_ed25519'])
  })
})

describe('authHandler', () => {
  const plan: AuthPlan = {
    username: 'ops',
    kind: 'default',
    notes: [],
    methods: [
      { type: 'agent', agent: '/s' },
      { type: 'publickey', label: 'k', key: 'K' },
    ],
  }

  it('order and single password ask', async () => {
    const askPassword = vi.fn(async () => 'typed')
    const h = authHandler(plan, askPassword)
    const next = vi.fn()
    h(null as never, false, next)
    expect(next).toHaveBeenLastCalledWith({ type: 'agent', username: 'ops', agent: '/s' })
    h(['publickey', 'password'], false, next)
    expect(next).toHaveBeenLastCalledWith({ type: 'publickey', username: 'ops', key: 'K' })
    const done = new Promise<void>((r) => next.mockImplementationOnce(() => r()))
    h(['publickey', 'password'], false, next)
    await done
    expect(next).toHaveBeenLastCalledWith({ type: 'password', username: 'ops', password: 'typed' })
    h(['publickey', 'password'], false, next)
    expect(next).toHaveBeenLastCalledWith(false)
    expect(askPassword).toHaveBeenCalledTimes(1)
  })

  it("skips methods the server doesn't offer", async () => {
    const askPassword = vi.fn(async () => 'typed')
    const h = authHandler(plan, askPassword)
    const done = new Promise<{ type?: string }>((r) => h(['password'], false, r as never))
    expect(await done).toMatchObject({ type: 'password', password: 'typed' })
  })

  it('a null answer ends the attempt', async () => {
    const h = authHandler({ ...plan, methods: [] }, async () => null)
    const done = new Promise((r) => h(['password'] as AuthenticationType[], false, r))
    expect(await done).toBe(false)
  })
})

describe('authHandler edge cases', () => {
  const empty: AuthPlan = { username: 'ops', kind: 'default', notes: [], methods: [] }
  const never = async (): Promise<string | null> => {
    throw new Error('not asked')
  }

  it("probes with 'none' when nothing is known and the plan is empty", () => {
    const next = vi.fn()
    authHandler(empty, never)(null as never, false, next)
    expect(next).toHaveBeenCalledWith('none')
  })

  it('ends the attempt when the server offers nothing', () => {
    const next = vi.fn()
    authHandler(empty, never)([], false, next)
    expect(next).toHaveBeenCalledWith(false)
  })

  it('a rejecting askPassword ends the attempt', async () => {
    const h = authHandler(empty, async () => {
      throw new Error('prompt closed')
    })
    expect(await new Promise((r) => h(['password'], false, r))).toBe(false)
  })
})

describe('authHandler keyboard-interactive', () => {
  type Prompt = { prompt: string; echo: boolean }
  const pw = (prompt = 'Password:'): Prompt => ({ prompt, echo: false })

  /** Calls the handler once and returns the method it chose. */
  const pick = (h: ReturnType<typeof authHandler>, left: AuthenticationType[] | null): Promise<unknown> =>
    new Promise((r) => h(left as never, false, r as never))
  /** Runs one keyboard-interactive round and resolves with the answers. */
  const round = (method: unknown, prompts: Prompt[]): Promise<string[]> =>
    new Promise((r) => {
      const m = method as { type: string; prompt: (...a: unknown[]) => void }
      expect(m.type).toBe('keyboard-interactive')
      m.prompt('Login', 'Answer these', '', prompts, r)
    })

  it('reuses a stored password for a keyboard-interactive-only server', async () => {
    const askPassword = vi.fn(async () => 'typed')
    const h = authHandler({ username: 'ops', kind: 'password', notes: [], methods: [{ type: 'password', password: 'stored' }] }, askPassword)
    // ssh2's first call knows nothing yet, so the stored password goes out as `password` first.
    expect(await pick(h, null)).toEqual({ type: 'password', username: 'ops', password: 'stored' })
    const m = await pick(h, ['keyboard-interactive'])
    expect(await round(m, [pw()])).toEqual(['stored'])
    expect(await pick(h, ['keyboard-interactive'])).toBe(false)
    expect(askPassword).not.toHaveBeenCalled()
  })

  it('a server offering kbd up front gets the stored password there directly', async () => {
    const askPassword = vi.fn(async () => 'typed')
    const h = authHandler({ username: 'ops', kind: 'password', notes: [], methods: [{ type: 'password', password: 'stored' }] }, askPassword)
    const m = await pick(h, ['keyboard-interactive'])
    expect(await round(m, [pw()])).toEqual(['stored'])
    expect(askPassword).not.toHaveBeenCalled()
  })

  it('the stored password answers the first round only; later rounds go to askKeyboard', async () => {
    const askKeyboard = vi.fn(async () => ['123456'])
    const h = authHandler(
      { username: 'ops', kind: 'password', notes: [], methods: [{ type: 'password', password: 'stored' }] },
      async () => 'typed',
      askKeyboard,
    )
    const m = await pick(h, ['keyboard-interactive'])
    expect(await round(m, [pw()])).toEqual(['stored'])
    expect(await round(m, [pw('OTP:')])).toEqual(['123456'])
    expect(askKeyboard).toHaveBeenCalledWith('Login', 'Answer these', [{ prompt: 'OTP:', echo: false }])
  })

  it("sends prompts answerKeyboard can't answer to askKeyboard", async () => {
    const askPassword = vi.fn(async () => 'typed')
    const askKeyboard = vi.fn(async () => ['alice', 'pw'])
    const h = authHandler({ username: 'ops', kind: 'default', notes: [], methods: [] }, askPassword, askKeyboard)
    const m = await pick(h, ['keyboard-interactive'])
    const prompts = [{ prompt: 'User:', echo: true }, pw()]
    expect(await round(m, prompts)).toEqual(['alice', 'pw'])
    expect(askKeyboard).toHaveBeenCalledWith('Login', 'Answer these', prompts)
    expect(askPassword).not.toHaveBeenCalled()
  })

  it('a null askKeyboard answer cancels: the attempt ends', async () => {
    const h = authHandler({ username: 'ops', kind: 'default', notes: [], methods: [] }, async () => 'typed', async () => null)
    const m = await pick(h, ['keyboard-interactive'])
    expect(await round(m, [pw('A:'), pw('B:')])).toEqual(['', ''])
    expect(await pick(h, ['keyboard-interactive'])).toBe(false)
  })

  it('asks for a password at most once across keyboard-interactive rounds and retries', async () => {
    const askPassword = vi.fn(async () => 'typed')
    const askKeyboard = vi.fn(async () => ['again'])
    const h = authHandler({ username: 'ops', kind: 'default', notes: [], methods: [] }, askPassword, askKeyboard)
    const m = await pick(h, ['keyboard-interactive'])
    expect(await round(m, [pw()])).toEqual(['typed'])
    expect(await round(m, [pw()])).toEqual(['again'])
    expect(await pick(h, ['keyboard-interactive', 'password'])).toBe(false)
    expect(askPassword).toHaveBeenCalledTimes(1)
  })
})

describe('answerKeyboard', () => {
  it('answers one non-echo prompt only', () => {
    expect(answerKeyboard([{ prompt: 'Password:', echo: false }], 'pw')).toEqual(['pw'])
    expect(answerKeyboard([{ prompt: 'a', echo: false }, { prompt: 'b', echo: false }], 'pw')).toBeNull()
    expect(answerKeyboard([{ prompt: 'User:', echo: true }], 'pw')).toBeNull()
  })
})
