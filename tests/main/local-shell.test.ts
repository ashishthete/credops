import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { spawnLocalShell } from '../../src/main/ssh/local-shell'
import { SessionManager, type Pty, type SessionManagerDeps } from '../../src/main/ssh/sessions'
import type { SessionMeta } from '../../src/shared/ssh'
import { makeVault } from './vault-helpers'

const base = { cols: 80, rows: 24, home: '/tmp', shell: '/bin/sh' }
const PATH = process.env.PATH

function spawn(env: Record<string, string | undefined> = { PATH }) {
  const pty = spawnLocalShell({ ...base, env })
  let out = ''
  let exited = false
  pty.onData((c) => (out += c.toString()))
  pty.onExit(() => (exited = true))
  onTestFinished(() => pty.kill())
  return {
    pty,
    out: () => out,
    exited: () => exited,
    waitFor: (text: string) =>
      vi.waitFor(
        () => {
          if (!out.includes(text)) throw new Error(`no ${text} in output`)
        },
        { timeout: 10_000, interval: 20 },
      ),
  }
}

describe('spawnLocalShell', () => {
  it('spawns a shell, runs a command, exits', async () => {
    const t = spawn()
    t.pty.write('echo opsdeck-$((40+2))\r')
    await t.waitFor('opsdeck-42')
    t.pty.write('exit\r')
    await vi.waitFor(() => expect(t.exited()).toBe(true), { timeout: 10_000 })
  })

  it('strips ELECTRON_ and NODE_OPTIONS and sets TERM', async () => {
    const t = spawn({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', PATH })
    t.pty.write('env; echo done-env\r')
    await t.waitFor('done-env\r')
    expect(t.out()).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(t.out()).not.toContain('NODE_OPTIONS')
    expect(t.out()).toContain('TERM=xterm-256color')
    expect(t.out()).toContain('COLORTERM=truecolor')
  })

  it('resize changes the pty size', async () => {
    const t = spawn()
    t.pty.resize(100, 40)
    t.pty.write('stty size\r')
    await t.waitFor('40 100')
  })

  it('failed native load is a clear error', () => {
    const load = (): never => {
      throw new Error('dlopen failed')
    }
    expect(() => spawnLocalShell({ ...base, env: {} }, load)).toThrow("The local shell isn't available: dlopen failed")
  })
})

describe('SessionManager local shell', () => {
  it('audits open and close; reconnect refused; numbering never repeats', async () => {
    const f = makeVault()
    await f.vault.setup('correct horse')
    const ptys: Pty[] = []
    const exits: Array<() => void> = []
    const manager = new SessionManager({
      openLocal: () => {
        const pty: Pty = {
          write: vi.fn(),
          resize: vi.fn(),
          onData: vi.fn(),
          onExit: (cb) => void exits.push(() => cb({ code: 0 })),
          kill: vi.fn(),
        }
        ptys.push(pty)
        return pty
      },
      audit: f.audit,
      emit: vi.fn(),
    } as unknown as SessionManagerDeps)
    onTestFinished(() => manager.closeAll('quit'))

    const a = manager.openLocal({ cols: 80, rows: 24 })
    const b = manager.openLocal({ cols: 80, rows: 24 })
    expect([a.label, b.label]).toEqual(['Local shell', 'Local shell 2'])
    expect(a).toMatchObject({ kind: 'local', hops: [], color: null, state: 'ready' })
    expect(() => manager.reconnect(a.id)).toThrow("A local shell can't be reconnected; open a new one")

    manager.close(a.id)
    const c = manager.openLocal({ cols: 80, rows: 24 })
    expect(c.label).toBe('Local shell 3')
    exits[1]()
    expect(manager.list().find((s: SessionMeta) => s.id === b.id)?.state).toBe('closed')

    const opens = f.audit.list({ actions: ['shell.open'] })
    const closes = f.audit.list({ actions: ['shell.close'] })
    expect(opens).toHaveLength(3)
    expect(closes).toHaveLength(2)
    expect(closes[0]).toMatchObject({ targetType: 'shell', targetLabel: 'Local shell' })
    expect(closes[0].details).toMatchObject({ reason: expect.stringMatching(/user|remote/), durationSec: expect.any(Number) })
  })
})
