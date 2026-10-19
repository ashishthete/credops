import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { childEnv, startPrivateAgent, type ChildLike, type SpawnFn } from '../../src/main/deploy/agent'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync('/tmp/od-')
  dirs.push(d)
  return d
}

class Fake extends EventEmitter implements ChildLike {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  stdinChunks: string[] = []
  stdinEnded = false
  killed: string | null = null
  stdin = {
    write: (c: string | Buffer) => {
      this.stdinChunks.push(String(c))
      return true
    },
    end: () => {
      this.stdinEnded = true
    },
  }
  kill(sig?: string): boolean {
    this.killed = sig ?? 'SIGTERM'
    setImmediate(() => this.emit('exit', null, this.killed))
    return true
  }
}

interface Call {
  file: string
  args: string[]
  env: Record<string, string>
  child: Fake
}

/** Agent child creates its socket file; ssh-add child exits when stdin ends (or with `addExit`). */
function fakeSpawn(addExit = 0, addStderr = ''): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: SpawnFn = (file, args, opts) => {
    const child = new Fake()
    calls.push({ file, args, env: opts.env, child })
    if (file.endsWith('ssh-agent')) {
      writeFileSync(args[args.indexOf('-a') + 1], '')
    } else {
      child.stdin.end = () => {
        child.stdinEnded = true
        setImmediate(() => {
          if (addStderr) child.stderr.emit('data', Buffer.from(addStderr))
          child.emit('exit', addExit, null)
        })
      }
    }
    return child
  }
  return { spawn, calls }
}

const tools = { sshAgent: '/usr/bin/ssh-agent', sshAdd: '/usr/bin/ssh-add' }
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1lZDI1NTE5AAAAIHVuaXF1ZWtleW1hdGVyaWFsMTIz\n-----END OPENSSH PRIVATE KEY-----'

describe('private agent', () => {
  it('ssh-add receives the key on stdin, never argv, and env holds only the allowed vars', async () => {
    const dir = tmp()
    const { spawn, calls } = fakeSpawn()
    const agent = await startPrivateAgent({ dir, tools, spawn, ttlSec: 900, env: { PATH: '/usr/bin:/bin', HOME: '/home/me', SSH_AUTH_SOCK: '/real/agent', AWS_SECRET: 'x' } })
    expect(agent.sock).toBe(join(dir, 'a'))
    const a = calls[0]
    expect(a.args).toEqual(['-D', '-a', join(dir, 'a')])
    expect(a.env).toEqual({ PATH: '/usr/bin:/bin' })

    await agent.add({ privateKey: KEY, passphrase: 'pass-phrase-123' })
    const add = calls[1]
    expect(add.file).toBe(tools.sshAdd)
    expect(add.args).toEqual(['-t', '900', '-'])
    expect(add.child.stdinChunks.join('')).toContain('AAAAB3NzaC1lZDI1NTE5')
    expect(add.child.stdinChunks.join('').endsWith('\n')).toBe(true)
    expect(add.args.join(' ')).not.toContain('AAAAB3')
    expect(add.args.join(' ')).not.toContain('pass-phrase-123')
    expect(add.env).toEqual({
      SSH_AUTH_SOCK: join(dir, 'a'),
      SSH_ASKPASS: join(dir, 'askpass'),
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: 'none',
      OPSDECK_ASKPASS: 'pass-phrase-123',
    })
    // the passphrase is in the ssh-add env only
    expect(JSON.stringify(a)).not.toContain('pass-phrase-123')
    await agent.stop()
  })

  it('an unencrypted key sets no OPSDECK_ASKPASS', async () => {
    const { spawn, calls } = fakeSpawn()
    const agent = await startPrivateAgent({ dir: tmp(), tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })
    await agent.add({ privateKey: KEY })
    expect(calls[1].env).not.toHaveProperty('OPSDECK_ASKPASS')
    await agent.stop()
  })

  it('askpass script contains no secret', async () => {
    const dir = tmp()
    const { spawn } = fakeSpawn()
    const agent = await startPrivateAgent({ dir, tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })
    await agent.add({ privateKey: KEY, passphrase: 'pass-phrase-123' })
    const path = join(dir, 'askpass')
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('pass-phrase-123')
    expect(text).toContain('$OPSDECK_ASKPASS')
    expect(statSync(path).mode & 0o777).toBe(0o700)
    await agent.stop()
  })

  it('stop kills the agent and removes the socket and askpass', async () => {
    const dir = tmp()
    const { spawn, calls } = fakeSpawn()
    const agent = await startPrivateAgent({ dir, tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })
    expect(existsSync(join(dir, 'a'))).toBe(true)
    await agent.stop()
    expect(calls[0].child.killed).toBe('SIGTERM')
    expect(existsSync(join(dir, 'a'))).toBe(false)
    expect(existsSync(join(dir, 'askpass'))).toBe(false)
    await agent.stop() // idempotent
  })

  it('a failing ssh-add rejects with a redacted message', async () => {
    const dir = tmp()
    const { spawn } = fakeSpawn(1, `Error loading key "(stdin)": bad passphrase pass-phrase-123\nAAAAB3NzaC1lZDI1NTE5AAAAIHVuaXF1ZWtleW1hdGVyaWFsMTIz`)
    const agent = await startPrivateAgent({ dir, tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })
    const err = await agent.add({ privateKey: KEY, passphrase: 'pass-phrase-123' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const m = (err as Error).message
    expect(m).toContain('ssh-add')
    expect(m).not.toContain('pass-phrase-123')
    expect(m).not.toContain('AAAAB3NzaC1lZDI1NTE5')
    await agent.stop()
  })

  it('kills a hung ssh-add after addTimeoutMs and rejects', async () => {
    const calls: { file: string; child: Fake }[] = []
    const spawn: SpawnFn = (file, args) => {
      const child = new Fake()
      calls.push({ file, child })
      if (file.endsWith('ssh-agent')) writeFileSync(args[args.indexOf('-a') + 1], '')
      else child.stdin.end = () => {} // never exits on its own
      return child
    }
    const agent = await startPrivateAgent({ dir: tmp(), tools, spawn, ttlSec: 60, env: { PATH: '/bin' }, addTimeoutMs: 20 })
    await expect(agent.add({ privateKey: KEY, passphrase: 'x' })).rejects.toThrow(/timed out/)
    expect(calls[1].child.killed).toBe('SIGKILL')
    await agent.stop()
  })

  it('concurrent stops share one shutdown', async () => {
    const { spawn, calls } = fakeSpawn()
    const agent = await startPrivateAgent({ dir: tmp(), tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })
    const a = agent.stop()
    const b = agent.stop()
    expect(a).toBe(b)
    await a
    expect(calls[0].child.killed).toBe('SIGTERM')
  })

  it('refuses a directory whose socket path would not fit', async () => {
    const { spawn } = fakeSpawn()
    await expect(startPrivateAgent({ dir: `/tmp/${'x'.repeat(80)}`, tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })).rejects.toThrow(/too long/)
  })

  it('fails when the agent exits before its socket appears', async () => {
    const spawn: SpawnFn = () => {
      const c = new Fake()
      setImmediate(() => c.emit('exit', 1, null))
      return c
    }
    await expect(startPrivateAgent({ dir: tmp(), tools, spawn, ttlSec: 60, env: { PATH: '/bin' } })).rejects.toThrow(/ssh-agent/)
  })

  it('childEnv keeps only allowed, defined names', () => {
    expect(childEnv({ A: '1', B: '2', C: undefined }, ['A', 'C', 'D'])).toEqual({ A: '1' })
  })
})
