/**
 * Small in-process fixed-window counters keyed by client address. Memory is bounded: a full map first drops expired
 * windows, then the oldest one. The Hub runs as one process, so nothing here needs to be shared.
 */

export interface WindowOptions {
  windowMs: number
  /** Most keys held at once. */
  maxKeys: number
  now: () => Date
}

interface Window {
  start: number
  count: number
}

class FixedWindows {
  protected readonly windows = new Map<string, Window>()

  constructor(protected readonly o: WindowOptions) {}

  protected expired(w: Window, t: number): boolean {
    return t - w.start >= this.o.windowMs
  }

  /** Called with each window dropped while still holding a count, before it goes. */
  protected onDrop(_key: string, _w: Window): void {}

  /** Returns the live window for key, opening a new one (and reporting the old) when it has expired. */
  protected window(key: string, t: number): { w: Window; fresh: boolean } {
    const cur = this.windows.get(key)
    if (cur && !this.expired(cur, t)) return { w: cur, fresh: false }
    if (cur) {
      this.windows.delete(key)
      this.onDrop(key, cur)
    }
    if (this.windows.size >= this.o.maxKeys) this.sweep()
    while (this.windows.size >= this.o.maxKeys) {
      const [oldKey, old] = this.windows.entries().next().value as [string, Window]
      this.windows.delete(oldKey)
      this.onDrop(oldKey, old)
    }
    const w = { start: t, count: 0 }
    this.windows.set(key, w)
    return { w, fresh: true }
  }

  /** Drops every expired window. */
  sweep(): void {
    const t = this.o.now().getTime()
    for (const [key, w] of this.windows) {
      if (this.expired(w, t)) {
        this.windows.delete(key)
        this.onDrop(key, w)
      }
    }
  }

  get size(): number {
    return this.windows.size
  }
}

/** Allows `limit` hits per key per window. */
export class RateLimiter extends FixedWindows {
  constructor(private readonly limit: number, o: WindowOptions) {
    super(o)
  }

  /** Counts one hit; `allowed` false means the key is over its limit until `retryAfterMs` passes. */
  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const t = this.o.now().getTime()
    const { w } = this.window(key, t)
    w.count++
    return { allowed: w.count <= this.limit, retryAfterMs: Math.max(0, w.start + this.o.windowMs - t) }
  }
}

/**
 * Lets the first event per key per window through; the rest are counted. A window's count of held-back events is
 * handed to `onSummary` once that window ends (seen on the next event, a sweep, an eviction, or `flush`).
 */
export class Coalescer extends FixedWindows {
  constructor(
    o: WindowOptions,
    private readonly onSummary: (key: string, suppressed: number) => void,
  ) {
    super(o)
  }

  protected override onDrop(key: string, w: Window): void {
    if (w.count > 1) {
      try {
        this.onSummary(key, w.count - 1)
      } catch {
        // A summary must never break the request (or timer) that triggered it.
      }
    }
  }

  /** True when this is the first event for key in its window and should be recorded in full. */
  first(key: string): boolean {
    const { w, fresh } = this.window(key, this.o.now().getTime())
    w.count++
    return fresh
  }

  /** Reports every window still holding back events, whether expired or not, and empties the map. */
  flush(): void {
    const all = [...this.windows]
    this.windows.clear()
    for (const [key, w] of all) this.onDrop(key, w)
  }
}
