import type { RunEvent } from '../../../shared/deploy'
import { stripAnsi } from '../ui/ansi'

/** Lines kept per release; older ones are dropped and counted. */
export const LOG_CAP = 50000

export interface LogFilter {
  stepId?: string | null
  hostId?: string | null
  runId?: string | null
  /** `<stepId>|<task>`: one Ansible task's own lines (those main tagged with their task). */
  taskKey?: string | null
}

export interface LogLine {
  /** Absolute position since the release opened; stable while the line is kept. */
  index: number
  text: string
  stepId: string | null
  hostId: string | null
  runId: string | null
  stream: 'out' | 'err' | 'ansible'
}

type Key = 'stepId' | 'hostId' | 'runId' | 'taskKey'
const KEYS: Key[] = ['stepId', 'hostId', 'runId', 'taskKey']

/** A run's step ids are `<runId>:<kind>`; host and release steps belong to no run. */
export function runOfStep(stepId: string | null): string | null {
  if (!stepId) return null
  const at = stepId.indexOf(':')
  if (at <= 0) return null
  const head = stepId.slice(0, at)
  return head === 'host' || head === 'release' ? null : head
}

/** The first position in a sorted list whose value is at least `min`. */
function lowerBound(list: number[], min: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < min) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A ring of log lines with per-step, per-host and per-run indexes, so filtering a long log stays cheap. */
export class LogBuffer {
  private readonly cap: number
  private text: string[] = []
  private lower: (string | undefined)[] = []
  private step: (string | null)[] = []
  private host: (string | null)[] = []
  private run: (string | null)[] = []
  private task: (string | null)[] = []
  private stream: LogLine['stream'][] = []
  private index: Record<Key, Map<string, number[]>> = { stepId: new Map(), hostId: new Map(), runId: new Map(), taskKey: new Map() }
  private total = 0
  private truncated = 0
  private cache: { key: string; total: number; list: number[] } | null = null

  constructor(cap = LOG_CAP) {
    this.cap = cap
  }

  /** Lines kept. */
  get size(): number {
    return Math.min(this.total, this.cap)
  }

  /** Lines not shown: dropped from the ring here plus those main dropped before sending. */
  get hidden(): number {
    return this.total - this.size + this.truncated
  }

  /** Changes whenever a push changed anything. */
  get version(): number {
    return this.total + this.truncated
  }

  private get start(): number {
    return this.total - this.size
  }

  push(events: RunEvent[]): void {
    for (const e of events) {
      if (e.type === 'log.truncated') this.truncated += e.dropped
      else if (e.type === 'log' && e.stream !== 'term') this.add(e.line, e.stepId, e.hostId, e.stream, e.task)
    }
  }

  private add(line: string, stepId: string | null, hostId: string | null, stream: LogLine['stream'], task?: string): void {
    const abs = this.total++
    const at = abs % this.cap
    const runId = runOfStep(stepId)
    this.text[at] = line
    this.lower[at] = undefined
    this.step[at] = stepId
    this.host[at] = hostId
    this.run[at] = runId
    const taskKey = stepId && task ? `${stepId}|${task}` : null
    this.task[at] = taskKey
    this.stream[at] = stream
    const values = { stepId, hostId, runId, taskKey }
    for (const k of KEYS) {
      const v = values[k]
      if (v === null) continue
      const list = this.index[k].get(v)
      if (list) list.push(abs)
      else this.index[k].set(v, [abs])
    }
    if (abs >= this.cap && abs % this.cap === 0) this.prune()
  }

  /** Drops index entries for lines the ring no longer holds; run once per lap of the ring. */
  private prune(): void {
    const start = this.start
    for (const k of KEYS) {
      for (const [v, list] of this.index[k]) {
        const cut = lowerBound(list, start)
        if (cut === list.length) this.index[k].delete(v)
        else if (cut) list.splice(0, cut)
      }
    }
  }

  /** The kept absolute indexes that match, or null for every kept line. */
  private matches(filter: LogFilter): { list: number[]; from: number } | null {
    const keys = KEYS.filter((k) => filter[k])
    if (!keys.length) return null
    const start = this.start
    if (keys.length === 1) {
      const list = this.index[keys[0]].get(filter[keys[0]]!) ?? []
      return { list, from: lowerBound(list, start) }
    }
    const key = keys.map((k) => `${k}=${filter[k]}`).join('&')
    if (this.cache?.key !== key || this.cache.total !== this.total) {
      const lists = keys.map((k) => this.index[k].get(filter[k]!) ?? [])
      const base = lists.reduce((a, b) => (b.length < a.length ? b : a))
      const list = base.filter((abs) => abs >= start && keys.every((k) => this.field(k, abs) === filter[k]))
      this.cache = { key, total: this.total, list }
    }
    return { list: this.cache.list, from: 0 }
  }

  private field(k: Key, abs: number): string | null {
    const at = abs % this.cap
    return k === 'stepId' ? this.step[at] : k === 'hostId' ? this.host[at] : k === 'runId' ? this.run[at] : this.task[at]
  }

  count(filter: LogFilter): number {
    const m = this.matches(filter)
    return m ? m.list.length - m.from : this.size
  }

  private absAt(m: { list: number[]; from: number } | null, pos: number): number {
    return m ? m.list[m.from + pos] : this.start + pos
  }

  private line(abs: number): LogLine {
    const at = abs % this.cap
    return { index: abs, text: this.text[at], stepId: this.step[at], hostId: this.host[at], runId: this.run[at], stream: this.stream[at] }
  }

  /** The matching lines at positions [from, to) of the filtered log. */
  slice(from: number, to: number, filter: LogFilter): LogLine[] {
    const m = this.matches(filter)
    const n = m ? m.list.length - m.from : this.size
    const out: LogLine[] = []
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) out.push(this.line(this.absAt(m, i)))
    return out
  }

  /** Positions in the filtered log whose text, without escapes, contains `query` in any case. */
  search(query: string, filter: LogFilter): number[] {
    const q = query.toLowerCase()
    if (!q) return []
    const m = this.matches(filter)
    const n = m ? m.list.length - m.from : this.size
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const at = this.absAt(m, i) % this.cap
      const low = (this.lower[at] ??= stripAnsi(this.text[at]).toLowerCase())
      if (low.includes(q)) out.push(i)
    }
    return out
  }
}
