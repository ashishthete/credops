export type DiffLine = { op: ' ' | '+' | '-'; text: string }

/** Beyond this many table cells the middle is shown as wholly removed then wholly added, not compared. */
const MAX_CELLS = 4_000_000

/**
 * A line diff of `a` to `b` (an LCS, no dependency). Lines equal at the start and the end are matched first, so a
 * small edit to a large playbook costs little. An empty text has no lines.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const xs = x.slice(head, x.length - tail)
  const ys = y.slice(head, y.length - tail)
  const out: DiffLine[] = x.slice(0, head).map((text) => ({ op: ' ', text }))
  out.push(...middle(xs, ys))
  out.push(...x.slice(x.length - tail).map((text): DiffLine => ({ op: ' ', text })))
  return out
}

function middle(xs: string[], ys: string[]): DiffLine[] {
  const n = xs.length
  const m = ys.length
  if (!n || !m || (n + 1) * (m + 1) > MAX_CELLS) return [...xs.map((text): DiffLine => ({ op: '-', text })), ...ys.map((text): DiffLine => ({ op: '+', text }))]
  // lcs[i][j]: the common length of xs[i..] and ys[j..].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = xs[i] === ys[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      out.push({ op: ' ', text: xs[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push({ op: '-', text: xs[i++]! })
    else out.push({ op: '+', text: ys[j++]! })
  }
  while (i < n) out.push({ op: '-', text: xs[i++]! })
  while (j < m) out.push({ op: '+', text: ys[j++]! })
  return out
}
