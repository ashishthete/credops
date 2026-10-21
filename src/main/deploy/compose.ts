import { COMPOSE_FILE, COMPOSE_PROJECT, COMPOSE_SERVICE } from '../../shared/deploy'
import { shJoin } from '../ops/quote'

/*
 * The one place a `docker compose` command line is built: deploys (build, up), preflight and logs all go
 * through here. Every user value is checked against the shared validators and then shell-quoted, so none
 * can become an option or shell syntax. Errors name the field, never the value.
 */

export interface ComposeTarget {
  composeFile: string
  composeProject: string | null
}

/** Throws 'invalid compose service' on any bad name or duplicate. */
export function checkComposeServices(names: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const n of names) {
    if (typeof n !== 'string' || !COMPOSE_SERVICE.test(n) || seen.has(n)) throw new Error('invalid compose service')
    seen.add(n)
  }
  return [...names]
}

/**
 * The argv after `docker`: compose -f <file> [-p <project>] ...sub ...services. `sub` is the caller's
 * literal subcommand and flags (never user data); `services` is checked and appended after it.
 */
export function composeArgs(t: ComposeTarget, sub: readonly string[], services: readonly string[] = []): string[] {
  if (!COMPOSE_FILE.test(t.composeFile)) throw new Error('invalid compose file')
  if (t.composeProject !== null && !COMPOSE_PROJECT.test(t.composeProject)) throw new Error('invalid compose project')
  return ['compose', '-f', t.composeFile, ...(t.composeProject !== null ? ['-p', t.composeProject] : []), ...sub, ...checkComposeServices(services)]
}

/** Picks plain docker when it works, else `sudo -n docker`; `$D` is then left unquoted so it splits. */
const AUTO_DOCKER = "if docker info >/dev/null 2>&1; then D=docker; else D='sudo -n docker'; fi && $D"

/**
 * One shell command line. sudo false or absent: `docker …`; true: `sudo -n docker …`; 'auto': plain docker
 * when `docker info` works, else `sudo -n docker`. Deploy steps leave sudo off: Ansible's become applies.
 */
export function composeCommand(
  t: ComposeTarget,
  sub: readonly string[],
  services: readonly string[] = [],
  opts: { sudo?: boolean | 'auto' } = {},
): string {
  const args = shJoin(composeArgs(t, sub, services))
  if (opts.sudo === 'auto') return `${AUTO_DOCKER} ${args}`
  return `${opts.sudo === true ? 'sudo -n docker' : 'docker'} ${args}`
}
