/** A run of log text with one style; `fg` names a palette colour, never a raw value. */
export interface AnsiSegment {
  text: string
  fg?: string
  bold?: boolean
}

const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
// CSI sequences, OSC strings (ended by BEL or ST) and the two-byte escapes.
const ESCAPE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** Splits a line into styled runs: SGR colours 30–37 and 90–97 and bold; every other escape is dropped. */
export function parseAnsi(line: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  let fg: string | undefined
  let bold = false
  const add = (text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.fg === fg && !!last.bold === bold) {
      last.text += text
      return
    }
    const seg: AnsiSegment = { text }
    if (fg) seg.fg = fg
    if (bold) seg.bold = true
    out.push(seg)
  }
  let at = 0
  for (const m of line.matchAll(ESCAPE)) {
    add(line.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] !== 'm' || !/^[\d;]*$/.test(m[1] ?? '')) continue
    for (const p of (m[1] || '0').split(';')) {
      const n = Number(p || 0)
      if (n === 0) {
        fg = undefined
        bold = false
      } else if (n === 1) bold = true
      else if (n === 22) bold = false
      else if (n === 39) fg = undefined
      else if (n >= 30 && n <= 37) fg = BASE[n - 30]
      else if (n >= 90 && n <= 97) fg = `bright-${BASE[n - 90]}`
    }
  }
  add(line.slice(at))
  return out.length ? out : [{ text: '' }]
}

export const stripAnsi = (line: string): string => line.replace(ESCAPE, '')
