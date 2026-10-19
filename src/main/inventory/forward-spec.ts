import { MAX_LABEL } from '../../shared/vault'
import type { SshForward } from '../../shared/inventory'
import type { TunnelInput } from '../../shared/tunnels'

export type ForwardParse = { input: Omit<TunnelInput, 'hostId'> } | { error: string }

const UNREADABLE = "can't read this forward"
const PORT = /^\d{1,5}$/

/** `[bind:]port` or `[v6]:port`; the bind address defaults to loopback and `*` means every address. */
function parseListen(s: string): { bindAddress: string; bindPort: number } | null {
  let host = '127.0.0.1'
  let port: string
  if (s.startsWith('[')) {
    const m = /^\[([^\]]*)\]:(\d+)$/.exec(s)
    if (!m || m[1] === '') return null
    host = m[1]
    port = m[2]
  } else {
    const i = s.lastIndexOf(':')
    port = i < 0 ? s : s.slice(i + 1)
    if (i >= 0) host = s.slice(0, i)
    if (host === '' || host.includes(':')) return null
  }
  if (!PORT.test(port) || Number(port) > 65535) return null
  return { bindAddress: host === '*' ? '0.0.0.0' : host, bindPort: Number(port) }
}

/** `host:port` or `[v6]:port`. */
function parseTarget(s: string): { targetHost: string; targetPort: number } | null {
  const m = s.startsWith('[') ? /^\[([^\]]+)\]:(\d+)$/.exec(s) : /^([^:[\]]+):(\d+)$/.exec(s)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return null
  return { targetHost: m[1], targetPort: Number(m[2]) }
}

/**
 * One ssh config forward as a tunnel. The label never holds the target host, because tunnel audit
 * events carry the label.
 */
export function parseForwardSpec(f: SshForward, alias: string): ForwardParse {
  if (f.spec.includes('/')) return { error: "unix socket forwards aren't supported" }
  const args = f.spec.trim().split(/\s+/).filter(Boolean)
  if (f.type === 'R' && args.length === 1) return { error: "reverse dynamic forwards aren't supported" }
  if (args.length !== (f.type === 'D' ? 1 : 2)) return { error: UNREADABLE }
  const listen = parseListen(args[0])
  if (!listen) return { error: UNREADABLE }
  const base = { type: f.type, ...listen, autoStart: false, autoReconnect: true }
  if (f.type === 'D') {
    return { input: { ...base, label: `${alias} SOCKS ${listen.bindPort}`.slice(0, MAX_LABEL) } }
  }
  const target = parseTarget(args[1])
  if (!target) return { error: UNREADABLE }
  return { input: { ...base, ...target, label: `${alias} ${f.type} ${listen.bindPort}`.slice(0, MAX_LABEL) } }
}
