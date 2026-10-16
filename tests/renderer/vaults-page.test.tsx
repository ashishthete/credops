import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore, loadInventory } from '../../src/renderer/src/inventory/store'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import {
  DEFAULT_VAULT_ID,
  VAULT_LOCKED,
  type IdentityMeta,
  type LocalKeyCandidate,
  type SecretMeta,
  type SshKeyMeta,
  type VaultMeta,
  type VaultStatus,
} from '../../src/shared/vault'
import type { HostMeta } from '../../src/shared/inventory'
import { defaultVault, host, mockBridge, vaultStatus } from './helpers'

const PROD_ID = '7f0c6a52-3a0e-4c55-9d3f-0d5b9c1f2a10'
const TS = '2026-10-16T09:00:00.000Z'

const vaults: VaultMeta[] = [
  { ...defaultVault, counts: { secrets: 2, keys: 0, identities: 0 } },
  {
    ...defaultVault,
    id: PROD_ID,
    name: 'Prod',
    color: '#ef5b5b',
    isDefault: false,
    counts: { secrets: 7, keys: 1, identities: 0 },
  },
]

function secret(over: Partial<SecretMeta> = {}): SecretMeta {
  return { id: 's1', vaultId: DEFAULT_VAULT_ID, name: 'DATABASE_URL', kind: 'env', createdAt: TS, updatedAt: TS, ...over }
}

const secrets = [secret(), secret({ id: 's2', name: 'STRIPE_KEY' })]

function sshKey(over: Partial<SshKeyMeta> = {}): SshKeyMeta {
  return {
    id: 'k1',
    vaultId: DEFAULT_VAULT_ID,
    label: 'deploy',
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake',
    fingerprint: 'SHA256:q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c',
    source: 'generated',
    filePath: null,
    hasPassphrase: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }
}

function identity(over: Partial<IdentityMeta> = {}): IdentityMeta {
  return {
    id: 'i1',
    vaultId: DEFAULT_VAULT_ID,
    label: 'ops',
    username: 'ubuntu',
    auth: 'agent',
    sshKeyId: null,
    hasPassword: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }
}

const unlocked = vaultStatus({ unlocked: true })

/** The page inside the real shell (the gate is already passed). */
function renderPage(path = '/vaults', results: Record<string, unknown> = {}) {
  const invoke = mockBridge({ 'vault:status': unlocked, 'vault:list': vaults, 'secret:list': secrets, ...results })
  vaultStatusStore.set(unlocked)
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Toaster />
    </MemoryRouter>,
  )
  return { invoke, ...view }
}

const rail = () => screen.getByRole('navigation', { name: 'Vaults' })
const row = (name: string) => screen.findByRole('listitem', { name })
const calls = (invoke: ReturnType<typeof mockBridge>, channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel)

/** Makes the first call on `channel` reject with `message`; later calls answer as before. */
function failOnce(invoke: ReturnType<typeof mockBridge>, channel: string, message: string) {
  const fallback = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
  let failed = false
  invoke.mockImplementation(async (c: string, ...args: unknown[]) => {
    if (c === channel && !failed) {
      failed = true
      throw new Error(message)
    }
    return fallback(c, ...args)
  })
}

beforeEach(() => {
  vaultStatusStore.set(null)
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    clearToasts()
  })
  vi.useRealTimers()
})

