import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startPrivateAgent, type PrivateAgent, type SpawnFn } from '../../src/main/deploy/agent'

const BIN = { agent: '/usr/bin/ssh-agent', add: '/usr/bin/ssh-add', keygen: '/usr/bin/ssh-keygen' }
const have = Object.values(BIN).every((p) => existsSync(p))
const PASS = 'correct horse battery 42'

const root = have ? mkdtempSync('/tmp/od-real-') : ''
const agentDir = have ? mkdtempSync('/tmp/od-') : ''
let agent: PrivateAgent | null = null
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  // no agent process is left running, even when a test failed
  await agent?.stop().catch(() => {})
  if (agent?.pid) {
    try {
      process.kill(agent.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const d of [root, agentDir]) if (d) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(!have)('real ssh-agent and ssh-add', () => {
  it('adds an encrypted key through a string, lists it on the private socket, and stop removes it', async () => {
    const cleanEnv = { PATH: '/usr/bin:/bin', HOME: root }
    const keyFile = join(root, 'k')
    const gen = spawnSync(BIN.keygen, ['-q', '-t', 'ed25519', '-N', PASS, '-f', keyFile, '-C', 'od-test'], { env: cleanEnv })
    expect(gen.status).toBe(0)
    const privateKey = readFileSync(keyFile, 'utf8')
    unlinkSync(keyFile) // only the string is left

    const real: SpawnFn = (file, args, opts) => spawn(file, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }) as never
    agent = await startPrivateAgent({ dir: agentDir, tools: { sshAgent: BIN.agent, sshAdd: BIN.add }, spawn: real, ttlSec: 120, addTimeoutMs: 3000, env: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: undefined } })
    expect(agent.pid).toBeGreaterThan(0)

    await expect(agent.add({ privateKey, passphrase: 'wrong passphrase' })).rejects.toThrow(/ssh-add/)
    await agent.add({ privateKey, passphrase: PASS })

    const list = spawnSync(BIN.add, ['-l'], { env: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: agent.sock }, encoding: 'utf8' })
    expect(list.status).toBe(0)
    expect(list.stdout.trim().split('\n')).toHaveLength(1)
    expect(list.stdout).toContain('ED25519')
    expect(list.stdout).toContain('od-test')

    const pid = agent.pid!
    await agent.stop()
    expect(existsSync(agent.sock)).toBe(false)
    expect(alive(pid)).toBe(false)
  }, 30_000)
})
