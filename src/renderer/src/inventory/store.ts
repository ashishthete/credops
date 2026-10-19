import { useSyncExternalStore } from 'react'
import type {
  EnvironmentInput,
  EnvironmentMeta,
  EnvironmentPatch,
  HostInput,
  HostMeta,
  HostPatch,
  HostRole,
  ProductInput,
  ProductMeta,
  SshImportRequest,
  SshImportResult,
} from '../../../shared/inventory'
import type { IdentityMeta, VaultMeta } from '../../../shared/vault'
import { api } from '../lib/api'
import { loadTunnels } from '../tunnels/store'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'

export interface InventoryData {
  products: ProductMeta[]
  environments: EnvironmentMeta[]
  hosts: HostMeta[]
  identities: IdentityMeta[]
  vaults: VaultMeta[]
}

export const inventoryStore = createStore<InventoryData | null>(null)

let loading: Promise<void> | null = null

/**
 * Reads every list in parallel. The store stays null (or stale) when a list fails.
 * Calls made while a load is in flight share it, so the shell and a page don't both fetch.
 */
export function loadInventory(): Promise<void> {
  loading ??= readInventory().finally(() => {
    loading = null
  })
  return loading
}

/**
 * A load that starts after any in flight, so it sees writes made since that one began.
 * Pages that change what the inventory reads (vaults, identities) call it after a write.
 */
export async function reloadInventory(): Promise<void> {
  await loading
  await loadInventory()
}

type ListKey = keyof InventoryData

/**
 * Bumped by every write to a list. A read only applies the lists nobody wrote while it was in
 * flight, so a slow load or refresh can't overwrite a newer edit with what it read before.
 */
const written: Record<ListKey, number> = { products: 0, environments: 0, hosts: 0, identities: 0, vaults: 0 }

function applyRead(seen: Record<ListKey, number>, lists: Partial<InventoryData>) {
  const d = inventoryStore.get()
  if (!d) {
    if (Object.keys(lists).length === Object.keys(written).length) inventoryStore.set(lists as InventoryData)
    return
  }
  const fresh = Object.entries(lists).filter(([k]) => written[k as ListKey] === seen[k as ListKey])
  if (fresh.length) inventoryStore.set({ ...d, ...Object.fromEntries(fresh) })
}

async function readInventory(): Promise<void> {
  const seen = { ...written }
  const data = await attempt("Couldn't load your inventory", async () => {
    const [products, environments, hosts, identities, vaults] = await Promise.all([
      api.invoke('product:list'),
      api.invoke('env:list'),
      api.invoke('host:list'),
      api.invoke('identity:list'),
      api.invoke('vault:list'),
    ])
    return { products, environments, hosts, identities, vaults }
  })
  if (data) applyRead(seen, data)
}

export const useInventory = (): InventoryData | null => useSyncExternalStore(inventoryStore.subscribe, inventoryStore.get)

type Row = { id: string }

function upsert<T extends Row>(rows: T[], row: T): T[] {
  return rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row]
}

function patchStore(change: (d: InventoryData) => Partial<InventoryData>) {
  const d = inventoryStore.get()
  if (!d) return
  const next = change(d)
  for (const k of Object.keys(next) as ListKey[]) written[k]++
  inventoryStore.set({ ...d, ...next })
}

const LISTS = {
  products: () => api.invoke('product:list'),
  environments: () => api.invoke('env:list'),
  hosts: () => api.invoke('host:list'),
}

