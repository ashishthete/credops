import { useSyncExternalStore } from 'react'
import type {
  GrantScope,
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
let syncUsers = 0
let stopSync: (() => void) | null = null

const patch = (p: Partial<HubState>) => hubStore.set({ ...hubStore.get(), ...p })

export const isHubAdmin = (s: HubStatus) => s.linked && s.signedIn && s.user?.role === 'admin' && s.user.status === 'active'

function setStatus(status: HubStatus): void {
  const was = isHubAdmin(hubStore.get().status)
  const now = isHubAdmin(status)
  // Leaving the admin role drops the admin data; it is never kept for a user who can't see it.
  if (was && !now) {
    adminLoad++
    patch({ status, statusLoaded: true, users: [], groups: [], audit: [], adminLoaded: false, adminLoading: false })
    return
  }
  patch({ status, statusLoaded: true })
  if (now && !hubStore.get().adminLoaded && !hubStore.get().adminLoading) void refreshAdmin()
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
    const [users, groups] = await Promise.all([api.invoke('hub:users'), api.invoke('hub:groups')])
    if (mine !== adminLoad) return
    patch({ users: users ?? [], groups: groups ?? [], adminLoaded: true, adminLoading: false })
  } catch (err) {
    if (mine !== adminLoad) return
    patch({ adminLoading: false })
    fail("Couldn't load people and groups", err)
  }
}

function startSync(): () => void {
  const off = api.on('hub:state', setStatus)
  void loadHub()
  return off
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
