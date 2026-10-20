import { beforeEach, describe, expect, it } from 'vitest'
import { clearToolingCache, detectTools, toolingError, ToolingError } from '../../src/main/deploy/tooling'

const HOME = '/Users/ana'

function fake(files: Record<string, string>, version = 'ansible-playbook [core 2.18.6]\n  config file = None\n') {
  const calls: string[] = []
  return {
    calls,
    exists: async (p: string) => p in files,
    execFile: async (p: string, args: string[]) => {
      calls.push(`${p} ${args.join(' ')}`)
      return { stdout: version, stderr: '' }
    },
  }
}

const ALL = (dir: string): Record<string, string> => ({
  [`${dir}/ansible-playbook`]: '',
  [`${dir}/ssh-agent`]: '',
  [`${dir}/ssh-add`]: '',
  [`${dir}/ssh`]: '',
})

beforeEach(() => clearToolingCache())

describe('detectTools', () => {
  it('finds ansible in /opt/homebrew/bin when PATH is minimal', async () => {
    const f = fake({ ...ALL('/opt/homebrew/bin'), '/usr/bin/ssh': '', '/usr/bin/ssh-agent': '', '/usr/bin/ssh-add': '' })
    const t = await detectTools({ env: { PATH: '/usr/bin:/bin' }, home: HOME, ...f })
    expect(t.ansiblePlaybook).toEqual({ path: '/opt/homebrew/bin/ansible-playbook', version: '2.18.6' })
    expect(t.ssh).toBe('/usr/bin/ssh')
    expect(t.problems).toEqual([])
    expect(f.calls).toEqual(['/opt/homebrew/bin/ansible-playbook --version'])
  })

  it('prefers PATH, then the fixed directories in order', async () => {
    const f = fake({ '/custom/ansible-playbook': '', ...ALL('/usr/local/bin'), [`${HOME}/.local/bin/ssh`]: '' })
    const t = await detectTools({ env: { PATH: '/custom' }, home: HOME, ...f })
    expect(t.ansiblePlaybook?.path).toBe('/custom/ansible-playbook')
    expect(t.ssh).toBe('/usr/local/bin/ssh')
  })

  it('searches ~/.local/bin', async () => {
    const f = fake({ [`${HOME}/.local/bin/ansible-playbook`]: '' })
    const t = await detectTools({ env: {}, home: HOME, ...f })
    expect(t.ansiblePlaybook?.path).toBe(`${HOME}/.local/bin/ansible-playbook`)
  })

  it('missing ansible-playbook explains how to install', async () => {
    const t = await detectTools({ env: { PATH: '/usr/bin' }, home: HOME, ...fake({}) })
    expect(t.ansiblePlaybook).toBeNull()
    const err = toolingError(t)
    expect(err).toBeInstanceOf(ToolingError)
    expect(err?.code).toBe('ansible-missing')
    expect(err?.message).toBe(`Ansible isn't installed. Install it with "brew install ansible" (or "pipx install ansible-core"), then try again.`)
    expect(t.problems).toContain(err!.message)
  })

  it('too old version is rejected', async () => {
    const f = fake(ALL('/usr/bin'), 'ansible-playbook [core 2.12.10]\n')
    const t = await detectTools({ env: { PATH: '/usr/bin' }, home: HOME, ...f })
    expect(t.ansiblePlaybook).toBeNull()
    expect(t.problems).toContain('Ansible 2.12 is too old; OpsDeck needs ansible-core 2.14 or newer.')
    expect(toolingError(t)?.code).toBe('ansible-old')
  })

  it('accepts 2.14 exactly and reports a missing ssh-agent', async () => {
    const f = fake({ '/usr/bin/ansible-playbook': '', '/usr/bin/ssh': '' }, 'ansible-playbook [core 2.14.0]')
    const t = await detectTools({ env: { PATH: '/usr/bin' }, home: HOME, ...f })
    expect(t.ansiblePlaybook?.version).toBe('2.14.0')
    expect(t.sshAgent).toBeNull()
    expect(t.problems).toEqual(['ssh-agent was not found; OpsDeck needs the OpenSSH client tools.', 'ssh-add was not found; OpsDeck needs the OpenSSH client tools.'])
    expect(toolingError(t)).toBeNull()
  })

  it('reports an unreadable version instead of throwing', async () => {
    const f = { ...fake(ALL('/usr/bin')), execFile: async () => { throw new Error('boom') } }
    const t = await detectTools({ env: { PATH: '/usr/bin' }, home: HOME, ...f })
    expect(t.ansiblePlaybook).toBeNull()
    expect(t.problems[0]).toMatch(/Couldn't run/)
  })

  it('caches for 60 s and refreshes after', async () => {
    const f = fake(ALL('/usr/bin'))
    let now = 1000
    const opts = { env: { PATH: '/usr/bin' }, home: HOME, now: () => now, ...f }
    await detectTools(opts)
    await detectTools(opts)
    expect(f.calls).toHaveLength(1)
    now += 59_999
    await detectTools(opts)
    expect(f.calls).toHaveLength(1)
    now += 2
    await detectTools(opts)
    expect(f.calls).toHaveLength(2)
  })
})
