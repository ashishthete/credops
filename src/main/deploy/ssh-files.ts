import type { SshConfigMatch, SshConfigTarget } from '../inventory/ssh-config'
import { ALIAS, B64, need } from './quote'
import type { DeployPlan, PlanHop } from './runner'

const SSH_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/
const PATH_SAFE = /^\/[A-Za-z0-9._@+/-]*$/
const RUNDIR_SAFE = /^\/[A-Za-z0-9._@+/ -]+$/
const KEY_TYPE = /^[a-z0-9@.-]{1,64}$/
const KH_TOKEN = /^(?:\[[A-Za-z0-9.:_-]+\]:\d{1,5}|[A-Za-z0-9][A-Za-z0-9.:_-]*)$/

/* Inventory, ssh_config, known_hosts and ansible.cfg. Every value is validated and rejected, never escaped. */

// ---------------------------------------------------------------- inventory

export function generateInventory(plan: DeployPlan): string {
  const lines = plan.hosts.map((h) => {
    need(ALIAS.test(h.alias), 'host alias')
    return `${h.alias} ansible_python_interpreter=auto_silent`
  })
  return `[deploy]\n${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- ssh_config

const MAX_SOCKET = 103
const CP_AND_SUFFIX = 4 + 40 + 17

/** The longest control socket is `<rundir>/cp/<40 hex>` plus ssh's 17-byte temp suffix; macOS allows 103 bytes. */
export function socketPathFits(rundir: string): boolean {
  return Buffer.byteLength(rundir) + CP_AND_SUFFIX <= MAX_SOCKET
}

function checkRundir(rundir: string): void {
  need(RUNDIR_SAFE.test(rundir) && !rundir.includes('..') && !rundir.endsWith('/'), 'run directory')
  if (!socketPathFits(rundir)) throw new Error(`run directory is too long for a control socket (${Buffer.byteLength(rundir)} bytes); use a shorter one such as /tmp/od-XXXXXX`)
}

/** A path as an ssh_config / ssh argument value: bare when plain, double-quoted when it holds a space. */
function pathValue(p: string): string {
  return p.includes(' ') ? `"${p}"` : p
}

export interface SshConfigOptions {
  /** The user's own ~/.ssh/config, injected; the default reads nothing. */
  sshConfig?: (target: SshConfigTarget) => SshConfigMatch | null
}

const DEFAULT_KEYS = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa']

function hopBlock(hop: PlanHop, prev: PlanHop | null, socks: { privateAgent: string | null; userAgent: string | null }, rundir: string, opts: SshConfigOptions): string {
  need(ALIAS.test(hop.alias), 'hop alias')
  need(SSH_ADDRESS.test(hop.address), 'hop address')
  need(SSH_USER.test(hop.user), 'hop user')
  need(Number.isInteger(hop.port) && hop.port >= 1 && hop.port <= 65535, 'hop port')
  const lines = [`Host ${hop.alias}`, `  HostName ${hop.address}`, `  Port ${hop.port}`, `  User ${hop.user}`]
  if (prev) lines.push(`  ProxyJump ${prev.alias}`)
  if (hop.auth === 'key') {
    need(socks.privateAgent !== null && PATH_SAFE.test(socks.privateAgent.replace(/ /g, '')), 'private agent socket')
    lines.push(`  IdentityAgent ${pathValue(socks.privateAgent!)}`, '  IdentityFile none')
  } else {
    if (socks.userAgent === null) lines.push('  IdentityAgent none')
    else {
      need(PATH_SAFE.test(socks.userAgent.replace(/ /g, '')), 'agent socket')
      lines.push(`  IdentityAgent ${pathValue(socks.userAgent)}`)
    }
    const fromConfig = opts.sshConfig?.({ label: hop.label, address: hop.address })?.identityFiles ?? []
    const seen = new Set<string>()
    for (const f of [...fromConfig, ...DEFAULT_KEYS]) {
      if (seen.has(f) || !(f.startsWith('~/') ? PATH_SAFE.test(f.slice(1)) : PATH_SAFE.test(f)) || f.includes('%')) continue
      seen.add(f)
      lines.push(`  IdentityFile ${f}`)
    }
  }
  lines.push(
    '  PreferredAuthentications publickey',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  BatchMode yes',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${pathValue(`${rundir}/known_hosts`)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  ServerAliveInterval 15',
    '  ControlMaster auto',
    `  ControlPath ${pathValue(`${rundir}/cp/%C`)}`,
    '  ControlPersist 60',
  )
  return lines.join('\n')
}

export function generateSshConfig(
  plan: DeployPlan,
  socks: { privateAgent: string | null; userAgent: string | null },
  rundir: string,
  opts: SshConfigOptions = {},
): string {
  checkRundir(rundir)
  const blocks = new Map<string, { hop: PlanHop; prev: PlanHop | null }>()
  for (const h of plan.hosts)
    h.hops.forEach((hop, i) => {
      const prev = i > 0 ? h.hops[i - 1] : null
      const have = blocks.get(hop.alias)
      if (have && (have.prev?.alias !== prev?.alias || have.hop.address !== hop.address || have.hop.port !== hop.port || have.hop.user !== hop.user || have.hop.auth !== hop.auth))
        throw new Error(`deploy plan: alias ${hop.alias} is used for two different hops`)
      if (!have) blocks.set(hop.alias, { hop, prev })
    })
  return [...blocks.values()].map(({ hop, prev }) => hopBlock(hop, prev, socks, rundir, opts)).join('\n\n') + '\n'
}

// ---------------------------------------------------------------- known_hosts, cfg

/** known_hosts matches a non-22 port as `[addr]:port`. */
export function knownHostsToken(address: string, port: number): string {
  need(SSH_ADDRESS.test(address) && Number.isInteger(port) && port >= 1 && port <= 65535, 'known_hosts host')
  return port === 22 ? address : `[${address}]:${port}`
}

export function generateKnownHosts(entries: { token: string; keyType: string; keyBase64: string }[]): string {
  return entries
    .map((e) => {
      need(KH_TOKEN.test(e.token), 'known_hosts token')
      need(KEY_TYPE.test(e.keyType), 'key type')
      need(e.keyBase64.length > 0 && B64.test(e.keyBase64), 'host key')
      return `${e.token} ${e.keyType} ${e.keyBase64}`
    })
    .join('\n')
    .concat(entries.length ? '\n' : '')
}

export function generateAnsibleCfg(plan: DeployPlan, rundir: string): string {
  checkRundir(rundir)
  const forks = Math.max(1, Math.min(plan.hosts.length, 10))
  return [
    '[defaults]',
    'stdout_callback = opsdeck_jsonl',
    `callback_plugins = ${rundir}/callback_plugins`,
    'callbacks_enabled =',
    'host_key_checking = True',
    'retry_files_enabled = False',
    'interpreter_python = auto_silent',
    `forks = ${forks}`,
    'timeout = 30',
    '[ssh_connection]',
    'pipelining = True',
    `ssh_args = -F ${pathValue(`${rundir}/ssh_config`)}`,
    `control_path_dir = ${rundir}/cp`,
    '',
  ].join('\n')
}
