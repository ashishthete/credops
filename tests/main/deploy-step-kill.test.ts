import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generatePlaybook, streamed } from '../../src/main/deploy/generate'
import { RUNS_SUBDIR } from '../../src/shared/deploy'
import { planFixture } from './deploy-helpers'

/*
 * The cancel path for real, in bash: a streamed step started in its own session (as sshd starts each task's command)
 * records its process group; the unlock that follows a cancel stops it before it removes the run dir.
 */

const REL = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const RUN = 'run-1'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

/** What Ansible's templating does to the few expressions these commands use. */
const render = (cmd: string): string =>
  cmd
    .replaceAll('{{ d.run }}', RUN)
    .replaceAll('{{ od.rel }}', REL)
    .replaceAll("{{ od.lock_repos | map('quote') | join(' ') }}", '')

function home(): { home: string; runDir: string } {
  const h = mkdtempSync(join(tmpdir(), 'od-kill-'))
  cleanups.push(() => rmSync(h, { recursive: true, force: true }))
  const runDir = join(h, RUNS_SUBDIR, REL)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  return { home: h, runDir }
}

const unlockCmd = (): string => {
  const plays = JSON.parse(generatePlaybook(planFixture({ kind: 'unlock' }))) as { tasks: Record<string, { cmd: string }>[] }[]
  return render(plays[0].tasks[0]['ansible.builtin.shell'].cmd)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A detached bash: a new session and process group, like the one sshd gives each task's command. */
function group(cmd: string, env: NodeJS.ProcessEnv) {
  const child = spawn('/bin/bash', ['-c', cmd], { env, detached: true, stdio: 'ignore' })
  cleanups.push(() => {
    try {
      process.kill(-(child.pid as number), 'SIGKILL')
    } catch {
      /* gone */
    }
  })
  return child
}

describe('a cancelled streamed step', () => {
  it("keeps the body's exit code and removes its group file when it ends", () => {
    const { home: h, runDir } = home()
    const r = spawnSync('/bin/bash', ['-c', render(streamed('up', 'echo hi; exit 3'))], { env: { ...process.env, HOME: h }, encoding: 'utf8' })
    expect(r.status).toBe(3)
    expect(readFileSync(join(runDir, 'stream.log'), 'utf8')).toBe(`${RUN}:up\thi\n`)
    expect(readdirSync(runDir)).toEqual(['stream.log'])
  })

  it('is stopped by the unlock, which then removes the run dir', async () => {
    const { home: h, runDir } = home()
    const env = { ...process.env, HOME: h }
    const child = group(render(streamed('build', 'sleep 60')), env)
    const exited = new Promise<NodeJS.Signals | null>((res) => child.on('exit', (_c, sig) => res(sig)))
    const pf = join(runDir, `od-${RUN}-build.pgid`)
    await vi.waitFor(() => expect(existsSync(pf) && readFileSync(pf, 'utf8')).toBe(String(child.pid)), { timeout: 5000 })

    const r = spawnSync('/bin/bash', ['-c', unlockCmd()], { env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`stopped step process group ${child.pid}`)
    expect(await exited).toBe('SIGTERM')
    expect(existsSync(runDir)).toBe(false)
  })

  it("leaves a group alone once it is no longer the step's, and only drops the stale file", async () => {
    const { home: h, runDir } = home()
    const env = { ...process.env, HOME: h }
    // an unrelated process group whose number a stale file happens to hold
    const other = group('sleep 60', env)
    await vi.waitFor(() => expect(alive(other.pid as number)).toBe(true))
    writeFileSync(join(runDir, `od-${RUN}-up.pgid`), String(other.pid))
    const r = spawnSync('/bin/bash', ['-c', unlockCmd()], { env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('stopped step process group')
    expect(alive(other.pid as number)).toBe(true)
    expect(existsSync(runDir)).toBe(false)
  })
})
