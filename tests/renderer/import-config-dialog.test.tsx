import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportConfigDialog } from '../../src/renderer/src/pages/settings/ImportConfigDialog'
import { SettingsPage } from '../../src/renderer/src/pages/settings/SettingsPage'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { ImportPreview } from '../../src/shared/config-file'
import { mockBridge } from './helpers'

const TOKEN = '0123456789abcdef0123456789abcdef'

const preview: ImportPreview = {
  token: TOKEN,
  items: [
    { kind: 'hosts', id: 'h1', name: 'app1', action: 'add' },
    { kind: 'hosts', id: 'h2', name: 'bastion', action: 'update', fields: ['address', 'tags'] },
    { kind: 'environments', id: 'e1', name: 'prod', action: 'update', fields: ['color'] },
    { kind: 'environments', id: 'e2', name: 'live', action: 'update', fields: ['hosts'] },
    { kind: 'products', id: 'p1', name: 'Shop', action: 'unchanged' },
    { kind: 'identities', id: 'i1', name: 'root-login', action: 'skip', reason: 'needs a secret: password' },
  ],
  counts: { add: 1, update: 3, unchanged: 1, skip: 1 },
  needsSecret: [
    { kind: 'identities', name: 'root-login', field: 'password' },
    { kind: 'deployments', name: 'api', field: 'becomeSecret' },
  ],
  protectedEnvironments: ['prod', 'live'],
}

function renderDialog(p: ImportPreview | { errors: string[] } = preview, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <ImportConfigDialog preview={p} onClose={onClose} />
      <Toaster />
    </MemoryRouter>,
  )
  return onClose
}

afterEach(() => {
  act(() => clearToasts())
})

describe('import config dialog', () => {
  it('shows add, update, unchanged and skip with changed field names', async () => {
    mockBridge()
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'Import config' })).toBeInTheDocument()
    for (const label of ['Add 1', 'Update 3', 'Unchanged 1', 'Skip 1']) expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    expect(screen.getByText('Nothing is deleted. Objects that are not in the file stay as they are.')).toBeInTheDocument()
    expect(screen.queryByText('bastion')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^Update 3/ }))
    expect(screen.getByText('bastion')).toBeInTheDocument()
    expect(screen.getByText('address, tags')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Skip 1/ }))
    expect(screen.getByText('needs a secret: password')).toBeInTheDocument()

    const needs = screen.getByRole('region', { name: 'Needs a secret' })
    expect(within(needs).getByText('root-login')).toBeInTheDocument()
    expect(within(needs).getByText('api')).toBeInTheDocument()
  })

  it('a sensitive host env var left blank reads as host: KEY left blank', () => {
    mockBridge()
    renderDialog({
      ...preview,
      needsSecret: [{ kind: 'hosts', name: 'app1', field: 'envVars', reason: 'DB_PASSWORD left blank; set it in the host editor' }],
    })
    const needs = screen.getByRole('region', { name: 'Needs a secret' })
    expect(within(needs).getByText('app1: DB_PASSWORD left blank; set it in the host editor')).toBeInTheDocument()
  })

  it('Import stays disabled until every protected environment name is typed', async () => {
    const invoke = mockBridge({ 'config:importApply': { counts: preview.counts, needsSecret: preview.needsSecret } })
    const onClose = renderDialog()
    const go = screen.getByRole('button', { name: 'Import' })
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type prod to confirm'), 'prod')
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type live to confirm'), 'Live')
    expect(go).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Type live to confirm'))
    await userEvent.type(screen.getByLabelText('Type live to confirm'), 'live')
    expect(go).toBeEnabled()
    await userEvent.click(go)
    expect(invoke).toHaveBeenCalledWith('config:importApply', TOKEN, { typedNames: ['prod', 'live'] })
    expect(onClose).toHaveBeenCalled()
    // Applied: the token is spent, so nothing is discarded.
    expect(invoke).not.toHaveBeenCalledWith('config:importDiscard', TOKEN)
  })

  it('errors list under This file can\'t be imported', async () => {
    const invoke = mockBridge()
    const onClose = renderDialog({ errors: ['$.hosts[0].port: must be 1-65535', '$.version: must be 1'] })
    expect(screen.getByText("This file can't be imported")).toBeInTheDocument()
    expect(screen.getByText('$.hosts[0].port: must be 1-65535')).toBeInTheDocument()
    expect(screen.getByText('$.version: must be 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('config:importDiscard', expect.anything())
  })

  it('closing discards the token', async () => {
    const invoke = mockBridge()
    const onClose = renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(invoke).toHaveBeenCalledWith('config:importDiscard', TOKEN)
    expect(onClose).toHaveBeenCalled()
  })

  it('result toast counts needs-a-secret', async () => {
    mockBridge({
      'config:importApply': {
        counts: { add: 3, update: 2, unchanged: 4, skip: 1 },
        needsSecret: [
          { kind: 'identities', name: 'root-login', field: 'password' },
          { kind: 'deployments', name: 'api', field: 'becomeSecret' },
        ],
      },
    })
    renderDialog({ ...preview, protectedEnvironments: [] })
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Imported: 3 added, 2 updated; 2 need a secret')).toBeInTheDocument()
  })

  it('a clean import toasts without the secret note', async () => {
    mockBridge({ 'config:importApply': { counts: { add: 1, update: 0, unchanged: 0, skip: 0 }, needsSecret: [] } })
    renderDialog({ ...preview, needsSecret: [], protectedEnvironments: [] })
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Imported: 1 added, 0 updated')).toBeInTheDocument()
  })
})

describe('settings page import', () => {
  it('Import config… opens the preview from main', async () => {
    const invoke = mockBridge({ 'config:importOpen': preview })
    render(
      <MemoryRouter>
        <SettingsPage />
        <Toaster />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Import config…' }))
    expect(invoke).toHaveBeenCalledWith('config:importOpen')
    expect(await screen.findByRole('dialog', { name: 'Import config' })).toBeInTheDocument()
  })

  it('a cancelled open shows nothing', async () => {
    mockBridge({ 'config:importOpen': null })
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Import config…' }))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
