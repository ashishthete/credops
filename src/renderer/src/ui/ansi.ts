const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
type Base = (typeof BASE)[number]
/** The 16 terminal colours; each is a theme token (`--ansi-<name>`), never a value taken from the output. */
export type AnsiColor = Base | `bright-${Base}`
export const ANSI_COLORS: readonly AnsiColor[] = [...BASE, ...BASE.map((b) => `bright-${b}` as const)]

/** A run of output text with one style. */
export interface AnsiSegment {
  text: string
  fg?: AnsiColor
  bold?: boolean
}

/** A segment of one scanned piece of text; `at` is where its first char sits in that text. */
export interface AnsiRun extends AnsiSegment {
  at: number
}

/** The style in force where a piece of text ends, and an escape it cut off half-way (finished by the next piece). */
export interface AnsiState {
  fg?: AnsiColor
  bold: boolean
  carry: string
}

export const ANSI_START: AnsiState = { bold: false, carry: '' }

/** The colour a style's `fg` paints with. */
export const ansiColor = (c: AnsiColor): string => `var(--ansi-${c})`

// CSI sequences (cursor moves, erases, SGR), OSC strings (titles, links) ended by BEL or ST, DCS/SOS/PM/APC
// strings, the other escapes (charset picks, save/restore cursor), then any lone control char but tab, LF and CR.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[ -/]*[0-~])|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
/** An escape the text ends in the middle of. */
// eslint-disable-next-line no-control-regex
const TAIL = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?|[PX^_][^\u001b]*\u001b?|[ -/]*)$/
/** A cut-off escape longer than this is not one: it is dropped rather than held back. */
const MAX_CARRY = 256

/** xterm's values for the 16 colours, to pick the nearest for a 256-colour or RGB code. */
const RGB: [number, number, number][] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]
const CUBE = [0, 95, 135, 175, 215, 255]

function nearest(r: number, g: number, b: number): AnsiColor {
  let best = 0
  let bestD = Infinity
  RGB.forEach(([R, G, B], i) => {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return ANSI_COLORS[best]
}

/** A 256-colour index as one of the 16: the cube and the grey ramp go to the nearest. */
export function color256(n: number): AnsiColor | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
  if (n < 16) return ANSI_COLORS[n]
  if (n < 232) {
    const i = n - 16
    return nearest(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6])
  }
  const v = 8 + 10 * (n - 232)
  return nearest(v, v, v)
}

/** Applies one SGR sequence's parameters to `st`: colours and bold; backgrounds and the rest are ignored. */
function applySgr(params: string, st: { fg?: AnsiColor; bold: boolean }): void {
  const ps = (params || '0').split(/[;:]/).map((p) => Number(p || 0))
  for (let i = 0; i < ps.length; i++) {
    const n = ps[i]
    if (n === 0) {
      st.fg = undefined
      st.bold = false
    } else if (n === 1) st.bold = true
    else if (n === 22) st.bold = false
    else if (n === 39) st.fg = undefined
    else if (n >= 30 && n <= 37) st.fg = BASE[n - 30]
    else if (n >= 90 && n <= 97) st.fg = `bright-${BASE[n - 90]}`
    else if (n === 38 || n === 48) {
      let c: AnsiColor | undefined
      if (ps[i + 1] === 5) {
        c = color256(ps[i + 2])
        i += 2
      } else if (ps[i + 1] === 2) {
        const [r, g, b] = ps.slice(i + 2, i + 5)
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) c = nearest(r, g, b)
        i += 4
      } else return
      if (n === 38 && c) st.fg = c
    }
  }
}

/**
 * Splits a piece of streamed text into styled runs, starting from the style the previous piece ended in.
 * SGR colours (16, 256 and RGB, mapped onto the 16) and bold are kept; every other escape and control char
 * but tab, LF and CR is dropped. An escape cut off at the end is held in the returned state for the next piece.
 */
export function scanAnsi(text: string, from: AnsiState = ANSI_START): { runs: AnsiRun[]; state: AnsiState } {
  const shift = from.carry.length
  let src = from.carry + text
  let carry = ''
  const tail = TAIL.exec(src)
  if (tail) {
    if (src.length - tail.index <= MAX_CARRY) carry = src.slice(tail.index)
    src = src.slice(0, tail.index)
  }
  const st = { fg: from.fg, bold: from.bold }
  const runs: AnsiRun[] = []
  let at = 0
  const add = (end: number) => {
    if (end <= at) return
    const run: AnsiRun = { text: src.slice(at, end), at: Math.max(0, at - shift) }
    if (st.fg) run.fg = st.fg
    if (st.bold) run.bold = true
    runs.push(run)
  }
  for (const m of src.matchAll(ESCAPE)) {
    add(m.index)
    at = m.index + m[0].length
    if (m[2] === 'm' && /^[\d;:]*$/.test(m[1] ?? '')) applySgr(m[1] ?? '', st)
  }
  add(src.length)
  return { runs, state: { ...(st.fg ? { fg: st.fg } : {}), bold: st.bold, carry } }
}

/** Splits one whole line into styled runs (an escape cut off at its end is dropped). */
export function parseAnsi(line: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  for (const { at: _at, ...seg } of scanAnsi(line).runs) {
    const last = out[out.length - 1]
    if (last && last.fg === seg.fg && !!last.bold === !!seg.bold) last.text += seg.text
    else out.push(seg)
  }
  return out.length ? out : [{ text: '' }]
}

/** The text without escapes and control chars (but tab, LF and CR). */
export const stripAnsi = (text: string): string => text.replace(TAIL, '').replace(ESCAPE, '')
