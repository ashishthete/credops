import type { EnvironmentMeta } from '../../shared/inventory'
import { pickAppHost, type DbServiceMeta, type ServiceMeta } from '../../shared/services'
import { TUNNEL_ROUTE_FIELDS, type TunnelMeta, type TunnelRuntime } from '../../shared/tunnels'
import type { TunnelManager } from '../tunnels/manager'
import type { TunnelStore } from '../tunnels/tunnel-store'
import type { DeployStore } from './deploy-store'
import type { ServiceStore } from './service-store'

export interface ServiceTunnelsDeps {
  services: Pick<ServiceStore, 'get' | 'setTunnel'>
  tunnels: Pick<TunnelStore, 'create' | 'update' | 'get' | 'delete'>
  manager: Pick<TunnelManager, 'start' | 'stop' | 'runtime'>
  environments: () => EnvironmentMeta[]
  deploys: Pick<DeployStore, 'list'>
  /** Throws for an unknown host. */
  hostLabel: (id: string) => string
  /** A free port on 127.0.0.1, for a db service's first open. */
  freePort: () => Promise<number>
}

/** The tunnel fields a db service owns. `autoReconnect` is set on create only, so a choice made on the Tunnels page stays. */
interface Route {
  label: string
  hostId: string
  environmentId: string
  type: 'L'
  bindAddress: string
  bindPort: number
  targetHost: string
  targetPort: number
}
const ROUTE_KEYS = ['label', ...TUNNEL_ROUTE_FIELDS] as const

/**
 * A db service's tunnel: a Phase 5 `L` tunnel from 127.0.0.1:<localPort> through the via-host to the db
 * address. The tunnel is an ordinary saved tunnel (it shows on the Tunnels page and its runtime, errors and
 * audit are Phase 5's own); the service only keeps its id and local port.
 */
export class ServiceTunnels {
  /** One open at a time per service, so two quick clicks never create two tunnels. */
  private readonly opening = new Map<string, Promise<TunnelRuntime>>()

  constructor(private readonly deps: ServiceTunnelsDeps) {}

  /** The service's `viaHostId` while it is still in the environment, else the default app host. */
  viaHost(svc: DbServiceMeta): string {
    const env = this.deps.environments().find((e) => e.id === svc.environmentId)
    const members = env?.hosts ?? []
    if (svc.viaHostId !== null && members.some((m) => m.hostId === svc.viaHostId)) return svc.viaHostId
    const hosts = members.map((m) => ({ hostId: m.hostId, role: m.role, label: this.deps.hostLabel(m.hostId) }))
    const checkoutHosts = this.deps.deploys.list(svc.environmentId).map((d) => d.hostId)
    const picked = pickAppHost(hosts, checkoutHosts)
    if (picked === null) throw new Error(`Pick a via-host for ${svc.name}; this environment has no app host`)
    return picked
  }

  /** Creates the tunnel on first use, applies a stale route, then starts it. The runtime is Phase 5's, as it is. */
  open(id: string): Promise<TunnelRuntime> {
    const running = this.opening.get(id)
    if (running) return running
    const p = this.doOpen(id).finally(() => this.opening.delete(id))
    this.opening.set(id, p)
    return p
  }

  close(id: string): void {
    const t = this.tunnelOf(this.db(id))
    if (t) this.deps.manager.stop(t.id)
  }

  /**
   * After service:update. A stopped (or failed) tunnel takes the new route now and needs nothing more. A
   * running, connecting or retrying one is left as it is, since writing the route would restart it at once
   * (TunnelStore.onChanged -> TunnelManager.changed); true says a restart is pending for the user to confirm.
   */
  afterUpdate(svc: ServiceMeta): boolean {
    if (svc.kind !== 'db') return false
    const t = this.tunnelOf(svc)
    if (!t || svc.localPort === null) return false
    let route: Route
    try {
      route = this.route(svc, svc.localPort)
    } catch {
      // No via-host to route through: the next open says so.
      return false
    }
    if (!stale(t, route)) return false
    const state = this.deps.manager.runtime(t.id).state
    if (state === 'stopped' || state === 'failed') {
      this.deps.tunnels.update(t.id, route)
      return false
    }
    return true
  }

  /** Writes the route; a running tunnel restarts through TunnelManager.changed. Null when the service has no tunnel. */
  sync(id: string): TunnelRuntime | null {
    const svc = this.db(id)
    const t = this.tunnelOf(svc)
    if (!t || svc.localPort === null) return null
    this.deps.tunnels.update(t.id, this.route(svc, svc.localPort))
    return this.deps.manager.runtime(t.id)
  }

  /** Stops and deletes the service's tunnel; the store's FK clears `tunnelId`. A no-op without one. */
  remove(id: string): void {
    const svc = this.deps.services.get(id)
    if (svc.kind !== 'db') return
    const t = this.tunnelOf(svc)
    if (!t) return
    this.deps.manager.stop(t.id, 'deleted')
    this.deps.tunnels.delete(t.id)
  }

  private async doOpen(id: string): Promise<TunnelRuntime> {
    let svc = this.db(id)
    // Checked before a port is picked or anything is written.
    this.viaHost(svc)
    if (svc.localPort === null) svc = this.deps.services.setTunnel(id, svc.tunnelId, await this.deps.freePort())
    const port = svc.localPort!
    const route = this.route(svc, port)
    let t = this.tunnelOf(svc)
    if (!t) {
      t = this.deps.tunnels.create({ ...route, autoReconnect: true })
      this.deps.services.setTunnel(id, t.id, port)
    } else if (stale(t, route)) {
      // A running tunnel restarts on the new route here too (TunnelManager.changed); the start below then
      // returns that run as it is.
      this.deps.tunnels.update(t.id, route)
    }
    return this.deps.manager.start(t.id)
  }

  private db(id: string): DbServiceMeta {
    const svc = this.deps.services.get(id)
    if (svc.kind !== 'db') throw new Error('only a db service has a tunnel')
    return svc
  }

  /** The service's tunnel, or null when it has none or it was deleted on the Tunnels page. Any other read error is raised. */
  private tunnelOf(svc: DbServiceMeta): TunnelMeta | null {
    if (svc.tunnelId === null) return null
    try {
      return this.deps.tunnels.get(svc.tunnelId)
    } catch (e) {
      if (e instanceof Error && e.message === 'tunnel not found') return null
      throw e
    }
  }

  private route(svc: DbServiceMeta, localPort: number): Route {
    return {
      label: svc.name,
      hostId: this.viaHost(svc),
      environmentId: svc.environmentId,
      type: 'L',
      bindAddress: '127.0.0.1',
      bindPort: localPort,
      targetHost: svc.dbAddress,
      targetPort: svc.dbPort,
    }
  }
}

const stale = (t: TunnelMeta, route: Route): boolean => ROUTE_KEYS.some((k) => t[k] !== route[k])
