import type { RunHostMeta } from '../../../shared/ops'
import { appendOutput, type HostOutput } from './runs'
import { isLive } from './status'

/** Where the interleaved stream has got to for one host. */
interface Cursor {
  total: number
  /** The current line so far, as [text, stderr] pieces; it is written out once its newline arrives. */
  line: [string, boolean][]
}

export interface Merged {
  runId: string
  sources: Record<string, HostOutput> | undefined
  cursors: Record<string, Cursor>
  out: HostOutput | undefined
}

/** The pieces of `out.text` from `from` on, split where stderr starts and stops. */
function piecesFrom(out: HostOutput, from: number): [string, boolean][] {
  const pieces: [string, boolean][] = []
  let at = from
  for (const [a, b] of out.errRanges) {
    if (b <= at) continue
    if (a > at) pieces.push([out.text.slice(at, a), false])
    pieces.push([out.text.slice(Math.max(a, at), b), true])
    at = b
  }
  if (at < out.text.length) pieces.push([out.text.slice(at), false])
  return pieces
}

/**
 * Folds new output from every host into one stream of whole lines, each under its host's label, in the
 * order they arrive. A host that went back (a reload) or skipped what the text holds starts over.
 */
export function interleave(prev: Merged, runId: string, sources: Record<string, HostOutput> | undefined, hosts: RunHostMeta[]): Merged {
  const fresh = prev.runId !== runId
  const cursors: Record<string, Cursor> = fresh ? {} : { ...prev.cursors }
  let out = fresh ? undefined : prev.out
  const write = (label: string, line: [string, boolean][]) => {
    out = appendOutput(out, `${label} │ `, false)
    for (const [t, err] of line) out = appendOutput(out, t, err)
    // A colour one host left on must not run on into the next host's label and line.
    if (line.some(([t]) => t.includes('\u001b'))) out = appendOutput(out, '\u001b[0m', false)
  }
  for (const h of hosts) {
    const src = sources?.[h.hostId]
    let cur = cursors[h.hostId] ?? { total: 0, line: [] }
    if (src) {
      let delta = src.total - cur.total
      if (delta < 0 || delta > src.text.length) {
        cur = { total: 0, line: [] }
        delta = Math.min(src.total, src.text.length)
      }
      if (delta > 0) {
        const line = [...cur.line]
        for (const [text, err] of piecesFrom(src, src.text.length - delta)) {
          const parts = text.split('\n')
          parts.forEach((p, i) => {
            if (p) line.push([p, err])
            if (i < parts.length - 1) {
              line.push(['\n', err])
              write(h.label, line)
              line.length = 0
            }
          })
        }
        cur = { total: src.total, line }
      }
    }
    // A finished host's last line has no newline coming.
    if (!isLive(h.state) && h.state !== 'queued' && cur.line.length) {
      write(h.label, [...cur.line, ['\n', false]])
      cur = { ...cur, line: [] }
    }
    cursors[h.hostId] = cur
  }
  return { runId, sources, cursors, out }
}

/** Nothing merged yet. */
export const NO_MERGE: Merged = { runId: '', sources: undefined, cursors: {}, out: undefined }
