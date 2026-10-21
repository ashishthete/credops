import { useSyncExternalStore } from 'react'
import type {
  GrantScope,
  HubCatalogEnv,
  HubDeployKey,
  HubEnvLock,
  HubPublishResult,
  HubSecretKind,
  HubSecretList,
  HubAuditEvent,
  HubAuditFilter,
  HubGroup,
  HubRole,
  HubStatus,
  HubUser,
} from '../../../shared/hub'
import { api } from '../lib/api'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'

export interface HubState {
  status: HubStatus
  statusLoaded: boolean
  users: HubUser[]
  groups: HubGroup[]
  audit: HubAuditEvent[]
  /** What the signed-in person may see: their catalog, with each environment's lock. Empty for a pending user. */
  catalog: HubCatalogEnv[]
  catalogLoaded: boolean
  /** Current locks by environment id; the catalog's own copy until `hub:locks` has answered. */
  locks: Record<string, HubEnvLock>
  /** Every published environment (admins only). */
  adminEnvs: HubCatalogEnv[]
  adminLoaded: boolean
  adminLoading: boolean
  auditLoading: boolean
  /** A connect, sign-in, sign-out or disconnect request is in flight. */
  busy: boolean
}

const initial = (): HubState => ({
  status: { linked: false },
  statusLoaded: false,
  users: [],
  groups: [],
  audit: [],
  catalog: [],
  catalogLoaded: false,
  locks: {},
  adminEnvs: [],
  adminLoaded: false,
  adminLoading: false,
  auditLoading: false,
  busy: false,
})

export const hubStore = createStore<HubState>(initial())

// Bumped on reset and on each admin load, so a reply that lost the race is dropped.
let generation = 0
let adminLoad = 0
let auditLoad = 0
let catalogLoad = 0
let syncUsers = 0
let stopSync: (() => void) | null = null

const patch = (p: Partial<HubState>) => hubStore.set({ ...hubStore.get(), ...p })

export const isHubActive = (s: HubStatus) => s.linked && s.signedIn && s.user?.status === 'active'
export const isHubAdmin = (s: HubStatus) => s.linked && s.signedIn && s.user?.role === 'admin' && s.user.status === 'active'

function setStatus(status: HubStatus): void {
  const was = isHubAdmin(hubStore.get().status)
  const now = isHubAdmin(status)
  const wasActive = isHubActive(hubStore.get().status)
  const active = isHubActive(status)
  // Leaving the admin role drops the admin data; it is never kept for a user who can't see it.
  if (was && !now) {
    adminLoad++
    patch({ status, statusLoaded: true, users: [], groups: [], audit: [], adminEnvs: [], adminLoaded: false, adminLoading: false })
  } else {
    patch({ status, statusLoaded: true })
    if (now && !hubStore.get().adminLoaded && !hubStore.get().adminLoading) void refreshAdmin()
  }
  // The catalog follows the sign-in: gone with it, loaded when an active person arrives.
  if (wasActive && !active) {
    catalogLoad++
    patch({ catalog: [], catalogLoaded: false, locks: {} })
  } else if (active && !wasActive) void refreshCatalog()
}

/** Loads the catalog and the locks; a no-op unless the person is signed in and active. */
export async function refreshCatalog(): Promise<void> {
  if (!isHubActive(hubStore.get().status)) return
  const mine = ++catalogLoad
  try {
    const [catalog, locks] = await Promise.all([api.invoke('hub:catalog'), api.invoke('hub:locks')])
    if (mine !== catalogLoad) return
    const list = catalog ?? []
    patch({ catalog: list, catalogLoaded: true, locks: lockMap(list, locks) })
  } catch (err) {
    if (mine !== catalogLoad) return
    patch({ catalogLoaded: true })
    fail("Couldn't load the team environments", err)
  }
}

function lockMap(catalog: HubCatalogEnv[], locks?: HubEnvLock[] | null): Record<string, HubEnvLock> {
  const out: Record<string, HubEnvLock> = {}
  for (const e of catalog) if (e.lock) out[e.environment.id] = e.lock
  if (locks) {
    for (const k of Object.keys(out)) delete out[k]
    for (const l of locks) out[l.environmentId] = l
  }
  return out
}