describe('vaults page', () => {
  it('lists vaults and masked secrets', async () => {
    const { invoke } = renderPage('/vaults', { 'secret:reveal': { value: 'hunter22' } })
    expect(await screen.findByRole('heading', { name: 'Default', level: 2 })).toBeInTheDocument()
    const def = within(rail()).getByRole('button', { name: /^Default,/ })
    const prod = within(rail()).getByRole('button', { name: /^Prod,/ })
    expect(def).toHaveAccessibleName(/2 secrets/)
    expect(prod).toHaveAccessibleName(/7 secrets/)

    for (const name of ['DATABASE_URL', 'STRIPE_KEY']) {
      const r = await row(name)
      expect(within(r).getByText(name)).toBeInTheDocument()
      expect(within(r).getByText('env')).toBeInTheDocument()
      expect(within(r).getByText('••••••••')).toBeInTheDocument()
    }
    expect(invoke).toHaveBeenCalledWith('secret:list', DEFAULT_VAULT_ID)
    // Only metadata was fetched: nothing asked for a value.
    expect(calls(invoke, 'secret:reveal')).toHaveLength(0)
    expect(calls(invoke, 'secret:copy')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('hunter22')
  })

  it('search filters the current tab', async () => {
    const user = userEvent.setup()
    renderPage()
    await row('DATABASE_URL')
    await user.type(screen.getByRole('searchbox', { name: 'Search secrets' }), 'stripe')
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'DATABASE_URL' })).not.toBeInTheDocument())
    expect(screen.getByRole('listitem', { name: 'STRIPE_KEY' })).toBeInTheDocument()
  })

  it('reveal shows then hides', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { invoke } = renderPage('/vaults', { 'secret:reveal': { value: 'hunter22' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const r = screen.getByRole('listitem', { name: 'DATABASE_URL' })
    expect(document.body.textContent).not.toContain('hunter22')
    fireEvent.click(within(r).getByRole('button', { name: 'Reveal' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(invoke).toHaveBeenCalledWith('secret:reveal', 's1')
    expect(within(r).getByText('hunter22')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.queryByText('hunter22')).not.toBeInTheDocument()
    expect(within(r).getByText('••••••••')).toBeInTheDocument()
  })

  it('copy toasts', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults', { 'secret:copy': { clearsInMs: 30_000 } })
    await user.click(within(await row('STRIPE_KEY')).getByRole('button', { name: 'Copy' }))
    expect(invoke).toHaveBeenCalledWith('secret:copy', 's2')
    expect(await screen.findByText('Copied · clears in 30 s')).toBeInTheDocument()
  })

  it('creates a secret with mod+n', async () => {
    const user = userEvent.setup()
    const created = secret({ id: 's3', name: 'API_TOKEN', kind: 'token' })
    const { invoke } = renderPage('/vaults?tab=secrets', { 'secret:create': created })
    await row('DATABASE_URL')
    act(() => {
      fireEvent.keyDown(window, { key: 'n', metaKey: true })
    })
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    await user.type(within(dialog).getByLabelText('Name'), 'API_TOKEN')
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'token')
    await user.type(within(dialog).getByLabelText('Value'), 'abc12345')
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }))
    expect(invoke).toHaveBeenCalledWith('secret:create', {
      vaultId: DEFAULT_VAULT_ID,
      name: 'API_TOKEN',
      kind: 'token',
      value: 'abc12345',
    })
    const r = await row('API_TOKEN')
    expect(within(r).getByText('token')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.body.textContent).not.toContain('abc12345')
  })

  it('keeps the newlines of a multi-line value, masked until shown', async () => {
    const user = userEvent.setup()
    const pem = '-----BEGIN CERT-----\nA=1\nB=2\n  indented\n-----END CERT-----\n'
    const { invoke } = renderPage('/vaults?tab=secrets', { 'secret:create': secret({ id: 's3', name: 'CERT' }) })
    await row('DATABASE_URL')
    act(() => {
      fireEvent.keyDown(window, { key: 'n', metaKey: true })
    })
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    await user.type(within(dialog).getByLabelText('Name'), 'CERT')
    const value = within(dialog).getByLabelText('Value')
    expect(value.tagName).toBe('TEXTAREA')
    expect(value).toHaveAttribute('autocomplete', 'off')
    expect(value).toHaveAttribute('spellcheck', 'false')
    expect(value).toHaveAttribute('data-masked')
    fireEvent.change(value, { target: { value: pem } })
    await user.click(within(dialog).getByRole('button', { name: 'Show password' }))
    expect(value).not.toHaveAttribute('data-masked')
    expect(within(dialog).getByRole('button', { name: 'Hide password' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }))
    expect(invoke).toHaveBeenCalledWith('secret:create', {
      vaultId: DEFAULT_VAULT_ID,
      name: 'CERT',
      kind: 'password',
      value: pem,
    })
  })

  it('a failed save keeps the value for a retry', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults?tab=secrets', { 'secret:create': secret({ id: 's3', name: 'API_TOKEN' }) })
    await row('DATABASE_URL')
    failOnce(invoke, 'secret:create', 'disk full')
    act(() => {
      fireEvent.keyDown(window, { key: 'n', metaKey: true })
    })
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    await user.type(within(dialog).getByLabelText('Name'), 'API_TOKEN')
    await user.type(within(dialog).getByLabelText('Value'), 'abc12345')
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }))
    await waitFor(() => expect(calls(invoke, 'secret:create')).toHaveLength(1))
    expect(within(dialog).getByLabelText('Value')).toHaveValue('abc12345')
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }))
    await waitFor(() => expect(calls(invoke, 'secret:create')).toHaveLength(2))
    expect(calls(invoke, 'secret:create').map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ value: 'abc12345' }),
      expect.objectContaining({ value: 'abc12345' }),
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('reveals a multi-line value with its line breaks', async () => {
    const user = userEvent.setup()
    renderPage('/vaults', { 'secret:reveal': { value: 'A=1\nB=2' } })
    const r = await row('DATABASE_URL')
    await user.click(within(r).getByRole('button', { name: 'Reveal' }))
    const code = await within(r).findByText((_, el) => el?.tagName === 'CODE' && el.textContent === 'A=1\nB=2')
    expect(code).toHaveClass('whitespace-pre-wrap')
    expect(code).not.toHaveClass('truncate')
  })

  it('generates a key', async () => {
    const user = userEvent.setup()
    const generated = sshKey()
    const { invoke } = renderPage(`/vaults?vault=${DEFAULT_VAULT_ID}&tab=keys`, { 'key:generate': generated })
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Generate key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Generate SSH key' })
    await user.type(within(dialog).getByLabelText('Label'), 'deploy')
    await user.click(within(dialog).getByRole('button', { name: 'Generate key' }))
    expect(invoke).toHaveBeenCalledWith('key:generate', { vaultId: DEFAULT_VAULT_ID, label: 'deploy' })

    const r = await row('deploy')
    expect(within(r).getByText('ssh-ed25519')).toBeInTheDocument()
    expect(within(r).getByText(generated.fingerprint)).toBeInTheDocument()
    expect(within(r).getByText('generated')).toBeInTheDocument()
    await user.click(within(r).getByRole('button', { name: 'Copy public key' }))
    expect(invoke).toHaveBeenCalledWith('key:copyPublic', 'k1')
    expect(await screen.findByText('Public key copied')).toBeInTheDocument()
  })

  it('links from ~/.ssh', async () => {
    const user = userEvent.setup()
    const candidates: LocalKeyCandidate[] = [
      { path: '/Users/t/.ssh/id_ed25519', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaa', encrypted: false, alreadyLinked: true },
      { path: '/Users/t/.ssh/id_rsa_work', keyType: 'ssh-rsa', fingerprint: 'SHA256:bbb', encrypted: true, alreadyLinked: false },
    ]
    const linked = sshKey({ id: 'k2', label: 'id_rsa_work', keyType: 'ssh-rsa', source: 'file', hasPassphrase: true })
    const { invoke } = renderPage('/vaults?tab=keys', { 'key:scanLocal': candidates, 'key:link': linked })
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Link from ~/.ssh' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link from ~/.ssh' })

    const already = await within(dialog).findByRole('radio', { name: /id_ed25519/ })
    expect(already).toBeDisabled()
    expect(already).toHaveAccessibleName(/Linked/)
    const other = within(dialog).getByRole('radio', { name: /id_rsa_work/ })
    expect(other).toBeEnabled()
    expect(within(other).getByText('Encrypted')).toBeInTheDocument()
    expect(within(already).queryByText('Encrypted')).not.toBeInTheDocument()

    const link = within(dialog).getByRole('button', { name: 'Link key' })
    expect(link).toBeDisabled()
    await user.click(other)
    // Encrypted, so its passphrase is required before linking.
    expect(within(dialog).getByLabelText('Label')).toHaveValue('id_rsa_work')
    expect(link).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Passphrase'), 'open sesame')
    await user.click(link)
    expect(invoke).toHaveBeenCalledWith('key:link', {
      vaultId: DEFAULT_VAULT_ID,
      label: 'id_rsa_work',
      path: '/Users/t/.ssh/id_rsa_work',
      passphrase: 'open sesame',
    })
    expect(await row('id_rsa_work')).toBeInTheDocument()
  })

  it('links an unencrypted key without asking for a passphrase', async () => {
    const user = userEvent.setup()
    const candidates: LocalKeyCandidate[] = [
      { path: '/Users/t/.ssh/id_ed25519', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaa', encrypted: false, alreadyLinked: false },
    ]
    const { invoke } = renderPage('/vaults?tab=keys', { 'key:scanLocal': candidates, 'key:link': sshKey({ source: 'file' }) })
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Link from ~/.ssh' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link from ~/.ssh' })
    await user.click(await within(dialog).findByRole('radio', { name: /id_ed25519/ }))
    expect(within(dialog).queryByLabelText('Passphrase')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Link key' }))
    expect(invoke).toHaveBeenCalledWith('key:link', {
      vaultId: DEFAULT_VAULT_ID,
      label: 'id_ed25519',
      path: '/Users/t/.ssh/id_ed25519',
    })
  })

  it('import asks for a passphrase only for an encrypted key', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults?tab=keys', { 'key:import': sshKey({ source: 'imported', label: 'pasted' }) })
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Import key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import key' })
    await user.type(within(dialog).getByLabelText('Label'), 'pasted')
    const text = within(dialog).getByLabelText('Private key')
    fireEvent.change(text, {
      target: { value: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBfake\n-----END ENCRYPTED PRIVATE KEY-----\n' },
    })
    expect(within(dialog).getByLabelText('Passphrase')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Import key' })).toBeDisabled()

    const plain = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----\n'
    fireEvent.change(text, { target: { value: plain } })
    await waitFor(() => expect(within(dialog).queryByLabelText('Passphrase')).not.toBeInTheDocument())
    await user.click(within(dialog).getByRole('button', { name: 'Import key' }))
    expect(invoke).toHaveBeenCalledWith('key:import', { vaultId: DEFAULT_VAULT_ID, label: 'pasted', privateKey: plain })
    expect(await row('pasted')).toBeInTheDocument()
  })

  it('identity needs a key for key auth', async () => {
    const user = userEvent.setup()
    const keys = [sshKey(), sshKey({ id: 'k9', label: 'prod-only', vaultId: PROD_ID })]
    const { invoke } = renderPage('/vaults?tab=identities', {
      'key:list': keys,
      'identity:create': identity({ auth: 'key', sshKeyId: 'k1' }),
    })
    const toolbar = await screen.findByRole('toolbar', { name: 'Identity actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'New identity' }))
    const dialog = await screen.findByRole('dialog', { name: 'New identity' })
    await user.type(within(dialog).getByLabelText('Label'), 'ops')
    await user.type(within(dialog).getByLabelText('Username'), 'ubuntu')
    await user.selectOptions(within(dialog).getByLabelText('Authentication'), 'key')
    const save = within(dialog).getByRole('button', { name: 'Save identity' })
    expect(save).toBeDisabled()

    const keySelect = within(dialog).getByLabelText('SSH key')
    const options = within(keySelect)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options.some((o) => o?.includes('deploy'))).toBe(true)
    expect(options.some((o) => o?.includes('prod-only'))).toBe(false)
    await user.selectOptions(keySelect, 'k1')
    expect(save).toBeEnabled()

    await user.selectOptions(within(dialog).getByLabelText('Authentication'), 'password')
    const password = within(dialog).getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    expect(save).toBeDisabled()

    await user.selectOptions(within(dialog).getByLabelText('Authentication'), 'key')
    await user.selectOptions(within(dialog).getByLabelText('SSH key'), 'k1')
    await user.click(save)
    expect(invoke).toHaveBeenCalledWith('identity:create', {
      vaultId: DEFAULT_VAULT_ID,
      label: 'ops',
      username: 'ubuntu',
      auth: 'key',
      sshKeyId: 'k1',
    })
  })

  it('delete vault confirms by name', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage()
    await screen.findByRole('heading', { name: 'Default', level: 2 })

    await user.click(within(rail()).getByRole('button', { name: 'Default options' }))
    const defMenu = await screen.findByRole('menu', { name: 'Default options' })
    expect(within(defMenu).queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    await user.click(within(rail()).getByRole('button', { name: 'Prod options' }))
    const menu = await screen.findByRole('menu', { name: 'Prod options' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Prod?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete vault' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type Prod to confirm'), 'Pro')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type Prod to confirm'), 'd')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(invoke).toHaveBeenCalledWith('vault:delete', PROD_ID)
  })

  it('keeps the inventory current after vault and identity changes', async () => {
    const user = userEvent.setup()
    inventoryStore.set(null)
    let hosts: HostMeta[] = [host({ id: 'H', label: 'web', vaultIds: [PROD_ID] })]
    let vaultList = vaults
    let identities: IdentityMeta[] = []
    const { invoke } = renderPage('/vaults?tab=identities')
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (c: string, ...args: unknown[]) => {
      if (c === 'host:list') return hosts
      if (c === 'vault:list') return vaultList
      if (c === 'identity:list') return identities
      if (c === 'vault:delete') {
        vaultList = vaults.filter((v) => v.id !== PROD_ID)
        hosts = hosts.map((h) => ({ ...h, vaultIds: [] }))
        return null
      }
      if (c === 'identity:create') return (identities = [identity({ id: 'i-new' })])[0]
      return base(c, ...args)
    })
    await screen.findByRole('heading', { name: 'Default', level: 2 })
    await act(() => loadInventory())
    expect(inventoryStore.get()!.hosts[0].vaultIds).toEqual([PROD_ID])

    const toolbar = await screen.findByRole('toolbar', { name: 'Identity actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'New identity' }))
    const dialog = await screen.findByRole('dialog', { name: 'New identity' })
    await user.type(within(dialog).getByLabelText('Label'), 'ops')
    await user.type(within(dialog).getByLabelText('Username'), 'ubuntu')
    await user.click(within(dialog).getByRole('button', { name: 'Save identity' }))
    await waitFor(() => expect(inventoryStore.get()!.identities.map((i) => i.id)).toEqual(['i-new']))

    await user.click(within(rail()).getByRole('button', { name: 'Prod options' }))
    await user.click(within(await screen.findByRole('menu', { name: 'Prod options' })).getByRole('menuitem', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete Prod?' })
    await user.type(within(confirm).getByLabelText('Type Prod to confirm'), 'Prod')
    await user.click(within(confirm).getByRole('button', { name: 'Delete vault' }))
    await waitFor(() => expect(inventoryStore.get()!.hosts[0].vaultIds).toEqual([]))
    expect(inventoryStore.get()!.vaults.map((v) => v.id)).toEqual([DEFAULT_VAULT_ID])
  })

  it('creates a vault', async () => {
    const user = userEvent.setup()
    const created: VaultMeta = { ...vaults[1], id: 'v-new', name: 'Staging', color: '#2fbf71', counts: { secrets: 0, keys: 0, identities: 0 } }
    const { invoke } = renderPage('/vaults', { 'vault:create': created })
    await screen.findByRole('heading', { name: 'Default', level: 2 })
    await user.click(within(rail()).getByRole('button', { name: 'New vault' }))
    const dialog = await screen.findByRole('dialog', { name: 'New vault' })
    await user.type(within(dialog).getByLabelText('Name'), 'Staging')
    await user.click(within(dialog).getByRole('radio', { name: 'Green' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create vault' }))
    expect(invoke).toHaveBeenCalledWith('vault:create', { name: 'Staging', color: '#2fbf71' })
    expect(await screen.findByRole('heading', { name: 'Staging', level: 2 })).toBeInTheDocument()
  })

  it('empty states', async () => {
    const user = userEvent.setup()
    renderPage('/vaults?tab=keys')
    expect(await screen.findByText('No SSH keys yet')).toBeInTheDocument()
    const panel = screen.getByRole('tabpanel')
    await user.click(within(panel).getByRole('button', { name: 'Generate key' }))
    expect(await screen.findByRole('dialog', { name: 'Generate SSH key' })).toBeInTheDocument()
  })

  it('corrupt vaults cannot be opened', async () => {
    const { invoke } = renderPage(`/vaults?vault=${PROD_ID}`, {
      'vault:status': vaultStatus({ unlocked: true, corruptVaultIds: [PROD_ID] }),
    })
    vaultStatusStore.set(vaultStatus({ unlocked: true, corruptVaultIds: [PROD_ID] }))
    expect(await screen.findByText("This vault can't be opened")).toBeInTheDocument()
    expect(within(rail()).getByRole('button', { name: /^Prod,/ })).toHaveAccessibleName(/can't be opened/)
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New secret' })).not.toBeInTheDocument()
    expect(calls(invoke, 'secret:list')).toHaveLength(0)
  })

  it('palette commands while mounted', async () => {
    const { unmount } = renderPage()
    await screen.findByRole('heading', { name: 'Default', level: 2 })
    const titles = commandStore.get().map((c) => c.title)
    for (const t of ['New secret', 'Generate SSH key', 'New identity', 'New vault']) expect(titles).toContain(t)
    unmount()
    expect(commandStore.get().map((c) => c.title)).not.toContain('New secret')
  })

  it('palette command switches tab and opens the dialog', async () => {
    renderPage()
    await row('DATABASE_URL')
    act(() => commandStore.get().find((c) => c.title === 'New identity')!.run())
    expect(await screen.findByRole('dialog', { name: 'New identity' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Identities/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('vaults page details', () => {
  it('deletes a secret, a key and an identity after confirming', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults', { 'key:list': [sshKey()], 'identity:list': [identity()] })
    const cases = [
      { tab: /Secrets/, name: 'DATABASE_URL', title: 'Delete DATABASE_URL?', button: 'Delete secret', channel: 'secret:delete', id: 's1' },
      { tab: /SSH keys/, name: 'deploy', title: 'Delete deploy?', button: 'Delete key', channel: 'key:delete', id: 'k1' },
      { tab: /Identities/, name: 'ops', title: 'Delete ops?', button: 'Delete identity', channel: 'identity:delete', id: 'i1' },
    ]
    for (const c of cases) {
      await user.click(screen.getByRole('tab', { name: c.tab }))
      const r = await row(c.name)
      await user.click(within(r).getByRole('button', { name: `${c.name} options` }))
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: c.title })
      expect(calls(invoke, c.channel)).toHaveLength(0)
      await user.click(within(dialog).getByRole('button', { name: c.button }))
      expect(invoke).toHaveBeenCalledWith(c.channel, c.id)
      await waitFor(() => expect(screen.queryByRole('listitem', { name: c.name })).not.toBeInTheDocument())
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
  })

  it('edits a secret with a minimal patch', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults', { 'secret:update': secret({ kind: 'token' }) })
    const r = await row('DATABASE_URL')
    await user.click(within(r).getByRole('button', { name: 'DATABASE_URL options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit secret' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('DATABASE_URL')
    expect(within(dialog).getByLabelText('Value')).toHaveValue('')
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'token')
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }))
    expect(invoke).toHaveBeenCalledWith('secret:update', 's1', { kind: 'token' })
    expect(await within(await row('DATABASE_URL')).findByText('token')).toBeInTheDocument()
  })

  it('edits an identity with a minimal patch', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults?tab=identities', {
      'identity:list': [identity()],
      'identity:update': identity({ username: 'root' }),
    })
    const r = await row('ops')
    await user.click(within(r).getByRole('button', { name: 'ops options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit identity' })
    const username = within(dialog).getByLabelText('Username')
    await user.clear(username)
    await user.type(username, 'root')
    await user.click(within(dialog).getByRole('button', { name: 'Save identity' }))
    expect(invoke).toHaveBeenCalledWith('identity:update', 'i1', { username: 'root' })
  })

  it('pasted import asks for the passphrase inline when main needs one', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults?tab=keys', { 'key:import': sshKey({ source: 'imported', label: 'pasted' }) })
    failOnce(invoke, 'key:import', 'passphrase required')
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Import key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import key' })
    await user.type(within(dialog).getByLabelText('Label'), 'pasted')
    // An unrecognised shape: the client can't tell it is encrypted.
    const key = '-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----\n'
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: key } })
    expect(within(dialog).queryByLabelText('Passphrase')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Import key' }))

    const pass = await within(dialog).findByLabelText('Passphrase')
    expect(screen.queryByText("Couldn't import the key")).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Import key' })).toBeDisabled()
    await user.type(pass, 'open sesame')
    await user.click(within(dialog).getByRole('button', { name: 'Import key' }))
    // Saving also re-reads the inventory, so check the last import call rather than the last call.
    expect(calls(invoke, 'key:import').at(-1)).toEqual([
      'key:import',
      { vaultId: DEFAULT_VAULT_ID, label: 'pasted', privateKey: key, passphrase: 'open sesame' },
    ])
    expect(await row('pasted')).toBeInTheDocument()
  })

  it('file import asks for the passphrase inline when main needs one', async () => {
    const user = userEvent.setup()
    const { invoke } = renderPage('/vaults?tab=keys', { 'key:importFile': sshKey({ source: 'imported', label: 'from-file' }) })
    failOnce(invoke, 'key:importFile', 'passphrase required')
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Import key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import key' })
    await user.type(within(dialog).getByLabelText('Label'), 'from-file')
    await user.click(within(dialog).getByRole('button', { name: 'Choose file…' }))
    expect(invoke).toHaveBeenCalledWith('key:importFile', { vaultId: DEFAULT_VAULT_ID, label: 'from-file' })

    const pass = await within(dialog).findByLabelText('Passphrase')
    expect(within(dialog).getByText(/choose it again/)).toBeInTheDocument()
    await user.type(pass, 'open sesame')
    await user.click(within(dialog).getByRole('button', { name: 'Choose file…' }))
    expect(calls(invoke, 'key:importFile').at(-1)).toEqual([
      'key:importFile',
      { vaultId: DEFAULT_VAULT_ID, label: 'from-file', passphrase: 'open sesame' },
    ])
    expect(await row('from-file')).toBeInTheDocument()
  })

  it('cancelling a dialog forgets what was typed', async () => {
    const user = userEvent.setup()
    renderPage('/vaults?tab=keys')
    const toolbar = await screen.findByRole('toolbar', { name: 'SSH key actions' })
    await user.click(within(toolbar).getByRole('button', { name: 'Import key' }))
    let dialog = await screen.findByRole('dialog', { name: 'Import key' })
    const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBfake\n-----END ENCRYPTED PRIVATE KEY-----\n'
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: pem } })
    await user.type(within(dialog).getByLabelText('Passphrase'), 'open sesame')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(within(toolbar).getByRole('button', { name: 'Import key' }))
    dialog = await screen.findByRole('dialog', { name: 'Import key' })
    expect(within(dialog).getByLabelText('Private key')).toHaveValue('')
    expect(within(dialog).queryByLabelText('Passphrase')).not.toBeInTheDocument()
  })

  it('leaving the page hides revealed values', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPage('/vaults', { 'secret:reveal': { value: 'hunter22' } })
    await user.click(within(await row('DATABASE_URL')).getByRole('button', { name: 'Reveal' }))
    expect(await screen.findByText('hunter22')).toBeInTheDocument()
    unmount()
    renderPage('/vaults')
    await row('DATABASE_URL')
    expect(document.body.textContent).not.toContain('hunter22')
  })
})

describe('vaults page behind the gate', () => {
  it('locked reveal asks to unlock', async () => {
    const user = userEvent.setup()
    const state: VaultStatus = vaultStatus({ unlocked: true })
    let revealCalls = 0
    const invoke = mockBridge({ 'vault:list': vaults, 'secret:list': secrets })
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:status') return { ...state }
      if (channel === 'vault:unlock') {
        state.unlocked = true
        return { ok: true }
      }
      if (channel === 'secret:reveal') {
        if (revealCalls++ === 0) {
          // Auto-locked since the last poll.
          state.unlocked = false
          throw new Error(VAULT_LOCKED)
        }
        return { value: 'hunter22' }
      }
      return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
    })
    render(
      <MemoryRouter initialEntries={['/vaults']}>
        <AuthGate>
          <AppShell />
        </AuthGate>
        <Toaster />
      </MemoryRouter>,
    )
    await user.click(within(await row('DATABASE_URL')).getByRole('button', { name: 'Reveal' }))
    const gate = await screen.findByRole('region', { name: 'Unlock vaults' })
    await user.type(within(gate).getByLabelText('Master password'), 'correct horse{Enter}')
    expect(invoke).toHaveBeenCalledWith('vault:unlock', 'correct horse')
    await waitFor(() => expect(calls(invoke, 'secret:reveal')).toHaveLength(2))
    // The page came back on the same vault, with the value from the retried reveal.
    expect(await within(await row('DATABASE_URL')).findByText('hunter22')).toBeInTheDocument()
  })
})
