import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { defaultVault, mockBridge, vaultStatus } from './helpers'

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
    const { invoke } = renderPage()
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
