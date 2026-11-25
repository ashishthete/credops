/**
 * Remembers which ansible process each release last started, across restarts. After a crash or a forced quit it
 * tells whether the run a release left behind is still going on this Mac, so its host lock need not wait out
 * LOCK_STALE_MS when it is not.
 */
export interface RunPidsDeps {
  read: () => string | null
  write: (text: string) => void
  /** `process.kill`: signal 0 only probes. A negative pid asks about the whole process group. */
  kill: (pid: number, signal: 0) => void
}

/** Entries kept: only a release interrupted lately is ever asked about. */
const KEEP = 200

export class RunPids {
  private map: Map<string, number> | null = null

  constructor(private readonly d: RunPidsDeps) {}

  private load(): Map<string, number> {
    if (this.map) return this.map
    const map = new Map<string, number>()
    try {
      const parsed: unknown = JSON.parse(this.d.read() ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) map.set(k, v)
      }
    } catch {
      // an unreadable file only means nothing is known
    }
    return (this.map = map)
  }

  private save(map: Map<string, number>): void {
    while (map.size > KEEP) map.delete(map.keys().next().value as string)
    try {
      this.d.write(JSON.stringify(Object.fromEntries(map)))
    } catch {
      // best effort: without the file a lock waits out its two hours as before
    }
  }

  /** The release's ansible (a process group leader) started. */
  started(releaseId: string, pid: number): void {
    const map = this.load()
    map.delete(releaseId)
    map.set(releaseId, pid)
    this.save(map)
  }

  /** That process closed: the release has nothing running until it starts another. */
  ended(releaseId: string, pid: number): void {
    const map = this.load()
    if (map.get(releaseId) !== pid) return
    map.set(releaseId, 0)
    this.save(map)
  }

  /** True while any process of the release's last run is left, false when none is, null when nothing is known of it. */
  alive(releaseId: string): boolean | null {
    const pid = this.load().get(releaseId)
    if (pid === undefined) return null
    if (pid === 0) return false
    try {
      this.d.kill(-pid, 0)
      return true
    } catch (e) {
      // EPERM: the group exists but is not ours to signal (the pid was reused). Count it as alive: the safe side.
      return (e as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}
