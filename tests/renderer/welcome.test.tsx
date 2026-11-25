import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { resetKept } from '../../src/renderer/src/ui/kept'
import type { ImportPreview } from '../../src/shared/config-file'
import { mockBridge, product } from './helpers'
import { renderShell } from './shell-helpers'

const preview: ImportPreview = {
  token: '0123456789abcdef0123456789abcdef',
  items: [{ kind: 'products', id: 'p1', name: 'Acme', action: 'add' }],
  counts: { add: 1, update: 0, unchanged: 0, skip: 0 },
  needsSecret: [],
  steps: [],
  protectedEnvironments: [],
  needsRegion: false,
  ignored: 0,
}

afterEach(() => {
  act(() => inventoryStore.set(null))
  resetKept()
})

describe('welcome screen', () => {
  it('an app with nothing set up opens on the welcome, with Import config first', async () => {
    const invoke = mockBridge({ 'config:importOpen': preview })
    const user = userEvent.setup()
    renderShell()
    expect(await screen.findByRole('heading', { name: 'Welcome to CredOps' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Products', level: 1 })).not.toBeInTheDocument()
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons.indexOf('Import config…')).toBeLessThan(buttons.indexOf('Start from scratch'))
    await user.click(screen.getByRole('button', { name: 'Import config…' }))
    expect(invoke).toHaveBeenCalledWith('config:importOpen')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('Start from scratch shows the Products page, and coming back does not ask again', async () => {
    mockBridge()
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Start from scratch' }))
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('No products yet')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: /Hosts/ }))
    await user.click(screen.getByRole('link', { name: /Products/ }))
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Welcome to CredOps' })).not.toBeInTheDocument()
  })

  it('an app that already has something opens straight on Products', async () => {
    mockBridge({ 'product:list': [product({ id: 'p1', name: 'Acme' })] })
    renderShell()
    expect(await screen.findByRole('heading', { name: 'Products', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Welcome to CredOps' })).not.toBeInTheDocument()
  })
})
