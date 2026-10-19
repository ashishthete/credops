import type { HubCatalogEnv, HubStatus } from '../../shared/hub'

/** The signed-in person's filtered view of the Hub's environments. In memory only; refetched, never persisted. */
export class HubCatalog {
  private envs: HubCatalogEnv[] = []
  private readonly listeners: (() => void)[] = []
  private inflight: Promise<HubCatalogEnv[]> | null = null
  private wasSignedIn = false

  constructor(private readonly d: { client: () => { get<T>(path: string): Promise<T> } }) {}

  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  get(environmentId: string): HubCatalogEnv | undefined {
    return this.envs.find((e) => e.environment.id === environmentId)
  }

  list(): HubCatalogEnv[] {
    return this.envs
  }

  isHubEnv(environmentId: string): boolean {
    return this.get(environmentId) !== undefined
  }

  /** Concurrent refreshes share one request. A failure keeps the last catalog. */
  refresh(): Promise<HubCatalogEnv[]> {
    this.inflight ??= this.d
      .client()
      .get<HubCatalogEnv[]>('/api/v1/catalog')
      .then((envs) => this.set(envs))
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  clear(): void {
    this.set([])
  }

  /** Call on every Hub status change: loads on sign-in, empties on sign-out or unlink. */
  onStatus(status: HubStatus): void {
    const signedIn = status.linked && status.signedIn && status.online
    if (signedIn && !this.wasSignedIn) void this.refresh().catch(() => undefined)
    if (!status.linked || !status.signedIn) this.clear()
    this.wasSignedIn = signedIn
  }

  private set(envs: HubCatalogEnv[]): HubCatalogEnv[] {
    const same = JSON.stringify(envs) === JSON.stringify(this.envs)
    this.envs = envs
    if (!same) for (const fn of this.listeners) fn()
    return envs
  }
}
