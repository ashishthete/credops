import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpts } from './ssh-server'

export interface ShellHost {
  /** The tmp dir every command runs in; also its `HOME`. */
  dir: string
  /** Holds the fake `docker`, first on `PATH`. */
  bin: string
  /** The fake docker's fixtures: `<subcommand>.out`, `.err` and `.code` (the exit code, 0 when absent). */
  fixtures: string
  /** The fake docker appends each argument it receives here, one per line. */
  dockerLog: string
  onExec: NonNullable<ServerOpts['onExec']>
  /** Children still running. */
  running(): number
  /** Kills what is still running and removes the tmp dir. */
  close(): void
}

/**
 * A fake `docker`: only shell builtins, and it never runs another program by name, so it can't fall
 * through to a real docker. `ps`, `logs`, `start`, `stop` and `restart` answer from fixture files.
 */
const fakeDocker = (fixtures: string, log: string): string => `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done
case "$1" in
  ps|logs|start|stop|restart) f='${fixtures}'/"$1" ;;
  *) printf 'docker: unknown command\\n' >&2; exit 127 ;;
esac
if [ -f "$f.out" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$f.out"; fi
if [ -f "$f.err" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l" >&2; done < "$f.err"; fi
code=0
if [ -f "$f.code" ]; then read -r code < "$f.code"; fi
exit "$code"
`

/**
 * An `onExec` that runs each received command with the local `/bin/sh -c`, so tests see real shell
 * parsing of what OpsDeck sends while staying on localhost. The env is built from scratch (nothing
 * from `process.env`): the channel's env, then `PATH` = the tmp `bin` plus /usr/bin:/bin, `HOME` = the
 * tmp dir and `LANG=C`, which the channel can't override. A channel `signal` reaches the child; a
 * channel close kills it.
 */
export function shellExec(): ShellHost {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-exec-'))
  const bin = join(dir, 'bin')
  const fixtures = join(dir, 'docker')
  const dockerLog = join(dir, 'docker.log')
  mkdirSync(bin)
  mkdirSync(fixtures)
  writeFileSync(join(bin, 'docker'), fakeDocker(fixtures, dockerLog))
  chmodSync(join(bin, 'docker'), 0o755)
  const children = new Set<ChildProcess>()

  const onExec: ShellHost['onExec'] = (command, stream, info) => {
    const env = { ...info.env, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, LANG: 'C' }
    const child = spawn('/bin/sh', ['-c', command], { cwd: dir, env, stdio: 'pipe' })
    children.add(child)
    let open = true
    stream.on('close', () => {
      open = false
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    info.onSignal((name) => {
      if (/^[A-Z]+$/.test(name)) child.kill(`SIG${name}` as NodeJS.Signals)
    })
    stream.on('data', (d: Buffer) => child.stdin.write(d))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d: Buffer) => open && stream.write(d))
    child.stderr.on('data', (d: Buffer) => open && stream.stderr.write(d))
    child.on('close', (code, signal) => {
      children.delete(child)
      if (!open) return
      if (signal) stream.exit(signal.replace(/^SIG/, ''), false, '')
      else stream.exit(code ?? 0)
      stream.end()
    })
  }

  return {
    dir,
    bin,
    fixtures,
    dockerLog,
    onExec,
    running: () => children.size,
    close: () => {
      for (const child of children) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
