/** ANSI colours for ansible's console lines (main sends them as plain text). */
const C = { bold: '\x1b[1m', dim: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', magenta: '\x1b[35m', reset: '\x1b[0m' }

/** Control characters from a host's output could move the cursor or retitle the view: only tabs stay. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

const paint = (code: string, text: string): string => `${code}${text}${C.reset}`

/** One stored line as terminal text (with its own CRLF; a task or the recap starts after a blank line). */
export function termText(raw: string): string {
  const line = raw.replace(CONTROL, '')
  if (line.startsWith('TASK [') || line === 'PLAY RECAP') return `\r\n${paint(C.bold, line)}\r\n`
  if (line.startsWith('ok: [')) return `${paint(C.green, line)}\r\n`
  if (line.startsWith('changed: [')) return `${paint(C.yellow, line)}\r\n`
  if (line.startsWith('skipping: [')) return `${paint(C.cyan, line)}\r\n`
  if (line.startsWith('fatal: [')) return `${paint(C.red, line)}\r\n`
  if (line.startsWith('[WARNING]')) return `${paint(C.magenta, line)}\r\n`
  if (line === '    --- stderr' || /^ {4}\(.*\)$/.test(line)) return `${paint(C.dim, line)}\r\n`
  const recap = / : ok=\d+ {2}changed=\d+ {2}unreachable=(\d+) {2}failed=(\d+)/.exec(line)
  if (recap) return `${paint(recap[1] !== '0' || recap[2] !== '0' ? C.red : C.green, line)}\r\n`
  return `${line}\r\n`
}
