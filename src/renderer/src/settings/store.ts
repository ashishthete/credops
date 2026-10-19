import { useSyncExternalStore } from 'react'
import type { IntegrationSettings, IntegrationSettingsPatch, IntegrationStatus } from '../../../shared/settings'
import { DEFAULT_VAULT_ID, type SecretKind, type SecretMeta } from '../../../shared/vault'
import { api } from '../lib/api'
import { attempt } from '../ui/common'
import { createStore } from '../ui/store'

export interface IntegrationsState {
  settings: IntegrationSettings | null
  status: IntegrationStatus | null
  /** Secret metadata only; values never reach the renderer through this store. */
  secrets: SecretMeta[]
  loaded: boolean
}

const EMPTY: IntegrationsState = { settings: null, status: null, secrets: [], loaded: false }
export const integrationsStore = createStore<IntegrationsState>(EMPTY)
export const useIntegrations = (): IntegrationsState => useSyncExternalStore(integrationsStore.subscribe, integrationsStore.get)

const patch = (p: Partial<IntegrationsState>) => integrationsStore.set({ ...integrationsStore.get(), ...p })

export async function loadIntegrations(): Promise<void> {
  const out = await attempt("Couldn't load integrations", () =>
    Promise.all([api.invoke('settings:get'), api.invoke('settings:status'), api.invoke('secret:list')]),
  )
  if (out) patch({ settings: out[0], status: out[1], secrets: out[2] ?? [], loaded: true })
}

export async function refreshSecrets(): Promise<SecretMeta[]> {
  const secrets = (await attempt("Couldn't load secrets", () => api.invoke('secret:list'))) ?? integrationsStore.get().secrets
  patch({ secrets })
  return secrets
}

/** Saves through settings:update and refreshes the status dots; undefined on failure (already toasted). */
export async function saveSettings(p: IntegrationSettingsPatch): Promise<IntegrationSettings | undefined> {
  const settings = await attempt("Couldn't save settings", () => api.invoke('settings:update', p))
  if (!settings) return undefined
  patch({ settings })
  const status = await attempt("Couldn't load integration status", () => api.invoke('settings:status'))
  if (status) patch({ status })
  return settings
}

/** Creates a vault secret; the value goes to main and is dropped here. */
export async function createSecret(kind: SecretKind, name: string, value: string): Promise<SecretMeta | undefined> {
  const meta = await attempt("Couldn't save the secret", () => api.invoke('secret:create', { vaultId: DEFAULT_VAULT_ID, name, kind, value }))
  if (meta) await refreshSecrets()
  return meta
}

export function resetIntegrations(): void {
  integrationsStore.set(EMPTY)
}
