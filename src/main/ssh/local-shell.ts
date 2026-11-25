import type { Pty } from './sessions'

type NodePty = typeof import('node-pty')

export interface LocalShellOptions {
  cols: number
  rows: number
  env: Record<string, string | undefined>
  home: string
  shell?: string
}

/** The Electron runtime's own variables must not leak into the user's shell. */
const isInternal = (name: string): boolean => name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS'

/**
 * Starts a login shell in a pty. node-pty is loaded here, not at startup, so a failed native
 * load is an error on open instead of a crash.
 */
export function spawnLocalShell(opts: LocalShellOptions, load: () => NodePty = () => require('node-pty')): Pty {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(opts.env)) if (value !== undefined && !isInternal(name)) env[name] = value
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  try {
    const term = load().spawn(opts.shell || opts.env.SHELL || '/bin/zsh', ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.home,
      env,
    })
    return {
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      onData: (cb) => void term.onData(cb),
      onExit: (cb) => void term.onExit(({ exitCode }) => cb({ code: exitCode })),
      kill: () => term.kill(),
      pause: () => term.pause(),
      resume: () => term.resume(),
    }
  } catch (err) {
    throw new Error(`The local shell isn't available: ${err instanceof Error ? err.message : String(err)}`)
  }
}
