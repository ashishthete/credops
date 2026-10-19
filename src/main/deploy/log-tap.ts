import type { Client } from 'ssh2'
import { RUNS_SUBDIR } from './generate'

/* The live log: `tail -F` on the stream.log the generated playbook appends to. */

const REL_ID = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The tap runs as the login user, so `~` is the same home the playbook resolves with `$HOME`.
 * Under become the playbook looks the login user's home up in /etc/passwd via $SUDO_USER, which is that same directory.
 */
export function tapCommand(releaseId: string): string {
  if (!REL_ID.test(releaseId)) throw new Error('release id is not safe to use in a path')
  const dir = `~/${RUNS_SUBDIR}/${releaseId}`
  return `mkdir -p ${dir} && touch ${dir}/stream.log && exec tail -n +1 -F ${dir}/stream.log`
}

export const unavailableLine = (host: string): string => `Live output unavailable on ${host}; output will appear when each step ends`

export function startTap(link: Client, releaseId: string, onLine: (line: string) => void, opts: { host?: string } = {}): { stop(): void } {
  let stopped = false
  let warned = false
  let channel: { close(): void } | null = null
  const unavailable = (): void => {
    if (stopped || warned) return
    warned = true
    onLine(unavailableLine(opts.host ?? 'the host'))
  }
  let command: string
  try {
    command = tapCommand(releaseId)
  } catch {
    unavailable()
    return { stop() {} }
  }
  try {
    link.exec(command, (err, stream) => {
      if (err || !stream) return unavailable()
      if (stopped) return stream.close()
      channel = stream
      let buf = ''
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (!stopped) onLine(line)
        }
      })
      stream.stderr?.on('data', () => {})
      stream.on('error', unavailable)
      // tail -F never ends by itself: a close before stop() is a dropped link or a failed command.
      stream.on('close', unavailable)
    })
  } catch {
    unavailable()
  }
  return {
    stop() {
      stopped = true
      try {
        channel?.close()
      } catch {
        // already closed
      }
    },
  }
}