/** Refetches only the locks (a lock was taken or lifted). */
export async function refreshLocks(): Promise<void> {
  if (!isHubActive(hubStore.get().status)) return
  const mine = catalogLoad
  try {
    const locks = await api.invoke('hub:locks')
    if (mine !== catalogLoad || !locks) return
    patch({ locks: lockMap([], locks) })
  } catch {
    // The next catalog refresh carries the locks too.
  }
}

export async function loadHub(): Promise<void> {
  const started = generation
  try {
    const status = await api.invoke('hub:status')
    if (started === generation && status) setStatus(status)
  } catch (err) {
    if (started === generation) patch({ statusLoaded: true })
    fail("Couldn't load the Hub", err)
  }
}

/** Loads people and groups; a no-op unless the signed-in user is an active admin. */
export async function refreshAdmin(): Promise<void> {
  if (!isHubAdmin(hubStore.get().status)) return
  const mine = ++adminLoad
  patch({ adminLoading: true })
  try {
    const [users, groups, adminEnvs] = await Promise.all([api.invoke('hub:users'), api.invoke('hub:groups'), api.invoke('hub:adminEnvironments')])
    if (mine !== adminLoad) return
    patch({ users: users ?? [], groups: groups ?? [], adminEnvs: adminEnvs ?? [], adminLoaded: true, adminLoading: false })
  } catch (err) {
    if (mine !== adminLoad) return
    patch({ adminLoading: false })
    fail("Couldn't load people and groups", err)
  }
}

function startSync(): () => void {
  const offState = api.on('hub:state', setStatus)
  const offCatalog = api.on('hub:catalog', () => {
    void refreshCatalog()
    if (isHubAdmin(hubStore.get().status)) void refreshAdmin()
  })
  const offLocks = api.on('hub:locks', () => void refreshLocks())
  void loadHub()
  return () => {
    offState()
    offCatalog()
    offLocks()
  }
}

/** Subscribes to `hub:state` and loads the status; idempotent, torn down when the last caller leaves. */
export function startHubSync(): () => void {
  if (syncUsers++ === 0) stopSync = startSync()
  let left = false
  return () => {
    if (left) return
    left = true
    if (--syncUsers === 0) {
      stopSync?.()
      stopSync = null
    }
  }
}

export function resetHub(): void {
  catalogLoad++
  generation++
  adminLoad++
  auditLoad++
  hubStore.set(initial())
}

async function link(title: string, fn: () => Promise<HubStatus | null | undefined>, onError?: (m: string) => void): Promise<HubStatus | undefined> {
  patch({ busy: true })
  try {
    const status = await attempt(title, fn, onError)
    if (status) setStatus(status)
    return status ?? undefined
  } finally {
    patch({ busy: false })
  }
}

export const connectHub = (url: string, onError?: (m: string) => void) =>
  link("Couldn't connect to the Hub", () => api.invoke('hub:connect', url), onError)

export const signInHub = () => link("Couldn't sign in", () => api.invoke('hub:signIn'))
export const signOutHub = () => link("Couldn't sign out", () => api.invoke('hub:signOut'))
export const unlinkHub = () => link("Couldn't disconnect from the Hub", () => api.invoke('hub:unlink'))

export async function cancelSignIn(): Promise<void> {
  // Not through `link`: Cancel must stay clickable while the sign-in request is still pending.
  await attempt("Couldn't cancel the sign-in", () => api.invoke('hub:cancelSignIn'))
}

/** Admin mutations: run, then refetch people and groups so the lists show the Hub's truth. */
async function mutate<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  const out = await attempt(title, fn)
  if (out !== undefined) await refreshAdmin()
  return out
}

const done = async (fn: () => Promise<unknown>) => {
  await fn()
  return true as const
}

export const setUserRole = (oid: string, role: HubRole) =>
  mutate("Couldn't change the role", () => api.invoke('hub:updateUser', oid, { role }))
