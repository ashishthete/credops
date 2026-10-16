import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog } from '../../src/renderer/src/ui/Dialog'
import { closeVaultSettings, openVaultSettings, VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import { mockBridge, vaultStatus } from './helpers'

afterEach(() => closeVaultSettings())

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rename vault"
        footer={<button type="button">Save</button>}
      >
        <input aria-label="Name" />
      </Dialog>
    </>
  )
}

async function openDialog() {
  const user = userEvent.setup()
  render(<Harness />)
  const opener = screen.getByRole('button', { name: 'Open' })
  await user.click(opener)
  const dialog = await screen.findByRole('dialog', { name: 'Rename vault' })
  return { user, opener, dialog }
}

describe('Dialog', () => {
  it('Tab and Shift+Tab wrap inside the dialog', async () => {
    const { user } = await openDialog()
    const name = screen.getByLabelText('Name')
    const save = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(name).toHaveFocus())
    await user.tab()
    expect(save).toHaveFocus()
    await user.tab()
    expect(name).toHaveFocus()
    await user.tab({ shift: true })
    expect(save).toHaveFocus()
  })

  it('Esc closes and focus returns to the opener', async () => {
    const { user, opener } = await openDialog()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })
})

describe('vault settings dialog', () => {
  it('Esc closes it and focus returns to the opener', async () => {
    const user = userEvent.setup()
    mockBridge({ 'vault:status': vaultStatus({ unlocked: true }) })
    render(
      <>
        <button type="button" onClick={openVaultSettings}>
          Vault settings
        </button>
        <VaultSettingsDialog />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Vault settings' })
    await user.click(opener)
    await screen.findByRole('dialog', { name: 'Vault settings' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })
})
