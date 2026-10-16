import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { mockBridge, vaultStatus } from './helpers'

// Own file: it runs framer on fake timers, which can leave framer's shared frame loop parked for
// whatever test runs next in the same module graph.

afterEach(() => {
  vi.useRealTimers()
})

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })

it('a failing status shows Retry on the splash', async () => {
  vi.useFakeTimers()
  const invoke = mockBridge()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'vault:status') throw new Error('database is locked')
    return null
  })
  render(
    <AuthGate>
      <p>app</p>
    </AuthGate>,
  )
  await flush()
  expect(screen.getByRole('region', { name: 'Opening OpsDeck' })).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2900)
  })
  // A brief failure stays a quiet splash.
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(screen.getByRole('region', { name: "Couldn't open your vaults" })).toBeInTheDocument()
  expect(screen.getByText('database is locked')).toBeInTheDocument()

  invoke.mockImplementation(async (channel: string) => (channel === 'vault:status' ? vaultStatus() : null))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await flush()
  expect(screen.getByRole('region', { name: 'Unlock vaults' })).toBeInTheDocument()
})