/** Re-reads the lists on the other side of a link, so shared items update everywhere. */
async function refresh(...keys: (keyof typeof LISTS)[]) {
  const seen = { ...written }
  try {
    const lists = await Promise.all(keys.map((k) => LISTS[k]()))
    applyRead(seen, Object.fromEntries(keys.map((k, i) => [k, lists[i]])))
  } catch (err) {
    fail("Couldn't refresh your inventory", err)
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The keys of `input` that differ from `current`; omitted keys are left alone. */
function diff<T extends object>(input: Partial<T>, current: T | undefined, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) if (input[k] !== undefined && (!current || !same(input[k], current[k]))) out[k] = input[k]
  return out
}

const HOST_KEYS = ['label', 'address', 'port', 'identityId', 'jumpHostId', 'tags', 'osIcon', 'notes', 'keepaliveSec', 'envVars'] as const satisfies readonly (keyof HostPatch)[]
const ENV_KEYS = ['name', 'color', 'protected', 'defaultIdentityId', 'defaultPort', 'defaultJumpHostId', 'domain'] as const satisfies readonly (keyof EnvironmentPatch)[]

const deleted = async (fn: () => Promise<unknown>, title: string) =>
  (await attempt(title, async () => (await fn(), true))) === true

/** Main reads the stored value and opens it; the renderer sends only the id. */
export async function openEnvironmentDomain(id: string): Promise<void> {
  await attempt("Couldn't open the domain", () => api.invoke('env:openDomain', id))
}

export const inv = {
  async saveProduct(input: ProductInput, id?: string): Promise<ProductMeta | undefined> {
    const row = await attempt("Couldn't save the product", () =>
      id ? api.invoke('product:update', id, input) : api.invoke('product:create', input),
    )
    if (row) patchStore((d) => ({ products: upsert(d.products, row) }))
    return row
  },

  async deleteProduct(id: string): Promise<boolean> {
    const ok = await deleted(() => api.invoke('product:delete', id), "Couldn't delete the product")
    if (ok) {
      patchStore((d) => ({ products: d.products.filter((p) => p.id !== id) }))
      await refresh('environments')
    }
    return ok
  },

  /** Create sends everything; edit sends changed fields only and routes product links to setProducts. */
  async saveEnvironment(input: EnvironmentInput, id?: string): Promise<EnvironmentMeta | undefined> {
    let updated = false
    const row = await attempt("Couldn't save the environment", async () => {
      if (!id) return api.invoke('env:create', input)
      const current = inventoryStore.get()?.environments.find((e) => e.id === id)
      const patch = diff<EnvironmentPatch>(input, current, ENV_KEYS)
      let saved = current
      if (Object.keys(patch).length || !current) {
        saved = await api.invoke('env:update', id, patch)
        updated = true
      }
      if (input.productIds && !(current && sameSet(input.productIds, current.productIds))) {
        saved = await api.invoke('env:setProducts', id, input.productIds)
      }
      return saved!
    })
    if (row) {
      patchStore((d) => ({ environments: upsert(d.environments, row) }))
      await refresh('products')
    } else if (updated) {
      // The edit saved but the product links didn't; show what was saved.
      await refresh('environments')
    }
    return row
  },

  async deleteEnvironment(id: string): Promise<boolean> {
    const ok = await deleted(() => api.invoke('env:delete', id), "Couldn't delete the environment")
    if (ok) {
      patchStore((d) => ({ environments: d.environments.filter((e) => e.id !== id) }))
      await refresh('products', 'hosts')
      // Its tunnels fall back to host-only (the rows' environment is set to null).
      void loadTunnels()
    }
    return ok
  },

  async setEnvironmentProducts(id: string, productIds: string[]): Promise<EnvironmentMeta | undefined> {
    const row = await attempt("Couldn't update the environment's products", () => api.invoke('env:setProducts', id, productIds))
    if (row) {
      patchStore((d) => ({ environments: upsert(d.environments, row) }))
      await refresh('products')
    }
    return row
  },

  async putHost(envId: string, hostId: string, role: HostRole): Promise<EnvironmentMeta | undefined> {
    const row = await attempt("Couldn't add the host to the environment", () => api.invoke('env:putHost', envId, hostId, role))
    if (row) {
      patchStore((d) => ({ environments: upsert(d.environments, row) }))
      await refresh('hosts')
    }
    return row
  },

  async removeHost(envId: string, hostId: string): Promise<EnvironmentMeta | undefined> {
    const row = await attempt("Couldn't remove the host from the environment", () => api.invoke('env:removeHost', envId, hostId))
    if (row) {
      patchStore((d) => ({ environments: upsert(d.environments, row) }))
      await refresh('hosts')
      // The host's tunnels in this environment fall back to host-only.
      void loadTunnels()
    }
    return row
  },

  /**
   * Create sends everything; edit sends changed fields only and routes vault links to setHostVaults.
   * `base` is the host the edit started from (defaults to the stored one), so others' changes aren't undone.
   */
  async saveHost(input: HostInput, id?: string, base?: HostMeta): Promise<HostMeta | undefined> {
    let updated = false
    const row = await attempt("Couldn't save the host", async () => {
      if (!id) return api.invoke('host:create', input)
      const current = base ?? inventoryStore.get()?.hosts.find((h) => h.id === id)
      const patch = diff<HostPatch>(input, current, HOST_KEYS)
      let saved = current
      if (Object.keys(patch).length || !current) {
        saved = await api.invoke('host:update', id, patch)
        updated = true
      }
      if (input.vaultIds && !(current && sameSet(input.vaultIds, current.vaultIds))) {
        saved = await api.invoke('host:setVaults', id, input.vaultIds)
      }
      return saved!
    })
    if (row) {
      patchStore((d) => ({ hosts: upsert(d.hosts, row) }))
      if (!id) await refresh('environments')
    } else if (updated) {
      // The edit saved but the vault links didn't; show what was saved.
      await refresh('hosts')
    }
    return row
  },

  async deleteHost(id: string): Promise<boolean> {
    const ok = await deleted(() => api.invoke('host:delete', id), "Couldn't delete the host")
    if (ok) {
      patchStore((d) => ({ hosts: d.hosts.filter((h) => h.id !== id) }))
      await refresh('environments')
      // The host's tunnels went with it (main stops them and the rows cascade).
      void loadTunnels()
    }
    return ok
  },

  /** Imports hosts from ~/.ssh/config, then reloads everything (it can add hosts, identities and keys). */
  async importSshConfig(req: SshImportRequest): Promise<SshImportResult | undefined> {
    const result = await attempt("Couldn't import from ~/.ssh/config", () => api.invoke('sshconfig:import', req))
    if (result) await reloadInventory()
    return result
  },

  async setHostVaults(id: string, vaultIds: string[]): Promise<HostMeta | undefined> {
    const row = await attempt("Couldn't update the host's vaults", () => api.invoke('host:setVaults', id, vaultIds))
    if (row) patchStore((d) => ({ hosts: upsert(d.hosts, row) }))
    return row
  },
}
