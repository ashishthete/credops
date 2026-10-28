import type { Client } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { MAX_LOG_LINE, RUNS_SUBDIR } from '../../shared/deploy'

/* The live log: `tail -F` on the stream.log the generated playbook appends to. */

const REL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The tap runs as the login user, so `~` is the same home the playbook resolves with `$HOME`.
 * Under become the playbook looks the login user's home up in /etc/passwd via $SUDO_USER, which is that same directory.
 */
export function tapCommand(releaseId: string): string {
  if (!REL_ID.test(releaseId)) throw new Error('release id is not safe to use in a path')
  const dir = `~/${RUNS_SUBDIR}/${releaseId}`
  // The tap can win the race with the playbook's prep: create the tree the way prep does (umask 077, so ~/.opsdeck and
  // runs come out 0700 when new) and the run dir 0700 explicitly, or the log could be readable by other users.
  return `umask 077; mkdir -p -m 700 ${dir} && touch ${dir}/stream.log && exec tail -n +1 -F ${dir}/stream.log`
}

export const unavailableLine = (host: string): string => `Live output unavailable on ${host}; output will appear when each step ends`

export function startTap(link: Client, releaseId: string, onLine: (line: string) => void, opts: { host?: string } = {}): { stop(): void } {
  let stopped = false
  let warned = false
  let channel: { close(): void; signal?(name: string): unknown } | null = null
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
      const decoder = new StringDecoder('utf8')
      let buf = ''
      stream.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk)
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (!stopped) onLine(line)
        }
        // A line with no end in sight is emitted cut, not buffered without bound.
        if (buf.length > MAX_LOG_LINE) {
          if (!stopped) onLine(`${buf.slice(0, MAX_LOG_LINE - 7)} …(cut)`)
          buf = ''
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
        // Closing an exec channel without a pty doesn't stop the remote tail; ask it to.
        channel?.signal?.('TERM')
        channel?.close()
      } catch {
        // already closed
      }
    },
  }
}
