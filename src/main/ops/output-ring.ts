import { MAX_ERR_RANGES } from '../../shared/ops'

/**
 * Buffered output: the last `cap` chars, trimmed from the front, with stderr as ranges `[start, end)`
 * into the text. Adjacent stderr chunks share a range; past `maxRanges` the oldest two merge into one.
 * The text may grow `slack` past the cap between trims, so a stream of small chunks doesn't copy the
 * whole buffer each time; `snapshot` always trims to the cap. `truncated` turns on as soon as more
 * than `cap` chars are held, slack or not, since the snapshot will have lost them.
 */
export class OutputRing {
  private text = ''
  private ranges: [number, number][] = []
  truncated = false
  private appended = 0

  constructor(
    private readonly cap: number,
    private readonly maxRanges = MAX_ERR_RANGES,
    private readonly slack = Math.floor(cap / 4),
  ) {}

  get length(): number {
    return this.text.length
  }

  /** Chars ever appended, never trimmed: the offset a chunk ends at, for the renderer to dedupe by. */
  get total(): number {
    return this.appended
  }

  append(chunk: string, stream: 'out' | 'err'): void {
    this.appended += chunk.length
    const start = this.text.length
    this.text += chunk
    if (stream === 'err' && chunk !== '') {
      const last = this.ranges.at(-1)
      if (last && last[1] === start) last[1] = this.text.length
      else this.ranges.push([start, this.text.length])
      if (this.ranges.length > this.maxRanges) {
        const [a, b] = this.ranges as [[number, number], [number, number]]
        this.ranges.splice(0, 2, [a[0], b[1]])
      }
    }
    if (this.text.length > this.cap) this.truncated = true
    if (this.text.length > this.cap + this.slack) this.trim()
  }

  snapshot(): { text: string; errRanges: [number, number][] } {
    this.trim()
    return { text: this.text, errRanges: this.ranges.map(([a, b]) => [a, b]) }
  }

  private trim(): void {
    let drop = this.text.length - this.cap
    if (drop <= 0) return
    // Never leave half a surrogate pair at the front.
    const code = this.text.charCodeAt(drop)
    if (code >= 0xdc00 && code <= 0xdfff) drop += 1
    this.text = this.text.slice(drop)
    this.truncated = true
    this.ranges = this.ranges.flatMap(([a, b]) => (b - drop > 0 ? [[Math.max(a - drop, 0), b - drop] as [number, number]] : []))
  }
}
