import { parseStreamLine } from './events'
import type { DeployPlan } from './runner'

/**
 * Ansible's own console view, rebuilt from the opsdeck_jsonl events: `TASK [..]`, `ok: [host]`, each task's
 * output and the recap. The lines are plain text (no escape codes); the terminal view colours them by their
 * prefix. Callers redact and cut every line before it leaves main, as for any other log line.
 */
export interface TermLine {
  hostId: string | null
  text: string
}

/** Output lines shown per task result; the rest is counted. */
export const TERM_RESULT_LINES = 400
const INDENT = '    '

type Ev = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const lines = (s: string): string[] => s.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')

export class AnsibleTerm {
  private readonly hosts: Map<string, { hostId: string; label: string }>

  constructor(plan: Pick<DeployPlan, 'hosts'>) {
    this.hosts = new Map(plan.hosts.map((h) => [h.alias, { hostId: h.hostId, label: h.label }]))
  }

  private host(alias: unknown): { hostId: string | null; label: string } {
    const h = this.hosts.get(str(alias))
    return h ?? { hostId: null, label: str(alias) || 'unknown host' }
  }

  /** One line of ansible's stdout (a plugin event, or plain text). */
  stdout(raw: string): TermLine[] {
    const text = raw.replace(/\r$/, '')
    if (text.trim() === '') return []
    let e: Ev
    try {
      const v: unknown = JSON.parse(text)
      if (typeof v !== 'object' || v === null || typeof (v as Ev).event !== 'string') return [{ hostId: null, text }]
      e = v as Ev
    } catch {
      return [{ hostId: null, text }]
    }
    switch (e.event) {
      case 'task_start':
        return [{ hostId: null, text: `TASK [${str(e.name)}]` }]
      case 'ok':
      case 'failed':
      case 'skipped':
      case 'unreachable':
        return this.result(e)
      case 'warning':
        return lines(str(e.msg)).map((l, i) => ({ hostId: null, text: i === 0 ? `[WARNING]: ${l}` : `${INDENT}${l}` }))
      case 'stats':
        return this.recap(e)
      default:
        return []
    }
  }

  /** One line of ansible's stderr. */
  stderr(raw: string): TermLine[] {
    const text = raw.replace(/\r$/, '')
    return text.trim() === '' ? [] : [{ hostId: null, text }]
  }

  /** One line of a host's live stream.log tap. */
  tap(raw: string, hostId: string): TermLine[] {
    const s = parseStreamLine(raw.replace(/\r$/, ''))
    const label = [...this.hosts.values()].find((h) => h.hostId === hostId)?.label ?? hostId
    if (!s) return raw.trim() === '' ? [] : [{ hostId, text: `${label} | ${raw}` }]
    return [{ hostId, text: `${label} | ${s.text}` }]
  }

  private result(e: Ev): TermLine[] {
    const { hostId, label } = this.host(e.host)
    const rc = typeof e.rc === 'number' ? e.rc : null
    const msg = str(e.msg)
    let head: string
    switch (e.event) {
      case 'ok':
        head = `${e.changed === true ? 'changed' : 'ok'}: [${label}]${rc !== null && rc !== 0 ? ` rc=${rc}` : ''}`
        break
      case 'skipped':
        head = `skipping: [${label}]`
        break
      case 'unreachable':
        head = `fatal: [${label}]: UNREACHABLE!`
        break
      default:
        head = `fatal: [${label}]: FAILED!${rc !== null ? ` rc=${rc}` : ''}${e.ignored === true ? ' ...ignoring' : ''}`
    }
    const out: TermLine[] = [{ hostId, text: head }]
    if (e.no_log === true) {
      if (e.event !== 'skipped') out.push({ hostId, text: `${INDENT}(output hidden: this task is no_log)` })
      return out
    }
    const body: string[] = []
    // a streamed step's tail repeats lines the tap already showed
    for (const l of lines(str(e.stdout))) if (!parseStreamLine(l)) body.push(l)
    const err = lines(str(e.stderr))
    if (err.length) body.push(...(body.length ? ['--- stderr'] : []), ...err)
    if (msg && e.event !== 'skipped') body.push(...lines(msg).map((l, i) => (i === 0 ? `msg: ${l}` : l)))
    for (const l of body.slice(0, TERM_RESULT_LINES)) out.push({ hostId, text: `${INDENT}${l}` })
    if (body.length > TERM_RESULT_LINES) out.push({ hostId, text: `${INDENT}… ${body.length - TERM_RESULT_LINES} more lines` })
    const cut = Array.isArray(e.truncated) ? e.truncated.map(String) : []
    if (cut.length) out.push({ hostId, text: `${INDENT}(${cut.join(', ')} cut by OpsDeck)` })
    return out
  }

  private recap(e: Ev): TermLine[] {
    const hosts = typeof e.hosts === 'object' && e.hosts !== null ? (e.hosts as Record<string, Record<string, unknown>>) : {}
    const out: TermLine[] = [{ hostId: null, text: 'PLAY RECAP' }]
    // shown as ansible prints them; ansible's summary names the failed count `failures`
    const keys: [string, string][] = [['ok', 'ok'], ['changed', 'changed'], ['unreachable', 'unreachable'], ['failed', 'failures'], ['skipped', 'skipped'], ['rescued', 'rescued'], ['ignored', 'ignored']]
    for (const [alias, s] of Object.entries(hosts)) {
      const { hostId, label } = this.host(alias)
      const counts = keys.map(([name, k]) => `${name}=${typeof s?.[k] === 'number' ? s[k] : 0}`).join('  ')
      out.push({ hostId, text: `${label} : ${counts}` })
    }
    return out
  }
}