export const setUserDisabled = (oid: string, disabled: boolean) =>
  mutate(disabled ? "Couldn't disable the person" : "Couldn't enable the person", () => api.invoke('hub:updateUser', oid, { disabled }))
export const addMembers = (groupId: string, oids: string[]) =>
  mutate("Couldn't add to the group", () => api.invoke('hub:addMembers', groupId, oids))
export const removeMember = (groupId: string, oid: string) =>
  mutate("Couldn't remove from the group", () => api.invoke('hub:removeMember', groupId, oid))
export const createGroup = (name: string, description?: string) =>
  mutate("Couldn't create the group", () => api.invoke('hub:createGroup', description ? { name, description } : { name }))
export const renameGroup = (id: string, name: string) =>
  mutate("Couldn't rename the group", () => api.invoke('hub:updateGroup', id, { name }))
export const deleteGroup = (id: string) => mutate("Couldn't delete the group", () => done(() => api.invoke('hub:deleteGroup', id)))
export const addGrant = (groupId: string, scope: GrantScope) =>
  mutate("Couldn't add the grant", () => api.invoke('hub:addGrant', groupId, scope))
export const removeGrant = (grantId: string) => mutate("Couldn't remove the grant", () => done(() => api.invoke('hub:removeGrant', grantId)))

// ---- Environments, secrets and locks (admin writes refetch the Hub's truth) ----

export async function publishEnvironment(environmentId: string): Promise<HubPublishResult | undefined> {
  const out = await mutate("Couldn't publish the environment", () => api.invoke('hub:publish', environmentId))
  if (out) void refreshCatalog()
  return out
}
export async function unpublishEnvironment(environmentId: string) {
  const out = await mutate("Couldn't unpublish the environment", () => done(() => api.invoke('hub:unpublish', environmentId)))
  if (out) void refreshCatalog()
  return out
}
export const getDeployKey = (environmentId: string, rotate: boolean): Promise<HubDeployKey | undefined> =>
  mutate(rotate ? "Couldn't rotate the deploy key" : "Couldn't get the deploy key", () => api.invoke('hub:deployKey', environmentId, rotate))
/** The secrets the Hub holds (names, kinds, timestamps) and the required ones still missing. */
export const loadSecrets = (environmentId: string | null): Promise<HubSecretList | undefined> =>
  attempt("Couldn't load the Hub secrets", () => api.invoke('hub:secrets', environmentId))
export const uploadSecrets = (environmentId: string, secretIds?: string[]) =>
  mutate("Couldn't upload the secrets", () => api.invoke('hub:uploadSecrets', environmentId, secretIds))
export const setIntegrationSecret = (environmentId: string | null, kind: HubSecretKind, secretId: string) =>
  mutate("Couldn't set the secret", () => done(() => api.invoke('hub:setIntegrationSecret', environmentId, kind, secretId)))
export const freezeEnvironment = (environmentId: string, reason: string, hours: number | null) =>
  attempt("Couldn't freeze the environment", () => api.invoke('hub:freeze', environmentId, reason, hours))
export const unfreezeEnvironment = async (environmentId: string, typedName: string | null) => {
  const out = await attempt("Couldn't lift the freeze", () => done(() => api.invoke('hub:unfreeze', environmentId, typedName)))
  if (out) await refreshLocks()
  return out
}

export async function loadHubAudit(filter: HubAuditFilter): Promise<void> {
  const mine = ++auditLoad
  patch({ auditLoading: true })
  const rows = await attempt("Couldn't load the Hub audit log", () => api.invoke('hub:audit', filter))
  // A newer filter's request owns the list and the loading flag.
  if (mine !== auditLoad) return
  patch({ auditLoading: false, ...(rows ? { audit: rows } : {}) })
}

export const verifyHubAudit = () => attempt("Couldn't verify the Hub audit log", () => api.invoke('hub:verifyAudit'))

export function useHub(): HubState {
  return useSyncExternalStore(hubStore.subscribe, hubStore.get)
}
