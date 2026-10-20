import { join } from 'node:path'
import type { Tooling } from '../../shared/deploy'

export const MIN_ANSIBLE = { major: 2, minor: 14 }
export const TOOLING_CACHE_MS = 60_000

export const ANSIBLE_MISSING = `Ansible isn't installed. Install it with "brew install ansible" (or "pipx install ansible-core"), then try again.`

export class ToolingError extends Error {
  constructor(
    readonly code: 'ansible-missing' | 'ansible-old' | 'ansible-broken',
    message: string,
  ) {
    super(message)
    this.name = 'ToolingError'
  }
}

export interface DetectOptions {
  env: Record<string, string | undefined>
  home: string
  execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>
  exists: (path: string) => boolean | Promise<boolean>
  now?: () => number
}

let cache: { at: number; value: Tooling } | null = null

export function clearToolingCache(): void {
  cache = null
}

/** PATH first, then the places a GUI app's minimal PATH misses. */
function searchDirs(o: DetectOptions): string[] {
  const dirs = [...(o.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', join(o.home, '.local/bin'), '/usr/bin']
  return [...new Set(dirs.filter((d) => d.startsWith('/')))]
}

async function find(name: string, dirs: string[], exists: DetectOptions['exists']): Promise<string | null> {
  for (const d of dirs) {
    const p = join(d, name)
    if (await exists(p)) return p
  }
  return null
}

const OLD = (v: string): string => `Ansible ${v} is too old; OpsDeck needs ansible-core 2.14 or newer.`

/** Detects the tools once per 60 s (cache; `now` is injectable). */
export async function detectTools(o: DetectOptions): Promise<Tooling> {
  const now = (o.now ?? Date.now)()
  if (cache && now - cache.at < TOOLING_CACHE_MS) return cache.value
  const dirs = searchDirs(o)
  const [ansible, sshAgent, sshAdd, ssh] = await Promise.all(['ansible-playbook', 'ssh-agent', 'ssh-add', 'ssh'].map((n) => find(n, dirs, o.exists)))
  const problems: string[] = []
  let ansiblePlaybook: Tooling['ansiblePlaybook'] = null
  let ansibleStatus: Tooling['ansibleStatus'] = 'ok'
  if (!ansible) {
    ansibleStatus = 'missing'
    problems.push(ANSIBLE_MISSING)
  }
  else {
    try {
      const { stdout } = await o.execFile(ansible, ['--version'])
      const m = /core\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout) ?? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout)
      if (!m) {
        ansibleStatus = 'broken'
        problems.push(`Couldn't read the Ansible version from ${ansible}.`)
      }
      else {
        const [major, minor] = [Number(m[1]), Number(m[2])]
        if (major < MIN_ANSIBLE.major || (major === MIN_ANSIBLE.major && minor < MIN_ANSIBLE.minor)) {
          ansibleStatus = 'old'
          problems.push(OLD(`${major}.${minor}`))
        }
        else ansiblePlaybook = { path: ansible, version: m[3] === undefined ? `${major}.${minor}` : `${major}.${minor}.${m[3]}` }
      }
    } catch {
      ansibleStatus = 'broken'
      problems.push(`Couldn't run ${ansible}. Check that the Ansible installation works.`)
    }
  }
  if (!sshAgent) problems.push('ssh-agent was not found; OpsDeck needs the OpenSSH client tools.')
  if (!sshAdd) problems.push('ssh-add was not found; OpsDeck needs the OpenSSH client tools.')
  if (!ssh) problems.push('ssh was not found; OpsDeck needs the OpenSSH client tools.')
  const value: Tooling = { ansiblePlaybook, ansibleStatus, sshAgent, sshAdd, ssh, problems }
  cache = { at: now, value }
  return value
}

/** The error a run start throws when ansible is unusable, else null. */
export function toolingError(t: Tooling): ToolingError | null {
  if (t.ansiblePlaybook) return null
  if (t.ansibleStatus === 'old') return new ToolingError('ansible-old', t.problems.find((p) => p.startsWith('Ansible ')) ?? t.problems[0])
  if (t.ansibleStatus === 'missing') return new ToolingError('ansible-missing', ANSIBLE_MISSING)
  return new ToolingError('ansible-broken', t.problems[0] ?? ANSIBLE_MISSING)
}
