import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog, type ConfirmRequest } from '../../src/renderer/src/ui/common'
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

/** A form that is dirty once its field holds text; `closed` counts the onClose calls. */
function DirtyHarness({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  return (
    <Dialog open onClose={onClose} title="Rename vault" dirty={name !== ''} footer={<button type="button">Save</button>}>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
    </Dialog>
  )
}

describe('Dialog with unsaved input', () => {
  async function typed() {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DirtyHarness onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Rename vault' })
    await user.type(screen.getByLabelText('Name'), 'ops')
    return { user, onClose, dialog }
  }

  it('closes on Esc straight away while nothing is typed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DirtyHarness onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc asks inside the dialog; Keep editing hands focus back to the field with the text kept', async () => {
    const { user, onClose } = await typed()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Discard changes?')
    // The question takes the footer's place, so Save can't be clicked past it.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(screen.getByLabelText('Name')).toHaveValue('ops')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a second Esc keeps editing; Discard closes', async () => {
    const { user, onClose } = await typed()
    await user.keyboard('{Escape}')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a click outside asks too', async () => {
    const { onClose, dialog } = await typed()
    fireEvent.mouseDown(dialog.parentElement!.parentElement!)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Discard changes?')
  })

  it('the question goes away once the input is clean again', async () => {
    const { user, onClose } = await typed()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    await user.clear(screen.getByLabelText('Name'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
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

describe('ConfirmDialog', () => {
  it('a click under a closing confirm never reaches the page', async () => {
    const user = userEvent.setup()
    const onPage = vi.fn()
    const onClose = vi.fn()
    const request: ConfirmRequest = { title: 'Delete host', description: 'Gone for good.', confirmLabel: 'Delete', run: async () => {} }
    function Page() {
      const [req, setReq] = useState<ConfirmRequest | null>(request)
      return (
        <>
          <button type="button" onClick={onPage}>
            Disconnect
          </button>
          <ConfirmDialog
            request={req}
            onClose={() => {
              onClose()
              setReq(null)
            }}
          />
        </>
      )
    }
    render(<Page />)
    const dialog = await screen.findByRole('dialog', { name: 'Delete host' })
    const backdrop = dialog.closest<HTMLElement>('.fixed')!
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Mid-exit: the backdrop still covers the page and takes the click (a double-click on Delete).
    expect(backdrop).toBeInTheDocument()
    expect(backdrop).not.toHaveClass('pointer-events-none')
    expect(dialog).toHaveAttribute('inert')
    await user.click(backdrop)
    expect(onPage).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(backdrop).not.toBeInTheDocument())
  })
})
